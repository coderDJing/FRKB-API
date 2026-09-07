const crypto = require('crypto');
const UserCuratedLibrarySnapshot = require('../models/UserCuratedLibrarySnapshot');
const UserCuratedLibraryBlob = require('../models/UserCuratedLibraryBlob');
const blobStore = require('./curatedLibraryBlobStore');
const curatedLibraryEvents = require('./curatedLibraryEvents');
const {
  ERROR_CODES,
  FINGERPRINT_REGEX,
  USER_KEY_REGEX,
  LIMITS,
  CURATED_LIBRARY_SYNC
} = require('../config/constants');

const PROTOCOL_VERSION = CURATED_LIBRARY_SYNC.PROTOCOL_VERSION;
const ROOT_PARENT_UUID = '00000000-0000-4000-8000-000000000000';
const userMutationLocks = new Map();

async function withUserMutationLock(userKey, operation) {
  const key = String(userKey || '').trim();
  const previous = userMutationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  userMutationLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (userMutationLocks.get(key) === current) userMutationLocks.delete(key);
  }
}

const isUuid = (value) => USER_KEY_REGEX.test(String(value || '').trim());
const isSha = (value) => FINGERPRINT_REGEX.test(String(value || '').trim());
function isSafeLeafName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..') return false;
  if (/[\\/\u0000-\u001f]/.test(name) || /[<>:"|?*]/.test(name)) return false;
  if (/[ .]$/.test(name)) return false;
  const stem = name.replace(/\..*$/, '').toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

/** Number(null) === 0，空序号不能用 Number() 判断。 */
function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function toOptionalPositiveInt(value) {
  const num = toOptionalNumber(value);
  if (num === null) return null;
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : null;
}

function sanitizeNode(raw) {
  const uuid = String(raw?.uuid || '').trim().toLowerCase();
  const parentUuid = String(raw?.parentUuid || '').trim().toLowerCase();
  const name = String(raw?.name || '').trim();
  const nodeType = raw?.nodeType === 'songList' ? 'songList' : raw?.nodeType === 'dir' ? 'dir' : '';
  if (
    !isUuid(uuid) ||
    uuid === ROOT_PARENT_UUID ||
    !isUuid(parentUuid) ||
    !isSafeLeafName(name) ||
    !nodeType
  ) return null;
  const revision = Number(raw.revision);
  const updatedAtMs = toOptionalPositiveInt(raw.updatedAtMs);
  return {
    uuid,
    parentUuid,
    name: name.slice(0, 255),
    nodeType,
    sortOrder: toOptionalNumber(raw.sortOrder),
    updatedAtMs: updatedAtMs || Date.now(),
    revision: Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : undefined
  };
}

function sanitizeFile(raw) {
  const fileId = String(raw?.fileId || '').trim().toLowerCase();
  const parentUuid = String(raw?.parentUuid || '').trim().toLowerCase();
  const fileName = String(raw?.fileName || '').trim();
  const sha256 = String(raw?.sha256 || '').trim().toLowerCase();
  const size = Number(raw?.size);
  if (
    !isUuid(fileId) ||
    !isUuid(parentUuid) ||
    !isSafeLeafName(fileName) ||
    !isSha(sha256) ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    return null;
  }
  const revision = Number(raw.revision);
  const updatedAtMs = toOptionalPositiveInt(raw.updatedAtMs);
  return {
    fileId,
    parentUuid,
    fileName: fileName.slice(0, 255),
    sha256,
    size,
    trackNumber: toOptionalPositiveInt(raw.trackNumber),
    addedAtMs: toOptionalPositiveInt(raw.addedAtMs),
    updatedAtMs: updatedAtMs || Date.now(),
    revision: Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : undefined
  };
}

function toPublicSnapshot(doc, extra = {}) {
  return {
    protocolVersion: doc.protocolVersion || PROTOCOL_VERSION,
    revision: doc.revision || 0,
    snapshotReady: doc.snapshotReady === true,
    full: extra.full !== false,
    nodes: extra.nodes || doc.nodes || [],
    files: extra.files || doc.files || [],
    tombstones: extra.tombstones || doc.tombstones || []
  };
}

function stampRevision(entities, revision) {
  const next = Number(revision) || 0;
  for (const node of entities.nodes || []) {
    node.revision = next;
  }
  for (const file of entities.files || []) {
    file.revision = next;
  }
}

function entityHasRevision(item) {
  return Number(item?.revision) > 0;
}

class CuratedLibrarySyncError extends Error {
  constructor(error, message, status = 400) {
    super(message);
    this.error = error;
    this.status = status;
  }
}

function normalizeEntityList(raw, sanitizer, label) {
  if (!Array.isArray(raw)) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      `${label}必须是数组`
    );
  }
  return raw.map((item) => {
    const normalized = sanitizer(item);
    if (!normalized) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
        `${label}包含无效实体`
      );
    }
    return normalized;
  });
}

