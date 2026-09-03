const curatedLibrarySyncService = require('../services/curatedLibrarySyncService');
const curatedLibraryEvents = require('../services/curatedLibraryEvents');
const UserKeyUtils = require('../utils/userKeyUtils');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middlewares/errorHandler');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

function respondError(res, error) {
  if (error && error.error) {
    const body = {
      success: false,
      error: error.error,
      message: error.message
    };
    if (error.snapshot) body.data = error.snapshot;
    if (error.uploadedBytes != null) {
      body.data = { ...(body.data || {}), uploadedBytes: error.uploadedBytes };
    }
    return res.status(error.status || HTTP_STATUS.BAD_REQUEST).json(body);
  }
  throw error;
}

function parseContentRange(header, fallbackTotal) {
  const raw = String(header || '').trim();
  const match = raw.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) {
    return {
      start: 0,
      total: Number(fallbackTotal) || 0
    };
  }
  return {
    start: Number(match[1]),
    total: match[3] === '*' ? Number(fallbackTotal) || 0 : Number(match[3])
  };
}

function parseByteRange(header, size) {
  const raw = String(header || '').trim();
  const match = raw.match(/^bytes=(\d+)-(\d+)?$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] != null ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= size) return { unsatisfiable: true };
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

class CuratedLibraryController {
  static status = asyncHandler(async (req, res) => {
    const userKey = req.userKey || req.body.userKey;
    const data = await curatedLibrarySyncService.getStatus(userKey);
    res.json({ success: true, data });
  });

  static beginFirstSnapshot = asyncHandler(async (req, res) => {
    try {
      const data = await curatedLibrarySyncService.beginFirstSnapshot(req.userKey || req.body.userKey);
      res.json({ success: true, data });
    } catch (error) {
      return respondError(res, error);
    }
  });

  static commitSnapshot = asyncHandler(async (req, res) => {
    try {
      const data = await curatedLibrarySyncService.commitSnapshot(req.userKey || req.body.userKey, req.body || {});
      res.json({ success: true, data });
    } catch (error) {
      return respondError(res, error);
    }
  });

  static pull = asyncHandler(async (req, res) => {
    const data = await curatedLibrarySyncService.pullSnapshot(
      req.userKey || req.body.userKey,
      req.body?.sinceRevision
    );
    res.json({ success: true, data });
  });

  static push = asyncHandler(async (req, res) => {
    try {
      const data = await curatedLibrarySyncService.pushOps(req.userKey || req.body.userKey, req.body || {});
      res.json({ success: true, data });
    } catch (error) {
      return respondError(res, error);
    }
  });

  static beginBlob = asyncHandler(async (req, res) => {
    try {
      const data = await curatedLibrarySyncService.beginBlob(
        req.userKey || req.body.userKey,
        req.body.sha256,
        req.body.size
      );
      res.json({ success: true, data });
    } catch (error) {
      return respondError(res, error);
    }
  });

  static uploadBlob = asyncHandler(async (req, res) => {
    try {
      const userKey = req.userKey || req.query.userKey;
      const sha256 = req.params.sha256;
      const size = Number(req.query.size || 0);
      const range = parseContentRange(req.headers['content-range'], size);
      const data = await curatedLibrarySyncService.appendBlobChunk(
        userKey,
        sha256,
        range.total || size,
        range.start,
        req
      );
      res.json({ success: true, data });
    } catch (error) {
      if (error?.code === 'ENOSPC' || error?.error === ERROR_CODES.CURATED_LIBRARY_DISK_FULL) {
        return res.status(507).json({
          success: false,
          error: ERROR_CODES.CURATED_LIBRARY_DISK_FULL,
          message: '服务器磁盘空间不足'
        });
      }
      if (error?.code === 'HASH_MISMATCH' || error?.error === ERROR_CODES.CURATED_LIBRARY_BLOB_HASH_MISMATCH) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: ERROR_CODES.CURATED_LIBRARY_BLOB_HASH_MISMATCH,
          message: '音频内容与 sha256 不一致'
        });
      }
      return respondError(res, error);
    }
  });

  static downloadBlob = asyncHandler(async (req, res) => {
    try {
      const userKey = req.userKey || req.query.userKey;
      const sha256 = await curatedLibrarySyncService.assertBlobReadable(userKey, req.params.sha256);
      const stat = await curatedLibrarySyncService.blobStore.statBlob(sha256);
      const size = stat.size;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${sha256}"`);
      const range = parseByteRange(req.headers.range, size);
      if (range?.unsatisfiable) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        res.setHeader('Content-Length', range.end - range.start + 1);
        curatedLibrarySyncService.blobStore.createBlobReadStream(sha256, range).pipe(res);
        return;
      }
      res.setHeader('Content-Length', size);
      curatedLibrarySyncService.blobStore.createBlobReadStream(sha256).pipe(res);
    } catch (error) {
      return respondError(res, error);
    }
  });

  static events = asyncHandler(async (req, res) => {
    const userKey = req.userKey || req.query.userKey;
    const status = await curatedLibrarySyncService.getStatus(userKey);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    req.socket.setTimeout(0);
    curatedLibraryEvents.addClient(userKey, res);
    curatedLibraryEvents.writeEvent(res, 'snapshot', {
      revision: status.revision,
      snapshotReady: status.snapshotReady
    });
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 20000);
    const cleanup = () => {
      clearInterval(ping);
      curatedLibraryEvents.removeClient(userKey, res);
    };
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  });

  /**
   * 清空当前 userKey 的云端精选库（快照 + 音频 blob）
   * POST /frkbapi/v1/curated-library-sync/reset
   */
  static reset = asyncHandler(async (req, res) => {
    const userKey = req.userKey || req.body.userKey;
    try {
      const result = await curatedLibrarySyncService.deleteUserCuratedLibrary(userKey);
      logger.admin('API清空云端精选库', {
        userKey: UserKeyUtils.toShortId(userKey),
        blobCount: result.blobCount,
        snapshotDeleted: result.snapshotDeleted,
        fileCount: result.fileCount,
        operator: req.userKey || 'client'
      });
      return res.json({
        success: true,
        message: '云端精选库已清空',
        data: result
      });
    } catch (error) {
      return respondError(res, error);
    }
  });
}

module.exports = CuratedLibraryController;
