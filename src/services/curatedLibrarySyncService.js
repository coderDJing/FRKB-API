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
  const uuid = String(raw?.uuid || '').trim();
  const parentUuid = String(raw?.parentUuid || '').trim();
  const name = String(raw?.name || '').trim();
  const nodeType = raw?.nodeType === 'songList' ? 'songList' : raw?.nodeType === 'dir' ? 'dir' : '';
  if (!isUuid(uuid) || !isUuid(parentUuid) || !isSafeLeafName(name) || !nodeType) return null;
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
  const fileId = String(raw?.fileId || '').trim();
  const parentUuid = String(raw?.parentUuid || '').trim();
  const fileName = String(raw?.fileName || '').trim();
  const sha256 = String(raw?.sha256 || '').trim().toLowerCase();
  const size = Number(raw?.size);
  if (!isUuid(fileId) || !isUuid(parentUuid) || !isSafeLeafName(fileName) || !isSha(sha256) || !Number.isFinite(size) || size < 0) {
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
  if (!Array.isArray(raw)) return [];
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

function validateEntityTopology(nodes, files) {
  const rootParent = '00000000-0000-4000-8000-000000000000';
  const nodeIds = new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.uuid)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '节点 ID 重复');
    }
    nodeIds.add(node.uuid);
  }
  for (const node of nodes) {
    if (node.parentUuid !== rootParent && !nodeIds.has(node.parentUuid)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '节点父级不存在');
    }
  }
  const fileIds = new Set();
  for (const file of files) {
    if (fileIds.has(file.fileId)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '文件 ID 重复');
    }
    fileIds.add(file.fileId);
    if (file.parentUuid !== rootParent && !nodeIds.has(file.parentUuid)) {
      throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, '文件父级不存在');
    }
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

async function assertSnapshotBlobsReady(files) {
  for (const file of files || []) {
    if (!(await blobStore.blobExists(file.sha256))) {
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
    const uuid = String(op.uuid || '').trim();
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
    const fileId = String(op.fileId || '').trim();
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
  validateEntityTopology(nodes, files);
  await assertSnapshotBlobsReady(files);
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
    Number.isFinite(since) &&
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
    nodes: [...(snapshot.nodes || [])],
    files: [...(snapshot.files || [])],
    tombstones: [...(snapshot.tombstones || [])],
    revision: snapshot.revision
  };
  for (const op of ops) applyOp(next, op, nextRevision);
  validateEntityTopology(next.nodes, next.files);
  await assertSnapshotBlobsReady(next.files);
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
  if (!Number.isFinite(numericSize) || numericSize < 0) {
    throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, 'size 无效');
  }
  if (numericSize === 0) {
    await blobStore.ensureEmptyBlob(hex);
    await upsertBlobRef(userKey, hex, 0, true);
    return { needed: false, uploadedBytes: 0, chunkSize: CURATED_LIBRARY_SYNC.CHUNK_SIZE_BYTES };
  }
  const chunkSize = CURATED_LIBRARY_SYNC.CHUNK_SIZE_BYTES;
  const uploadedBytes = await blobStore.getUploadedBytes(hex);
  if (await blobStore.blobExists(hex)) {
    const stat = await blobStore.statBlob(hex);
    if (Number(stat.size) !== numericSize) {
      throw new CuratedLibrarySyncError(
        ERROR_CODES.CURATED_LIBRARY_BLOB_HASH_MISMATCH,
        '已存在的 Blob 大小不匹配',
        409
      );
    }
    await upsertBlobRef(userKey, hex, numericSize, true);
    return { needed: false, uploadedBytes, chunkSize };
  }
  const used = await sumReservedBlobBytes(userKey);
  if (used + numericSize > LIMITS.DEFAULT_MAX_CURATED_BLOB_BYTES_PER_USER) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_QUOTA_EXCEEDED,
      '精选库云端容量超出配额',
      400
    );
  }
  await upsertBlobRef(userKey, hex, numericSize, false);
  return { needed: true, uploadedBytes, chunkSize };
}

async function appendBlobChunk(userKey, sha256, size, start, readable) {
  const hex = String(sha256 || '').trim().toLowerCase();
  if (!isSha(hex)) {
    throw new CuratedLibrarySyncError(ERROR_CODES.INVALID_CURATED_LIBRARY_SNAPSHOT, 'sha256 无效');
  }
  try {
    const result = await blobStore.appendBlobChunk(hex, size, start, readable);
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
  const result = await blobStore.writeBlobFromStream(hex, size, readable);
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
  getStatus,
  beginFirstSnapshot,
  commitSnapshot,
  pullSnapshot,
  pushOps,
  beginBlob,
  appendBlobChunk,
  completeBlob,
  assertBlobReadable,
  deleteUserCuratedLibrary,
  blobStore
};