function normalizeLegacyRootParents(nodes, files) {
  const nodeIds = new Set(nodes.map((node) => node.uuid));
  const unknownParents = new Set();
  for (const item of [...nodes, ...files]) {
    if (item.parentUuid !== ROOT_PARENT_UUID && !nodeIds.has(item.parentUuid)) {
      unknownParents.add(item.parentUuid);
    }
  }
  if (unknownParents.size > 1) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      '存在多个未知根父级'
    );
  }
  const legacyRoot = [...unknownParents][0];
  if (!legacyRoot) return;
  for (const item of [...nodes, ...files]) {
    if (item.parentUuid === legacyRoot) item.parentUuid = ROOT_PARENT_UUID;
  }
}

function normalizeTombstones(raw) {
  if (!Array.isArray(raw)) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      'tombstones必须是数组'
    );
  }
  return raw.map((item) => {
    const kind = item?.kind === 'file' || item?.kind === 'node' ? item.kind : '';
    const id = String(item?.id || '').trim().toLowerCase();
    const revision = Number(item?.revision);
    const deletedAtMs = Number(item?.deletedAtMs);
    if (
      !kind ||
      !isUuid(id) ||
      (kind === 'node' && id === ROOT_PARENT_UUID) ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      !Number.isSafeInteger(deletedAtMs) ||
      deletedAtMs <= 0
    ) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
        'tombstones包含无效实体'
      );
    }
    return { kind, id, revision, deletedAtMs };
  });
}

function validateEntityTopology(nodes, files) {
  const nodeIds = new Set();
  const nodeById = new Map();
  for (const node of nodes) {
    if (nodeIds.has(node.uuid)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '节点 ID 重复');
    }
    nodeIds.add(node.uuid);
    nodeById.set(node.uuid, node);
  }
  for (const node of nodes) {
    const seen = new Set([node.uuid]);
    let parentUuid = node.parentUuid;
    while (parentUuid !== ROOT_PARENT_UUID) {
      if (seen.has(parentUuid)) {
        throw new CuratedLibrarySyncError(
          ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
          '节点层级存在循环'
        );
      }
      seen.add(parentUuid);
      const parent = nodeById.get(parentUuid);
      if (!parent) break;
      parentUuid = parent.parentUuid;
    }
  }
  for (const node of nodes) {
    if (node.parentUuid !== ROOT_PARENT_UUID && !nodeIds.has(node.parentUuid)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '节点父级不存在');
    }
  }
  const fileIds = new Set();
  const occupiedNames = new Set();
  for (const node of nodes) {
    const key = `${node.parentUuid}\u0000${node.name.toLocaleLowerCase('en-US')}`;
    if (occupiedNames.has(key)) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
        '同一父级存在重名节点或文件'
      );
    }
    occupiedNames.add(key);
  }
  for (const file of files) {
    if (fileIds.has(file.fileId)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '文件 ID 重复');
    }
    fileIds.add(file.fileId);
    if (file.parentUuid !== ROOT_PARENT_UUID && !nodeIds.has(file.parentUuid)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '文件父级不存在');
    }
    const key = `${file.parentUuid}\u0000${file.fileName.toLocaleLowerCase('en-US')}`;
    if (occupiedNames.has(key)) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
        '同一父级存在重名节点或文件'
      );
    }
    occupiedNames.add(key);
  }
}

