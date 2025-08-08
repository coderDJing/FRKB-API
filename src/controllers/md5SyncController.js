const syncService = require('../services/syncService');
const bloomFilterService = require('../services/bloomFilterService');
const cacheService = require('../services/cacheService');
const UserKeyUtils = require('../utils/userKeyUtils');
const HashUtils = require('../utils/hashUtils');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middlewares/errorHandler');
const { HTTP_STATUS } = require('../config/constants');

/**
 * MD5同步控制器
 * 处理所有MD5集合同步相关的API请求
 */
class Md5SyncController {
  /**
   * 同步预检查接口
   * POST /frkbapi/v1/md5-sync/check
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
   * 双向差异检测接口
   * POST /frkbapi/v1/md5-sync/bidirectional-diff
   */
  static bidirectionalDiff = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, clientMd5s, batchIndex, batchSize } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      // 调用同步服务进行双向差异检测
      const diffResult = await syncService.bidirectionalDiff(
        userKey, 
        clientMd5s, 
        batchIndex, 
        batchSize
      );
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('bidirectional_diff', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        batchIndex,
        clientMd5Count: clientMd5s.length,
        serverMissing: diffResult.serverMissingMd5s.length,
        serverExisting: diffResult.serverExistingMd5s.length
      });
      
      res.json({
        success: true,
        batchIndex: diffResult.batchIndex,
        batchSize: diffResult.batchSize,
        
        // 服务端缺失的MD5（需要从客户端推送）
        serverMissingMd5s: diffResult.serverMissingMd5s,
        
        // 服务端已存在的MD5
        serverExistingMd5s: diffResult.serverExistingMd5s,
        
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
   * 批量添加MD5接口
   * POST /frkbapi/v1/md5-sync/add
   */
  static batchAdd = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, addMd5s } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      // 调用同步服务批量添加MD5
      const addResult = await syncService.batchAddMd5s(userKey, addMd5s);
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('batch_add', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        requestedCount: addMd5s.length,
        addedCount: addResult.addedCount,
        duplicateCount: addResult.duplicateCount
      });
      
      // 记录同步操作
      logger.sync(userKey, 'batch_add_complete', {
        added: addResult.addedCount,
        duplicates: addResult.duplicateCount,
        total: addMd5s.length,
        duration: `${duration}ms`
      });
      
      res.json({
        success: true,
        addedCount: addResult.addedCount,
        duplicateCount: addResult.duplicateCount,
        totalRequested: addResult.totalRequested,
        
        // 操作统计
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
      logger.errorAndRespond(error, req, res, '批量添加MD5失败');
      
      logger.performance('batch_add_error', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        requestedCount: addMd5s?.length || 0,
        error: error.message
      });
    }
  });

  /**
   * 分页拉取差异数据接口
   * POST /frkbapi/v1/md5-sync/pull-diff-page
   */
  static pullDiffPage = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, diffSessionId, pageIndex } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      // 调用同步服务分页拉取差异数据
      const pullResult = await syncService.pullDiffPage(userKey, diffSessionId, pageIndex);
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('pull_diff_page', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        sessionId: diffSessionId.substring(0, 16) + '...',
        pageIndex,
        returnedCount: pullResult.missingMd5s.length,
        hasMore: pullResult.pageInfo.hasMore
      });
      
      res.json({
        success: true,
        sessionId: pullResult.sessionId,
        missingMd5s: pullResult.missingMd5s,
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
   * 完整差异分析接口（兼容旧版本）
   * POST /frkbapi/v1/md5-sync/analyze-diff
   */
  static analyzeDifference = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    const { userKey, clientMd5s } = req.body;
    
    try {
      logger.apiRequest(req, res, 0);
      
      // 调用同步服务进行完整差异分析
      const analysisResult = await syncService.analyzeDifference(userKey, clientMd5s);
      
      const duration = Date.now() - startTime;
      
      // 记录API性能
      logger.performance('analyze_difference', duration, {
        userKey: UserKeyUtils.toShortId(userKey),
        clientMd5Count: clientMd5s.length,
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
        clientMd5Count: clientMd5s?.length || 0,
        error: error.message
      });
    }
  });

  /**
   * 获取同步状态接口
   * GET /frkbapi/v1/md5-sync/status
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

      // 验证userKey格式
      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      
      // 获取同步状态
      const syncStatus = syncService.getSyncStatus(normalizedUserKey);
      
      // 获取缓存的用户元数据
      const userMeta = cacheService.getUserMeta(normalizedUserKey);
      
      // 获取布隆过滤器统计
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
   * GET /frkbapi/v1/md5-sync/service-stats
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
   * DELETE /frkbapi/v1/md5-sync/cache/:userKey
   */
  static clearUserCache = asyncHandler(async (req, res) => {
    const { userKey } = req.params;
    
    try {
      // 验证userKey格式
      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      
      // 清除用户缓存
      const clearedCount = cacheService.clearUserCache(normalizedUserKey);
      
      // 清除布隆过滤器
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
   * DELETE /frkbapi/v1/md5-sync/lock/:userKey
   */
  static forceSyncUnlock = asyncHandler(async (req, res) => {
    const { userKey } = req.params;
    
    try {
      // 验证userKey格式
      const validation = UserKeyUtils.validate(userKey);
      if (!validation.valid) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'INVALID_USER_KEY',
          message: validation.error
        });
      }

      const normalizedUserKey = validation.normalized;
      
      // 获取当前锁状态
      const currentLock = syncService.getSyncStatus(normalizedUserKey);
      
      // 强制释放锁
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
}

module.exports = Md5SyncController;