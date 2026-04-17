const curatedArtistSyncService = require('../services/curatedArtistSyncService');
const UserKeyUtils = require('../utils/userKeyUtils');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middlewares/errorHandler');

class CuratedArtistSyncController {
  /**
   * 精选艺人快照同步接口
   * POST /frkbapi/v1/curated-artist-sync/sync
   */
  static syncSnapshot = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, artists, count, hash } = req.body;

    try {
      logger.apiRequest(req, res, 0);

      const syncResult = await curatedArtistSyncService.syncSnapshot(userKey, artists, {
        count,
        hash
      });
      const duration = Date.now() - startTime;

      logger.performance('curated_artist_sync', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        needSync: syncResult.needSync,
        changed: syncResult.changed,
        reason: syncResult.reason,
        artistCount: syncResult.mergedSnapshot.artistCount
      });

      logger.sync(userKey, 'curated_artist_sync_complete', {
        needSync: syncResult.needSync,
        totalCount: syncResult.mergedSnapshot.artistCount
      });

      return res.json({
        success: true,
        needSync: syncResult.needSync,
        changed: syncResult.changed,
        reason: syncResult.reason,
        message: syncResult.message,
        clientSnapshot: syncResult.clientSnapshot,
        serverSnapshotBefore: syncResult.serverSnapshotBefore,
        mergedSnapshot: syncResult.mergedSnapshot,
        performance: {
          syncDuration: duration,
          ...syncResult.performance
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.errorAndRespond(error, req, res, '精选艺人同步失败');

      logger.performance('curated_artist_sync_error', Date.now() - startTime, {
        userKey: UserKeyUtils.toShortId(userKey),
        error: error.message
      });
    }
  });
}

module.exports = CuratedArtistSyncController;