function validateOps(ops) {
  if (!Array.isArray(ops)) {
    throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, 'ops 必须是数组');
  }
  for (const op of ops) {
    const type = String(op?.type || '');
    if (type === 'upsertNode') {
      if (!sanitizeNode(op.node)) throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '节点操作无效');
    } else if (type === 'upsertFile' || type === 'undeleteFile') {
      if (!sanitizeFile(op.file)) throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '文件操作无效');
    } else if (type === 'deleteNode') {
      if (!isUuid(op.uuid)) throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '删除节点 ID 无效');
    } else if (type === 'deleteFile') {
      if (!isUuid(op.fileId)) throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '删除文件 ID 无效');
    } else {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '存在不支持的同步操作');
    }
  }
}

async function assertSnapshotBlobsReady(userKey, files) {
  for (const file of files || []) {
    const ref = await UserCuratedLibraryBlob.findOne({
      userKey,
      sha256: file.sha256,
      ready: true
    }).lean();
    if (!ref || !(await blobStore.verifyBlob(file.sha256))) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.CURATED_LIBRARY_BLOB_NOT_FOUND,
        `文件 Blob 不存在: ${file.fileId}`,
        409
      );
    }
    const stat = await blobStore.statBlob(file.sha256);
    if (Number(stat.size) !== Number(file.size)) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.CURATED_LIBRARY_BLOB_HASH_MISMATCH,
        `文件 Blob 大小不匹配: ${file.fileId}`,
        409
      );
    }
  }
}

async function sumReadyBlobBytes(userKey) {
  const rows = await UserCuratedLibraryBlob.find({ userKey, ready: true }).select('size').lean();
  return rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
}

async function sumReservedBlobBytes(userKey) {
  const rows = await UserCuratedLibraryBlob.find({ userKey }).select('sha256 size').lean();
  const sizes = new Map();
  for (const row of rows) sizes.set(String(row.sha256), Number(row.size) || 0);
  return [...sizes.values()].reduce((sum, size) => sum + size, 0);
}

async function upsertBlobRef(userKey, sha256, size, ready) {
  await UserCuratedLibraryBlob.findOneAndUpdate(
    { userKey, sha256 },
    { $set: { size, ready: !!ready } },
    { upsert: true, new: true }
  );
}

async function refreshBlobRefs(userKey, files) {
  const needed = new Map();
  for (const file of files || []) {
    needed.set(file.sha256, file.size);
  }
  const existing = await UserCuratedLibraryBlob.find({ userKey });
  const keep = new Set(needed.keys());
  for (const row of existing) {
    if (!keep.has(row.sha256)) {
      await UserCuratedLibraryBlob.deleteOne({ _id: row._id });
      const still = await UserCuratedLibraryBlob.exists({ sha256: row.sha256, ready: true });
      await blobStore.unlinkBlobIfOrphan(row.sha256, !!still);
    }
  }
  for (const [sha256, size] of needed) {
    const ready = await blobStore.blobExists(sha256);
    await upsertBlobRef(userKey, sha256, size, ready);
  }
}

