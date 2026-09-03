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
  if (!isUuid(uuid) || !isUuid(parentUuid) || !name || !nodeType) return null;
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
  if (!isUuid(fileId) || !isUuid(parentUuid) || !fileName || !isSha(sha256) || !Number.isFinite(size) || size < 0) {
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

async function sumReadyBlobBytes(userKey) {
  const rows = await UserCuratedLibraryBlob.find({ userKey, ready: true }).select('size').lean();
  return rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
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
    node.revision = nextRevision;
    snapshot.tombstones = snapshot.tombstones.filter(
      (item) => !(item.kind === 'node' && item.id === node.uuid)
    );
    const index = snapshot.nodes.findIndex((item) => item.uuid === node.uuid);
    if (index < 0 || (snapshot.nodes[index].updatedAtMs || 0) <= node.updatedAtMs) {
      if (index < 0) snapshot.nodes.push(node);
      else snapshot.nodes[index] = node;
    }
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
      deletedAtMs: Number(op.updatedAtMs) || now
    });
    return;
  }
  if (type === 'upsertFile' || type === 'undeleteFile') {
    const file = sanitizeFile(op.file);
    if (!file) return;
    file.revision = nextRevision;
    snapshot.tombstones = snapshot.tombstones.filter(
      (item) => !(item.kind === 'file' && item.id === file.fileId)
    );
    const index = snapshot.files.findIndex((item) => item.fileId === file.fileId);
    if (index < 0 || (snapshot.files[index].updatedAtMs || 0) <= file.updatedAtMs) {
      if (index < 0) snapshot.files.push(file);
      else snapshot.files[index] = file;
    }
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
      deletedAtMs: Number(op.updatedAtMs) || now
    });
  }
}

class CuratedLibrarySyncError extends Error {
  constructor(error, message, status = 400) {
    super(message);
    this.error = error;
    this.status = status;
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
  const snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
  if (snapshot.snapshotReady) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_EXISTS,
      '云端精选库已有快照',
      409
    );
  }
  const lockUntil = snapshot.firstSnapshotLockUntil ? new Date(snapshot.firstSnapshotLockUntil) : null;
  if (lockUntil && lockUntil.getTime() > Date.now() && snapshot.firstSnapshotSessionId) {
    throw new CuratedLibrarySyncError(
      ERROR_CODES.CURATED_LIBRARY_FIRST_SNAPSHOT_LOCKED,
      '另一台设备正在提交首次快照，请等待',
      409
    );
  }
  const sessionId = crypto.randomUUID();
  snapshot.firstSnapshotSessionId = sessionId;
  snapshot.firstSnapshotLockUntil = new Date(Date.now() + CURATED_LIBRARY_SYNC.FIRST_SNAPSHOT_LOCK_MS);
  await snapshot.save();
  return { sessionId };
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
  const snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
  const nodes = (Array.isArray(payload.nodes) ? payload.nodes : []).map(sanitizeNode).filter(Boolean);
  const files = (Array.isArray(payload.files) ? payload.files : []).map(sanitizeFile).filter(Boolean);
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
    snapshot.nodes = nodes
    snapshot.files = files
    snapshot.tombstones = tombstones
    snapshot.revision = nextRevision
    snapshot.snapshotReady = true
    snapshot.firstSnapshotSessionId = null
    snapshot.firstSnapshotLockUntil = null
    snapshot.lastSyncAt = new Date()
    snapshot.lastUpdateAt = new Date()
    await snapshot.save()
    await refreshBlobRefs(userKey, files)
    curatedLibraryEvents.notifyCuratedLibraryRevision(userKey, {
      revision: snapshot.revision,
      snapshotReady: true
    })
    return toPublicSnapshot(snapshot)
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
  await snapshot.save();
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
  const snapshot = await UserCuratedLibrarySnapshot.getOrCreate(userKey);
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
  const ops = Array.isArray(payload.ops) ? payload.ops : [];
  const nextRevision = (snapshot.revision || 0) + 1;
  const next = {
    nodes: [...(snapshot.nodes || [])],
    files: [...(snapshot.files || [])],
    tombstones: [...(snapshot.tombstones || [])],
    revision: snapshot.revision
  };
  for (const op of ops) applyOp(next, op, nextRevision);
  snapshot.nodes = next.nodes;
  snapshot.files = next.files;
  snapshot.tombstones = next.tombstones;
  snapshot.revision = nextRevision;
  snapshot.lastSyncAt = new Date();
  snapshot.lastUpdateAt = new Date();
  await snapshot.save();
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
  const chunkSize = CURATED_LIBRARY_SYNC.CHUNK_SIZE_BYTES;
  const uploadedBytes = await blobStore.getUploadedBytes(hex);
  if (await blobStore.blobExists(hex)) {
    await upsertBlobRef(userKey, hex, numericSize, true);
    return { needed: false, uploadedBytes, chunkSize };
  }
  const used = await sumReadyBlobBytes(userKey);
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
