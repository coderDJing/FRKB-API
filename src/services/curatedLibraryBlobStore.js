const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { CURATED_LIBRARY_SYNC } = require('../config/constants');

const blobRoot = () => CURATED_LIBRARY_SYNC.BLOB_ROOT;
const writeLocks = new Map();

const blobPathFor = (sha256) => {
  const hex = String(sha256 || '').trim().toLowerCase();
  return path.join(blobRoot(), hex.slice(0, 2), hex);
};

const partPathFor = (sha256) => {
  const hex = String(sha256 || '').trim().toLowerCase();
  return path.join(blobRoot(), 'tmp', `${hex}.part`);
};

const tempPathFor = (sha256) => {
  const hex = String(sha256 || '').trim().toLowerCase();
  return path.join(blobRoot(), 'tmp', `${hex}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
};

const withBlobLock = (sha256, fn) => {
  const key = String(sha256 || '').trim().toLowerCase();
  const previous = writeLocks.get(key) || Promise.resolve();
  const current = previous.then(fn, fn);
  writeLocks.set(
    key,
    current.then(
      () => undefined,
      () => undefined
    )
  );
  return current;
};

const throwDiskFullIfNeeded = (error) => {
  if (error && (error.code === 'ENOSPC' || /no space/i.test(String(error.message || '')))) {
    throw Object.assign(new Error('CURATED_LIBRARY_DISK_FULL'), { code: 'ENOSPC' });
  }
};

const hashFile = async (filePath) => {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
};

async function ensureBlobRoot() {
  await fs.mkdir(blobRoot(), { recursive: true });
  await fs.mkdir(path.join(blobRoot(), 'tmp'), { recursive: true });
}

async function blobExists(sha256) {
  try {
    await fs.access(blobPathFor(sha256));
    return true;
  } catch {
    return false;
  }
}

async function verifyBlob(sha256) {
  const hex = String(sha256 || '').trim().toLowerCase();
  if (!(await blobExists(hex))) return false;
  return (await hashFile(blobPathFor(hex))) === hex;
}

async function ensureEmptyBlob(sha256) {
  const hex = String(sha256 || '').trim().toLowerCase();
  if (hex !== crypto.createHash('sha256').update('').digest('hex')) {
    throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
  }
  await ensureBlobRoot();
  const dest = blobPathFor(hex);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (!(await blobExists(hex))) await fs.writeFile(dest, Buffer.alloc(0));
  return { path: dest, size: 0 };
}

async function statBlob(sha256) {
  const stat = await fs.stat(blobPathFor(sha256));
  return { size: stat.size, path: blobPathFor(sha256) };
}

async function getUploadedBytes(sha256) {
  if (await blobExists(sha256)) {
    const stat = await fs.stat(blobPathFor(sha256));
    return stat.size;
  }
  try {
    const stat = await fs.stat(partPathFor(sha256));
    return stat.size;
  } catch {
    return 0;
  }
}

async function promotePartFile(sha256, expectedSize) {
  const hex = String(sha256 || '').trim().toLowerCase();
  const partPath = partPathFor(hex);
  const dest = blobPathFor(hex);
  const digest = await hashFile(partPath);
  if (digest !== hex) {
    await fs.rm(partPath, { force: true });
    throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
  }
  const stat = await fs.stat(partPath);
  if (Number(expectedSize) > 0 && stat.size !== Number(expectedSize)) {
    await fs.rm(partPath, { force: true });
    throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(partPath, dest);
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => undefined);
    if (await blobExists(hex)) {
      return { uploadedBytes: stat.size, ready: true };
    }
    throw error;
  }
  return { uploadedBytes: stat.size, ready: true };
}

async function appendBlobChunk(sha256, expectedSize, start, readable) {
  const hex = String(sha256 || '').trim().toLowerCase();
  const totalSize = Number(expectedSize) || 0;
  const offset = Number(start) || 0;
  return withBlobLock(hex, async () => {
    await ensureBlobRoot();
    if (await blobExists(hex)) {
      const stat = await fs.stat(blobPathFor(hex));
      if (totalSize > 0 && stat.size !== totalSize) {
        throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
      }
      return { uploadedBytes: stat.size, ready: true };
    }
    const partPath = partPathFor(hex);
    await fs.mkdir(path.dirname(partPath), { recursive: true });
    let current = 0;
    try {
      current = (await fs.stat(partPath)).size;
    } catch {
      current = 0;
    }
    if (offset !== current) {
      throw Object.assign(new Error('CURATED_LIBRARY_BLOB_OFFSET_MISMATCH'), {
        code: 'OFFSET_MISMATCH',
        uploadedBytes: current
      });
    }
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      }
    });
    const file = fsSync.createWriteStream(partPath, { flags: current > 0 ? 'a' : 'w' });
    try {
      await pipeline(readable, counter, file);
    } catch (error) {
      throwDiskFullIfNeeded(error);
      throw error;
    }
    current += bytes;
    if (totalSize > 0 && current > totalSize) {
      await fs.rm(partPath, { force: true });
      throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
    }
    if (totalSize > 0 && current < totalSize) {
      return { uploadedBytes: current, ready: false };
    }
    return promotePartFile(hex, totalSize);
  });
}

async function writeBlobFromStream(sha256, expectedSize, readable) {
  await ensureBlobRoot();
  const dest = blobPathFor(sha256);
  if (await blobExists(sha256)) {
    const stat = await fs.stat(dest);
    if (Number(expectedSize) > 0 && stat.size !== Number(expectedSize)) {
      throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
    }
    return { path: dest, size: stat.size, alreadyReady: true };
  }
  const tempPath = tempPathFor(sha256);
  await fs.mkdir(path.dirname(tempPath), { recursive: true });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const file = fsSync.createWriteStream(tempPath);
  readable.on('data', (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
  });
  try {
    await pipeline(readable, file);
    const digest = hash.digest('hex');
    if (digest !== String(sha256).toLowerCase()) {
      await fs.rm(tempPath, { force: true });
      throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
    }
    if (Number(expectedSize) > 0 && bytes !== Number(expectedSize)) {
      await fs.rm(tempPath, { force: true });
      throw Object.assign(new Error('CURATED_LIBRARY_BLOB_HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(tempPath, dest);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      if (await blobExists(sha256)) {
        return { path: dest, size: bytes, alreadyReady: true };
      }
      throw error;
    }
    return { path: dest, size: bytes, alreadyReady: false };
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throwDiskFullIfNeeded(error);
    throw error;
  }
}

function createBlobReadStream(sha256, range) {
  const options = {};
  if (Number.isFinite(Number(range?.start))) options.start = Number(range.start);
  if (Number.isFinite(Number(range?.end))) options.end = Number(range.end);
  return fsSync.createReadStream(blobPathFor(sha256), options);
}

async function unlinkBlobIfOrphan(sha256, stillReferenced) {
  if (stillReferenced) return;
  await fs.rm(blobPathFor(sha256), { force: true }).catch(() => undefined);
  await fs.rm(partPathFor(sha256), { force: true }).catch(() => undefined);
}

async function copyBlobDirectory(sourceRoot, destRoot) {
  const src = String(sourceRoot || '').trim();
  const dest = String(destRoot || '').trim() || blobRoot();
  if (!src || src === dest) return { copied: 0, verified: 0, failed: 0 };
  const results = { copied: 0, verified: 0, failed: 0 };
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tmp') continue;
        await walk(full);
        continue;
      }
      if (!/^[a-f0-9]{64}$/i.test(entry.name)) continue;
      const target = path.join(dest, entry.name.slice(0, 2), entry.name.toLowerCase());
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(full, target);
        const digest = await hashFile(target);
        if (digest !== entry.name.toLowerCase()) {
          await fs.rm(target, { force: true });
          results.failed += 1;
          continue;
        }
        results.copied += 1;
        results.verified += 1;
      } catch {
        results.failed += 1;
      }
    }
  }
  await walk(src);
  return results;
}

module.exports = {
  blobRoot,
  blobPathFor,
  ensureBlobRoot,
  blobExists,
  verifyBlob,
  ensureEmptyBlob,
  statBlob,
  getUploadedBytes,
  promotePartFile,
  appendBlobChunk,
  writeBlobFromStream,
  createBlobReadStream,
  unlinkBlobIfOrphan,
  copyBlobDirectory
};