function applyOp(snapshot, op, nextRevision) {
  const type = String(op?.type || '');
  const now = Date.now();
  if (type === 'upsertNode') {
    const node = sanitizeNode(op.node);
    if (!node) return;
    const tombstoned = snapshot.tombstones.some(
      (item) => item.kind === 'node' && item.id === node.uuid
    );
    if (tombstoned) return;
    // 同一 userKey 跨时区：客户端 updatedAtMs 是 Unix 毫秒，时区不影响。
    // 但设备时钟不准时，不能拿客户端时间否决已经抢到的 revision。
    node.revision = nextRevision;
    node.updatedAtMs = now;
    const index = snapshot.nodes.findIndex((item) => item.uuid === node.uuid);
    if (index < 0) snapshot.nodes.push(node);
    else snapshot.nodes[index] = node;
    return;
  }
  if (type === 'deleteNode') {
    const uuid = String(op.uuid || '').trim().toLowerCase();
    if (!isUuid(uuid)) return;
    snapshot.nodes = snapshot.nodes.filter((item) => item.uuid !== uuid);
    snapshot.tombstones = snapshot.tombstones.filter(
      (item) => !(item.kind === 'node' && item.id === uuid)
    );
    snapshot.tombstones.push({
      kind: 'node',
      id: uuid,
      revision: nextRevision,
      deletedAtMs: now
    });
    return;
  }
  if (type === 'upsertFile' || type === 'undeleteFile') {
    const file = sanitizeFile(op.file);
    if (!file) return;
    const tombstoned = snapshot.tombstones.some(
      (item) => item.kind === 'file' && item.id === file.fileId
    );
    if (type === 'upsertFile' && tombstoned) return;
    file.revision = nextRevision;
    file.updatedAtMs = now;
    snapshot.tombstones = snapshot.tombstones.filter(
      (item) => !(item.kind === 'file' && item.id === file.fileId)
    );
    const index = snapshot.files.findIndex((item) => item.fileId === file.fileId);
    if (index < 0) snapshot.files.push(file);
    else snapshot.files[index] = file;
    return;
  }
  if (type === 'deleteFile') {
    const fileId = String(op.fileId || '').trim().toLowerCase();
    if (!isUuid(fileId)) return;
    snapshot.files = snapshot.files.filter((item) => item.fileId !== fileId);
    snapshot.tombstones = snapshot.tombstones.filter(
      (item) => !(item.kind === 'file' && item.id === fileId)
    );
    snapshot.tombstones.push({
      kind: 'file',
      id: fileId,
      revision: nextRevision,
      deletedAtMs: now
    });
  }
}

async function getStatus(userKey) {
  const snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
  const blobBytes = await sumReadyBlobBytes(userKey);
  const lockUntil = snapshot.firstSnapshotLockUntil ? new Date(snapshot.firstSnapshotLockUntil) : null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: snapshot.revision || 0,
    snapshotReady: snapshot.snapshotReady === true,
    fileCount: (snapshot.files || []).length,
    blobBytes,
    quotaBytes: LIMITS.DEFAULT_MAX_CURATED_BLOB_BYTES_PER_USER,
    firstSnapshotLocked: !!(lockUntil && lockUntil.getTime() > Date.now() && !snapshot.snapshotReady)
  };
}

async function beginFirstSnapshot(userKey) {
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const lockUntil = new Date(Date.now() + CURATED_LIBRARY_SYNC.FIRST_SNAPSHOT_LOCK_MS);
  const snapshot = await UserCuratedLibrarySnapshot.findOneAndUpdate(
    {
      userKey,
      snapshotReady: false,
      $or: [
        { firstSnapshotLockUntil: null },
        { firstSnapshotLockUntil: { $exists: false } },
        { firstSnapshotLockUntil: { $lte: now } }
      ]
    },
    {
      $set: {
        protocolVersion: PROTOCOL_VERSION,
        firstSnapshotSessionId: sessionId,
        firstSnapshotLockUntil: lockUntil
      },
      $setOnInsert: { revision: 0, nodes: [], files: [], tombstones: [] }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).catch(async (error) => {
    if (error?.code === 11000) return UserCuratedLibrarySnapshot.findOne({ userKey });
    throw error;
  });
  if (!snapshot?.snapshotReady && snapshot?.firstSnapshotSessionId === sessionId) {
    return { sessionId };
  }
  if (snapshot?.snapshotReady) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_EXISTS,
      '云端精选库已有快照',
      409
    );
  }
  throw new CuratedLibrarySyncError(
    ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_LOCKED,
    '另一台设备正在提交首次快照，请等待',
    409
  );
}

