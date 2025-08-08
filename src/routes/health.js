const express = require('express');
const HealthController = require('../controllers/healthController');
const { relaxedRateLimit, strictRateLimit } = require('../middlewares/rateLimit');
const { adminAuth } = require('../middlewares/auth');

const router = express.Router();

/**
 * 健康检查相关路由
 * 提供系统健康状态、监控信息和诊断接口
 */

/**
 * 详细健康检查接口
 * GET /frkbapi/v1/health/detailed
 * 提供详细的系统健康状态信息
 */
router.get('/detailed',
  relaxedRateLimit,           // 宽松限流
  HealthController.detailedHealth
);

/**
 * 系统统计信息接口
 * GET /frkbapi/v1/health/stats
 * 获取系统运行统计信息
 */
router.get('/stats',
  relaxedRateLimit,           // 宽松限流
  HealthController.getSystemStats
);

/**
 * 系统诊断接口
 * GET /frkbapi/v1/health/diagnose
 * 执行系统诊断并提供优化建议
 */
router.get('/diagnose',
  strictRateLimit,            // 严格限流（诊断操作较重）
  adminAuth,                  // 管理员认证（敏感信息）
  HealthController.diagnose
);

module.exports = router;