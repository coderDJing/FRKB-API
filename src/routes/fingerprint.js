const express = require('express');
const FingerprintSyncController = require('../controllers/fingerprintSyncController');

const { apiKeyAuth, syncAuth, queryAuth, adminAuth } = require('../middlewares/auth');
const { syncRateLimit, relaxedRateLimit, strictRateLimit } = require('../middlewares/rateLimit');
const {
  validateSyncCheck,
  validateBidirectionalDiff,
  validateBatchAdd,
  validatePullDiffPage,
  validateDiffAnalysis,
  validateFingerprintArrayContent,
  validateRequestSize
} = require('../middlewares/validation');

const router = express.Router();

// 全局请求体大小校验
router.use(validateRequestSize);

// 预检查
router.post('/check', relaxedRateLimit, syncAuth, ...validateSyncCheck(), FingerprintSyncController.checkSyncRequired);

// 仅校验 userKey（不做任何数据写入）
router.post('/validate-user-key', relaxedRateLimit, apiKeyAuth, FingerprintSyncController.validateUserKey);

// 双向差异（分批）
router.post('/bidirectional-diff', syncRateLimit, syncAuth, ...validateBidirectionalDiff(), validateFingerprintArrayContent, FingerprintSyncController.bidirectionalDiff);

// 批量新增
router.post('/add', syncRateLimit, syncAuth, ...validateBatchAdd(), validateFingerprintArrayContent, FingerprintSyncController.batchAdd);

// 分页拉取缺失
router.post('/pull-diff-page', syncRateLimit, syncAuth, ...validatePullDiffPage(), FingerprintSyncController.pullDiffPage);

// 一次性差异分析
router.post('/analyze-diff', strictRateLimit, syncAuth, ...validateDiffAnalysis(), validateFingerprintArrayContent, FingerprintSyncController.analyzeDifference);

// 状态与服务统计
router.get('/status', relaxedRateLimit, queryAuth, FingerprintSyncController.getSyncStatus);
router.get('/service-stats', relaxedRateLimit, syncAuth[0], FingerprintSyncController.getServiceStats);

// 管理接口
router.delete('/cache/:userKey', strictRateLimit, syncAuth, FingerprintSyncController.clearUserCache);
router.delete('/lock/:userKey', strictRateLimit, adminAuth, FingerprintSyncController.forceSyncUnlock);

module.exports = router;