function assertWritableProtocol(payload) {
  const version = Number(payload?.protocolVersion);
  if (!Number.isFinite(version) || version !== PROTOCOL_VERSION) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_PROTOCOL_UNSUPPORTED,
      '客户端精选库同步协议版本不受支持，拒绝写入',
      400
    );
  }
}

async function commitSnapshot(userKey, payload) {
  assertWritableProtocol(payload);
  let snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
  const nodes = normalizeEntityList(payload.nodes, sanitizeNode, 'nodes');
  const files = normalizeEntityList(payload.files, sanitizeFile, 'files');
  normalizeLegacyRootParents(nodes, files);
  validateEntityTopology(nodes, files);
  await assertSnapshotBlobsReady(userKey, files);
  if (payload.replaceExisting === true && snapshot.snapshotReady) {
    const nextRevision = (snapshot.revision || 0) + 1
    stampRevision({ nodes, files }, nextRevision)
    const newFileIds = new Set(files.map((item) => item.fileId))
    const newNodeIds = new Set(nodes.map((item) => item.uuid))
    const tombstones = []
    const deletedAtMs = Date.now()
    for (const file of snapshot.files || []) {
      if (!newFileIds.has(file.fileId)) {
        tombstones.push({ kind: 'file', id: file.fileId, revision: nextRevision, deletedAtMs })
      }
    }
    for (const node of snapshot.nodes || []) {
      if (!newNodeIds.has(node.uuid)) {
        tombstones.push({ kind: 'node', id: node.uuid, revision: nextRevision, deletedAtMs })
      }
    }
    const saved = await UserCuratedLibrarySnapshot.findOneAndUpdate(
      { userKey, snapshotReady: true, revision: snapshot.revision },
      {
        $set: {
          nodes,
          files,
          tombstones,
          revision: nextRevision,
          snapshotReady: true,
          firstSnapshotSessionId: null,
          firstSnapshotLockUntil: null,
          lastSyncAt: new Date(),
          lastUpdateAt: new Date()
        }
      },
      { new: true }
    )
    if (!saved) {
      const latest = await UserCuratedLibrarySnapshot.getOrCreate(userKey)
      const conflict = new CuratedLibrarySyncError(
        ERROR_CODES.CURATED_LIBRARY_REVISION_CONFLICT,
        'revision 冲突，请先拉取',
        409
      )
      conflict.snapshot = toPublicSnapshot(latest)
      throw conflict
    }
    await refreshBlobRefs(userKey, files)
    curatedLibraryEvents.notifyCuratedLibraryRevision(userKey, {
      revision: saved.revision,
      snapshotReady: true
    })
    return toPublicSnapshot(saved)
  }
  if (snapshot.snapshotReady) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_EXISTS,
      '云端精选库已有快照',
      409
    );
  }
  if (!payload.sessionId || payload.sessionId !== snapshot.firstSnapshotSessionId) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_LOCKED,
      '首次快照会话无效或已过期',
      409
    );
  }
  stampRevision({ nodes, files }, 1);
  snapshot.nodes = nodes;
  snapshot.files = files;
  snapshot.tombstones = [];
  snapshot.revision = 1;
  snapshot.snapshotReady = true;
  snapshot.firstSnapshotSessionId = null;
  snapshot.firstSnapshotLockUntil = null;
  snapshot.lastSyncAt = new Date();
  snapshot.lastUpdateAt = new Date();
  const saved = await UserCuratedLibrarySnapshot.findOneAndUpdate(
    { userKey, snapshotReady: false, firstSnapshotSessionId: payload.sessionId, revision: 0 },
    {
      $set: {
        nodes,
        files,
        tombstones: [],
        revision: 1,
        snapshotReady: true,
        firstSnapshotSessionId: null,
        firstSnapshotLockUntil: null,
        lastSyncAt: new Date(),
        lastUpdateAt: new Date()
      }
    },
    { new: true }
  );
  if (!saved) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_LOCKED,
      '首次快照会话无效或已过期',
      409
    );
  }
  snapshot = saved;
  await refreshBlobRefs(userKey, files);
  curatedLibraryEvents.notifyCuratedLibraryRevision(userKey, {
    revision: snapshot.revision,
    snapshotReady: true
  });
  return toPublicSnapshot(snapshot);
}

