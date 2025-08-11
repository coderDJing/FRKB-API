const express = require('express');
const Md5SyncController = require('../controllers/md5SyncController');

// 中间件导入
const { syncAuth, queryAuth, adminAuth } = require('../middlewares/auth');
const { syncRateLimit, relaxedRateLimit, strictRateLimit } = require('../middlewares/rateLimit');
const {
  validateSyncCheck,
  validateBidirectionalDiff,
  validateBatchAdd,
  validatePullDiffPage,
  validateDiffAnalysis,
  validateMd5ArrayContent,
  validateRequestSize
} = require('../middlewares/validation');

const router = express.Router();

/**
 * MD5同步相关路由
 * 所有路由都需要通过认证和验证
 */

// 应用全局中间件
router.use(validateRequestSize); // 请求体大小验证

// （已移除调试日志）

/**
 * 同步预检查接口
 * POST /frkbapi/v1/md5-sync/check
 * 快速判断是否需要同步，避免不必要的数据传输
 */
router.post('/check', 
  relaxedRateLimit,           // 宽松限流（查询类操作）
  syncAuth,                   // 同步认证（API密钥 + userKey + 同步权限）
  ...validateSyncCheck(),     // 验证请求参数
  Md5SyncController.checkSyncRequired
);

/**
 * 双向差异检测接口
 * POST /frkbapi/v1/md5-sync/bidirectional-diff
 * 分析客户端和服务端的差异，支持分批处理
 */
router.post('/bidirectional-diff',
  syncRateLimit,              // 同步限流
  syncAuth,                   // 同步认证
  ...validateBidirectionalDiff(),  // 验证请求参数
  validateMd5ArrayContent,         // 验证MD5数组内容
  Md5SyncController.bidirectionalDiff
);

/**
 * 批量添加MD5接口
 * POST /frkbapi/v1/md5-sync/add
 * 将客户端的新MD5添加到服务端
 */
router.post('/add',
  syncRateLimit,              // 同步限流
  syncAuth,                   // 同步认证
  ...validateBatchAdd(),      // 验证请求参数
  validateMd5ArrayContent,    // 验证MD5数组内容
  Md5SyncController.batchAdd
);

/**
 * 分页拉取差异数据接口
 * POST /frkbapi/v1/md5-sync/pull-diff-page
 * 获取客户端缺失的MD5数据
 */
router.post('/pull-diff-page',
  syncRateLimit,              // 同步限流
  syncAuth,                   // 同步认证
  ...validatePullDiffPage(),  // 验证请求参数
  Md5SyncController.pullDiffPage
);

/**
 * 完整差异分析接口（兼容旧版本）
 * POST /frkbapi/v1/md5-sync/analyze-diff
 * 分析客户端和服务端的完整差异
 */
router.post('/analyze-diff',
  strictRateLimit,            // 严格限流（操作较重）
  syncAuth,                   // 同步认证
  ...validateDiffAnalysis(),  // 验证请求参数
  validateMd5ArrayContent,    // 验证MD5数组内容
  Md5SyncController.analyzeDifference
);

/**
 * 获取同步状态接口
 * GET /frkbapi/v1/md5-sync/status
 * 查询用户的同步状态和统计信息
 */
router.get('/status',
  relaxedRateLimit,           // 宽松限流
  queryAuth,                  // 查询认证（API密钥 + userKey + 查询权限）
  Md5SyncController.getSyncStatus
);

/**
 * 获取服务统计信息接口
 * GET /frkbapi/v1/md5-sync/service-stats
 * 获取整个服务的统计信息（无需userKey）
 */
router.get('/service-stats',
  relaxedRateLimit,           // 宽松限流
  syncAuth[0],                // 只需要API密钥验证
  Md5SyncController.getServiceStats
);

/**
 * 清除用户缓存接口
 * DELETE /frkbapi/v1/md5-sync/cache/:userKey
 * 清除指定用户的缓存和布隆过滤器
 */
router.delete('/cache/:userKey',
  strictRateLimit,            // 严格限流
  syncAuth,                   // 同步认证
  Md5SyncController.clearUserCache
);

/**
 * 强制释放同步锁接口（管理员功能）
 * DELETE /frkbapi/v1/md5-sync/lock/:userKey
 * 强制释放用户的同步锁（仅管理员）
 */
router.delete('/lock/:userKey',
  strictRateLimit,            // 严格限流
  adminAuth,                  // 管理员认证
  Md5SyncController.forceSyncUnlock
);

module.exports = router;