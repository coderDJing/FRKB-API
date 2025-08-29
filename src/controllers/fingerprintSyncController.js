const syncService = require('../services/syncService');
const bloomFilterService = require('../services/bloomFilterService');
const cacheService = require('../services/cacheService');
const UserKeyUtils = require('../utils/userKeyUtils');
const HashUtils = require('../utils/hashUtils');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middlewares/errorHandler');
const { HTTP_STATUS, LIMITS } = require('../config/constants');
const AuthorizedUserKey = require('../models/AuthorizedUserKey');
const UserFingerprintCollection = require('../models/UserFingerprintCollection');
const UserCollectionMeta = require('../models/UserCollectionMeta');
const DiffSession = require('../models/DiffSession');

/**
 * 指纹同步控制器（64 位 SHA256）
 */
class FingerprintSyncController {
  /**
   * 仅校验 userKey 是否有效（不做数据同步或写入）
   * POST /frkbapi/v1/fingerprint-sync/validate-user-key
   */
  static validateUserKey = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey } = req.body;
    try {
      logger.apiRequest(req, res, 0);

      if (!userKey) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: 'userKey参数不能为空'
        });
      }

      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalized = validation.normalized;
      const authKey = await AuthorizedUserKey.findOne({ userKey: normalized }).lean();

      if (!authKey) {
        return res.status(404).json({
          success: false,
          error: 'USER_KEY_NOT_FOUND',
          message: 'userKey未找到或未授权'
        });
      }

      if (authKey.isActive === false) {
        return res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: 'USER_KEY_INACTIVE',
          message: 'userKey已被禁用'
        });
      }

      // 计算当日剩余额度（不更新使用统计，保持只读校验）
      // 仅进行只读可用性校验；不返回细粒度权限，也不涉及日配额
      const duration = Date.now() - startTime;

      return res.json({
        success: true,
        data: {
          userKey: normalized,
          isActive: !!authKey.isActive,
          description: authKey.description || '',
          lastUsedAt: authKey.lastUsedAt || null
        },
        // 顶层返回当前 userKey 的指纹总量上限（只读）
        limit: Number.isFinite(authKey.fingerprintLimit)
          ? authKey.fingerprintLimit
          : (LIMITS?.DEFAULT_MAX_FINGERPRINTS_PER_USER || 200000),
        performance: { validateDuration: duration },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.errorAndRespond(error, req, res, 'userKey校验失败');
    }
  });
  /**
   * 同步预检查接口
   * POST /frkbapi/v1/fingerprint-sync/check
   */
  static checkSyncRequired = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, count, hash } = req.body;
    
    try {
      logger.apiRequest(req, res, 0); // 开始记录
      
      // 调用同步服务进行预检查
      const checkResult = await syncService.checkSyncRequired(userKey, count, hash);
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('sync_check', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        needSync: checkResult.needSync,
        reason: checkResult.reason,
        clientCount: count,
        serverCount: checkResult.serverCount
      });
      
      res.json({
        success: true,
        needSync: checkResult.needSync,
        reason: checkResult.reason,
        message: checkResult.message,
        serverCount: checkResult.serverCount,
        serverHash: checkResult.serverHash,
        clientCount: count,
        clientHash: hash,
        lastSyncAt: checkResult.lastSyncAt,
        limit: checkResult.limit,
        performance: {
          checkDuration: duration,
          ...checkResult.performance
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.errorAndRespond(error, req, res, '同步预检查失败');
      
      // 记录失败的性能指标
      logger.performance('sync_check_error', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        error: error.message
      });
    }
  });

  /**
   * 双向差异检测接口（指纹）
   * POST /frkbapi/v1/fingerprint-sync/bidirectional-diff
   */
  static bidirectionalDiff = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, clientFingerprints, batchIndex, batchSize } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      // 调用同步服务进行双向差异检测
      const diffResult = await syncService.bidirectionalDiff(
        userKey,
        clientFingerprints,
        batchIndex,
        batchSize
      );
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('bidirectional_diff', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        batchIndex,
        clientCount: clientFingerprints.length,
        serverMissing: diffResult.serverMissingFingerprints.length,
        serverExisting: diffResult.serverExistingFingerprints.length
      });
      
      res.json({
        success: true,
        batchIndex: diffResult.batchIndex,
        batchSize: diffResult.batchSize,
        // 服务端缺失的指纹（需要从客户端推送）
        serverMissingFingerprints: diffResult.serverMissingFingerprints,
        // 服务端已存在的指纹
        serverExistingFingerprints: diffResult.serverExistingFingerprints,
        
        // 统计信息
        counts: diffResult.counts,
        
        // 会话信息（用于后续拉取客户端缺失的数据）
        sessionInfo: diffResult.sessionInfo,
        
        // 布隆过滤器统计
        bloomFilterStats: diffResult.bloomFilterStats,
        
        performance: {
          diffDuration: duration,
          ...diffResult.performance
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.errorAndRespond(error, req, res, '双向差异检测失败');
      
      logger.performance('bidirectional_diff_error', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        batchIndex,
        error: error.message
      });
    }
  });

  /**
   * 批量添加指纹接口
   * POST /frkbapi/v1/fingerprint-sync/add
   */
  static batchAdd = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, addFingerprints } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      const addResult = await syncService.batchAddFingerprints(userKey, addFingerprints);
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('batch_add', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        requestedCount: addFingerprints.length,
        addedCount: addResult.addedCount,
        duplicateCount: addResult.duplicateCount
      });
      
      // 记录同步操作
      logger.sync(userKey, 'batch_add_complete', {
        added: addResult.addedCount,
        duplicates: addResult.duplicateCount,
        total: addFingerprints.length,
        duration: `${duration}ms`
      });
      
      res.json({
        success: true,
        addedCount: addResult.addedCount,
        duplicateCount: addResult.duplicateCount,
        totalRequested: addResult.totalRequested,
        batchResult: {
          addedCount: addResult.addedCount,
          duplicateCount: addResult.duplicateCount,
          skippedCount: 0,
          errorCount: 0
        },
        performance: {
          addDuration: duration,
          ...addResult.performance
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.errorAndRespond(error, req, res, '批量添加指纹失败');
      
      logger.performance('batch_add_error', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        requestedCount: addFingerprints?.length || 0,
        error: error.message
      });
    }
  });

  /**
   * 分页拉取差异数据接口（指纹）
   * POST /frkbapi/v1/fingerprint-sync/pull-diff-page
   */
  static pullDiffPage = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, diffSessionId, pageIndex } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      const pullResult = await syncService.pullDiffPage(userKey, diffSessionId, pageIndex);
      
      const duration = Date.now() - startTime;
      
      logger.performance('pull_diff_page', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        sessionId: diffSessionId.substring(0, 16) + '...',
        pageIndex,
        returnedCount: pullResult.missingFingerprints.length,
        hasMore: pullResult.pageInfo.hasMore
      });
      
      res.json({
        success: true,
        sessionId: pullResult.sessionId,
        missingFingerprints: pullResult.missingFingerprints,
        pageInfo: pullResult.pageInfo,
        performance: {
          pullDuration: duration,
          ...pullResult.performance
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.errorAndRespond(error, req, res, '分页拉取差异数据失败');
      
      logger.performance('pull_diff_page_error', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        sessionId: diffSessionId?.substring(0, 16) + '...',
        pageIndex,
        error: error.message
      });
    }
  });

  /**
   * 完整差异分析接口（指纹）
   * POST /frkbapi/v1/fingerprint-sync/analyze-diff
   */
  static analyzeDifference = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, clientFingerprints } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      const analysisResult = await syncService.analyzeDifference(userKey, clientFingerprints);
      
      const duration = Date.now() - startTime;
      
      logger.performance('analyze_difference', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        clientCount: clientFingerprints.length,
        clientMissing: analysisResult.diffStats.clientMissingCount,
        serverMissing: analysisResult.diffStats.serverMissingCount
      });
      
      res.json({
        success: true,
        diffSessionId: analysisResult.diffSessionId,
        diffStats: analysisResult.diffStats,
        serverStats: analysisResult.serverStats,
        recommendations: analysisResult.recommendations,
        performance: {
          analysisDuration: duration,
          ...analysisResult.performance
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.errorAndRespond(error, req, res, '差异分析失败');
      
      logger.performance('analyze_difference_error', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        clientCount: clientFingerprints?.length || 0,
        error: error.message
      });
    }
  });

  /**
   * 获取同步状态接口
   * GET /frkbapi/v1/fingerprint-sync/status
   */
  static getSyncStatus = asyncHandler(async (req, res) => {
    const { userKey } = req.query;
    
    try {
      if (!userKey) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'MISSING_USER_KEY',
          message: 'userKey参数不能为空'
        });
      }

      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      const syncStatus = syncService.getSyncStatus(normalizedUserKey);
      const userMeta = cacheService.getUserMeta(normalizedUserKey);
      const bloomStats = bloomFilterService.getFilterStats(normalizedUserKey);
      
      res.json({
        success: true,
        userKey: normalizedUserKey,
        syncStatus,
        userMeta,
        bloomFilterStats: bloomStats,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.errorAndRespond(error, req, res, '获取同步状态失败');
    }
  });

  /**
   * 获取服务统计信息接口
   * GET /frkbapi/v1/fingerprint-sync/service-stats
   */
  static getServiceStats = asyncHandler(async (req, res) => {
    try {
      const stats = syncService.getServiceStats();
      
      res.json({
        success: true,
        stats,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.errorAndRespond(error, req, res, '获取服务统计失败');
    }
  });

  /**
   * 清除用户缓存接口
   * DELETE /frkbapi/v1/fingerprint-sync/cache/:userKey
   */
  static clearUserCache = asyncHandler(async (req, res) => {
    const { userKey } = req.params;
    
    try {
      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      const clearedCount = cacheService.clearUserCache(normalizedUserKey);
      bloomFilterService.clearFilter(normalizedUserKey);
      
      logger.admin('清除用户缓存', {
        userKey: UserKeyUtils.toShortId(normalizedUserKey),
        clearedCacheCount: clearedCount,
        operator: req.userKey || 'system'
      });
      
      res.json({
        success: true,
        message: '用户缓存已清除',
        clearedItems: {
          cache: clearedCount,
          bloomFilter: true
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.errorAndRespond(error, req, res, '清除用户缓存失败');
    }
  });

  /**
   * 强制释放同步锁接口（管理员功能）
   * DELETE /frkbapi/v1/fingerprint-sync/lock/:userKey
   */
  static forceSyncUnlock = asyncHandler(async (req, res) => {
    const { userKey } = req.params;
    
    try {
      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      const currentLock = syncService.getSyncStatus(normalizedUserKey);
      syncService.releaseSyncLock(normalizedUserKey);
      
      logger.admin('强制释放同步锁', {
        userKey: UserKeyUtils.toShortId(normalizedUserKey),
        previousLock: currentLock,
        operator: req.userKey || 'admin'
      });
      
      res.json({
        success: true,
        message: '同步锁已强制释放',
        previousLock: currentLock,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.errorAndRespond(error, req, res, '强制释放同步锁失败');
    }
  });

  /**
   * 重置 userKey 的所有数据（与 CLI reset-userkey 等效，使用统计不重置）
   * POST /frkbapi/v1/fingerprint-sync/reset
   * Body: { userKey: string, notes?: string }
   * 客户端自发起（无需管理员认证），但需要 API Key + userKey 校验
   */
  static resetUserData = asyncHandler(async (req, res) => {
    const { userKey, notes = '' } = req.body || {};

    try {
      // 参数与格式校验
      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      const userKeyRecord = await AuthorizedUserKey.findOne({ userKey: normalizedUserKey });
      if (!userKeyRecord) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({
          success: false,
          error: 'USER_KEY_NOT_FOUND',
          message: 'userKey不存在'
        });
      }

      // 统计待清理数量
      const [fingerprintCount, metaCount] = await Promise.all([
        UserFingerprintCollection.countDocuments({ userKey: normalizedUserKey }),
        UserCollectionMeta.countDocuments({ userKey: normalizedUserKey })
      ]);

      // 执行重置：清空指纹与元数据，重置使用统计
      const [fpResult, metaResult] = await Promise.all([
        UserFingerprintCollection.deleteMany({ userKey: normalizedUserKey }),
        UserCollectionMeta.deleteMany({ userKey: normalizedUserKey })
      ]);

      // 清理与该 userKey 相关的会话与缓存
      let clearedCache = 0;
      let deletedSessions = 0;
      try {
        clearedCache = cacheService.clearUserCache(normalizedUserKey) || 0;
        const sessionRes = await DiffSession.deleteMany({ userKey: normalizedUserKey });
        deletedSessions = sessionRes.deletedCount || 0;
      } catch (e) {
        logger.warn('清理缓存或会话时出现问题（已忽略）', {
          userKey: UserKeyUtils.toShortId(normalizedUserKey),
          error: e.message
        });
      }

      logger.admin('API重置userKey数据（不重置使用统计）', {
        userKey: UserKeyUtils.toShortId(normalizedUserKey),
        description: userKeyRecord.description,
        clearedFingerprints: fpResult.deletedCount,
        clearedMetas: metaResult.deletedCount,
        deletedSessions,
        clearedCache,
        operator: req.userKey || 'client'
      });

      return res.json({
        success: true,
        message: 'userKey数据已重置',
        userKey: normalizedUserKey,
        before: {
          fingerprintCount,
          metaCount,
          usageStats: {
            totalRequests: userKeyRecord.usageStats.totalRequests,
            totalSyncs: userKeyRecord.usageStats.totalSyncs
          }
        },
        result: {
          clearedFingerprints: fpResult.deletedCount,
          clearedMetas: metaResult.deletedCount,
          deletedSessions,
          clearedCache
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.errorAndRespond(error, req, res, '重置userKey数据失败');
    }
  });
}

module.exports = FingerprintSyncController;