async function pullSnapshot(userKey, sinceRevision) {
  const snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
  const current = Number(snapshot.revision) || 0;
  const since = Number(sinceRevision);
  const nodes = snapshot.nodes || [];
  const files = snapshot.files || [];
  const tombstones = snapshot.tombstones || [];
  const canDiff =
    snapshot.snapshotReady === true &&
    Number.isSafeInteger(since) &&
    since > 0 &&
    since <= current &&
    nodes.every(entityHasRevision) &&
    files.every(entityHasRevision);
  if (!canDiff) {
    return toPublicSnapshot(snapshot, { full: true });
  }
  if (since === current) {
    return toPublicSnapshot(snapshot, {
      full: false,
      nodes: [],
      files: [],
      tombstones: []
    });
  }
  return toPublicSnapshot(snapshot, {
    full: false,
    nodes: nodes.filter((item) => Number(item.revision) > since),
    files: files.filter((item) => Number(item.revision) > since),
    tombstones: tombstones.filter((item) => Number(item.revision) > since)
  });
}

async function pushOps(userKey, payload) {
  assertWritableProtocol(payload);
  let snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
  if (!snapshot.snapshotReady) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      '云端尚无精选库快照',
      409
    );
  }
  const baseRevision = Number(payload.baseRevision);
  if (baseRevision !== snapshot.revision) {
    const error = new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_REVISION_CONFLICT,
      'revision 冲突，请先拉取',
      409
    );
    error.snapshot = toPublicSnapshot(snapshot);
    throw error;
  }
  const ops = payload.ops;
  validateOps(ops);
  if (ops.length === 0) return toPublicSnapshot(snapshot);
  const nextRevision = (snapshot.revision || 0) + 1;
  const next = {
    nodes: normalizeEntityList(snapshot.nodes || [], sanitizeNode, 'stored nodes'),
    files: normalizeEntityList(snapshot.files || [], sanitizeFile, 'stored files'),
    tombstones: normalizeTombstones(snapshot.tombstones),
    revision: snapshot.revision
  };
  normalizeLegacyRootParents(next.nodes, next.files);
  for (const op of ops) applyOp(next, op, nextRevision);
  validateEntityTopology(next.nodes, next.files);
  await assertSnapshotBlobsReady(userKey, next.files);
  const saved = await UserCuratedLibrarySnapshot.findOneAndUpdate(
    { userKey, snapshotReady: true, revision: snapshot.revision },
    {
      $set: {
        nodes: next.nodes,
        files: next.files,
        tombstones: next.tombstones,
        revision: nextRevision,
        lastSyncAt: new Date(),
        lastUpdateAt: new Date()
      }
    },
    { new: true }
  );
  if (!saved) {
    const latest = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
    const conflict = new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_REVISION_CONFLICT,
      'revision 冲突，请先拉取',
      409
    );
    conflict.snapshot = toPublicSnapshot(latest);
    throw conflict;
  }
  snapshot = saved;
  await refreshBlobRefs(userKey, snapshot.files);
  curatedLibraryEvents.notifyCuratedLibraryRevision(userKey, {
    revision: snapshot.revision,
    snapshotReady: true
  });
  return toPublicSnapshot(snapshot);
}

async function beginBlob(userKey, sha256, size) {
  const hex = String(sha256 || '').trim().toLowerCase();
  if (!isSha(hex)) {
    throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, 'sha256 无效');
  }
  const numericSize = Number(size);
  if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
    throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, 'size 无效');
  }
  if (numericSize === 0) {
    await blobStore.ensureEmptyBlob(hex);
    await upsertBlobRef(userKey, hex, 0, true);
    return { needed: false, uploadedBytes: 0, chunkSize: CURATED_LIBRARY_SYNC.CHUNK_SIZE_BYTES };
  }
  const chunkSize = CURATED_LIBRARY_SYNC.CHUNK_SIZE_BYTES;
  const existingRef = await UserCuratedLibraryBlob.findOne({ userKey, sha256: hex }).lean();
  const used = await sumReservedBlobBytes(userKey);
  const previousReserved = Number(existingRef?.size) || 0;
  if (used - previousReserved + numericSize > LIMITS.DEFAULT_MAX_CURATED_BLOB_BYTES_PER_USER) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_QUOTA_EXCEEDED,
      '精选库云端容量超出配额',
      400
    );
  }
  let uploadedBytes = await blobStore.getUploadedBytes(hex);
  if (uploadedBytes > numericSize) {
    await blobStore.unlinkBlobIfOrphan(hex, false);
    uploadedBytes = 0;
  } else if (uploadedBytes === numericSize && !(await blobStore.blobExists(hex))) {
    try {
      await blobStore.promotePartFile(hex, numericSize);
      await upsertBlobRef(userKey, hex, numericSize, true);
      return { needed: false, uploadedBytes: numericSize, chunkSize };
    } catch (error) {
      if (error?.code === 'HASH_MISMATCH') {
        await blobStore.unlinkBlobIfOrphan(hex, false);
        uploadedBytes = 0;
      } else if (error?.code === 'ENOENT') {
        uploadedBytes = await blobStore.getUploadedBytes(hex);
      } else {
        throw error;
      }
    }
  }
  if (await blobStore.blobExists(hex)) {
    const stat = await blobStore.statBlob(hex);
    if (Number(stat.size) !== numericSize) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.CURATED_LIBRARY_BLOB_HASH_MISMATCH,
        '已存在的 Blob 大小不匹配',
        409
      );
    }
    if (!(await blobStore.verifyBlob(hex))) {
      await blobStore.unlinkBlobIfOrphan(hex, false);
      uploadedBytes = 0;
    } else {
      await upsertBlobRef(userKey, hex, numericSize, true);
      return { needed: false, uploadedBytes, chunkSize };
    }
  }
  await upsertBlobRef(userKey, hex, numericSize, false);
  return { needed: true, uploadedBytes, chunkSize };
}

async function appendBlobChunk(userKey, sha256, size, start, readable) {
  const hex = String(sha256 || '').trim().toLowerCase();
  if (!isSha(hex)) {
    throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, 'sha256 无效');
  }
  const numericSize = Number(size);
  const numericStart = Number(start);
  const ref = await UserCuratedLibraryBlob.findOne({ userKey, sha256: hex }).lean();
  if (
    !ref ||
    !Number.isSafeInteger(numericSize) ||
    numericSize <= 0 ||
    !Number.isSafeInteger(numericStart) ||
    numericStart < 0 ||
    Number(ref.size) !== numericSize
  ) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      'Blob 上传会话不存在或大小不匹配',
      409
    );
  }
  try {
    const result = await blobStore.appendBlobChunk(hex, numericSize, numericStart, readable);
    if (result.ready) {
      await upsertBlobRef(userKey, hex, result.uploadedBytes, true);
    }
    return result;
  } catch (error) {
    if (error?.code === 'OFFSET_MISMATCH') {
      const wrapped = new CuratedLibrarySyncError(
        ERROR_CODES.CURATED_LIBRARY_BLOB_OFFSET_MISMATCH,
        '上传偏移不匹配，请从已上传字节续传',
        409
      );
      wrapped.uploadedBytes = Number(error.uploadedBytes) || 0;
      throw wrapped;
    }
    throw error;
  }
}

async function completeBlob(userKey, sha256, size, readable) {
  const hex = String(sha256 || '').trim().toLowerCase();
  const numericSize = Number(size);
  if (!isSha(hex) || !Number.isSafeInteger(numericSize) || numericSize < 0) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      'Blob 参数无效'
    );
  }
  const ref = await UserCuratedLibraryBlob.findOne({ userKey, sha256: hex }).lean();
  if (!ref || Number(ref.size) !== numericSize) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT,
      'Blob 上传会话不存在或大小不匹配',
      409
    );
  }
  const result = await blobStore.writeBlobFromStream(hex, numericSize, readable);
  await upsertBlobRef(userKey, hex, result.size, true);
  return { ready: true, size: result.size };
}

async function assertBlobReadable(userKey, sha256) {
  const hex = String(sha256 || '').trim().toLowerCase();
  const row = await UserCuratedLibraryBlob.findOne({ userKey, sha256: hex, ready: true });
  if (!row || !(await blobStore.blobExists(hex))) {
    throw new CuratedLibrarySyncError(ERROR_CODES.CURATED_LIBRARY_BLOB_NOT_FOUND, '音频不存在', 404);
  }
  return hex;
}

async function deleteUserCuratedLibrary(userKey) {
  const blobs = await UserCuratedLibraryBlob.find({ userKey }).lean();
  await UserCuratedLibraryBlob.deleteMany({ userKey });
  for (const row of blobs) {
    const still = await UserCuratedLibraryBlob.exists({ sha256: row.sha256, ready: true });
    await blobStore.unlinkBlobIfOrphan(row.sha256, !!still);
  }
  const now = new Date();
  const empty = {
    protocolVersion: PROTOCOL_VERSION,
    revision: 0,
    snapshotReady: true,
    firstSnapshotSessionId: null,
    firstSnapshotLockUntil: null,
    nodes: [],
    files: [],
    tombstones: [],
    lastSyncAt: now,
    lastUpdateAt: now
  };
  await UserCuratedLibrarySnapshot.findOneAndUpdate(
    { userKey },
    { $set: empty },
    { upsert: true, new: true }
  );
  curatedLibraryEvents.notifyCuratedLibraryRevision(userKey, {
    revision: 0,
    snapshotReady: true
  });
  return {
    blobCount: blobs.length,
    snapshotDeleted: true,
    fileCount: 0
  };
}

module.exports = {
  CuratedLibrarySyncError,
  getStatus: (userKey) => withUserMutationLock(userKey, () => getStatus(userKey)),
  beginFirstSnapshot: (userKey) => withUserMutationLock(userKey, () => beginFirstSnapshot(userKey)),
  commitSnapshot: (userKey, payload) =>
    withUserMutationLock(userKey, () => commitSnapshot(userKey, payload)),
  pullSnapshot,
  pushOps: (userKey, payload) => withUserMutationLock(userKey, () => pushOps(userKey, payload)),
  beginBlob: (userKey, sha256, size) =>
    withUserMutationLock(userKey, () => beginBlob(userKey, sha256, size)),
  appendBlobChunk: (userKey, sha256, size, start, readable) =>
    withUserMutationLock(userKey, () => appendBlobChunk(userKey, sha256, size, start, readable)),
  completeBlob: (userKey, sha256, size, readable) =>
    withUserMutationLock(userKey, () => completeBlob(userKey, sha256, size, readable)),
  assertBlobReadable,
  deleteUserCuratedLibrary: (userKey) =>
    withUserMutationLock(userKey, () => deleteUserCuratedLibrary(userKey)),
  blobStore,
  __test: {
    normalizeLegacyRootParents,
    validateEntityTopology,
    sanitizeNode,
    sanitizeFile
  }
};
