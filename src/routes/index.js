const express = require('express');
const fingerprintRoutes = require('./fingerprint');
const healthRoutes = require('./health');
const logger = require('../utils/logger');
const errorReportRoutes = require('./errorReport');

const router = express.Router();

/**
 * API路由入口
 * 统一管理所有API路由
 */

// API信息接口
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 FRKB API v1 - 指纹集合同步系统 (SHA256)',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    
    endpoints: {
      // 指纹同步相关接口
      sync: {
        check: 'POST /frkbapi/v1/fingerprint-sync/check - 同步预检查',
        validateUserKey: 'POST /frkbapi/v1/fingerprint-sync/validate-user-key - 仅校验 userKey 是否有效',
        bidirectionalDiff: 'POST /frkbapi/v1/fingerprint-sync/bidirectional-diff - 双向差异检测',
        add: 'POST /frkbapi/v1/fingerprint-sync/add - 批量添加指纹',
        pullDiffPage: 'POST /frkbapi/v1/fingerprint-sync/pull-diff-page - 分页拉取差异数据',
        analyzeDiff: 'POST /frkbapi/v1/fingerprint-sync/analyze-diff - 完整差异分析',
        reset: 'POST /frkbapi/v1/fingerprint-sync/reset - 重置指定userKey的所有数据（不重置使用统计）',
        status: 'GET /frkbapi/v1/fingerprint-sync/status?userKey=xxx - 获取同步状态',
        serviceStats: 'GET /frkbapi/v1/fingerprint-sync/service-stats - 服务统计',
        clearCache: 'DELETE /frkbapi/v1/fingerprint-sync/cache/:userKey - 清除用户缓存',
        forceUnlock: 'DELETE /frkbapi/v1/fingerprint-sync/lock/:userKey - 强制释放同步锁'
      },
      
      // 健康检查接口
      health: {
        basic: 'GET /health - 基础健康检查',
        detailed: 'GET /frkbapi/v1/health/detailed - 详细健康检查',
        stats: 'GET /frkbapi/v1/health/stats - 系统统计',
        diagnose: 'GET /frkbapi/v1/health/diagnose - 系统诊断'
      },

      // 错误日志上报
      errorReport: {
        upload: 'POST /frkbapi/v1/error-report/upload - 错误日志上报（无需userKey，需API Key，严格限流）'
      }
    },
    
    documentation: {
      readme: '查看项目README.md了解详细使用方法',
      apiDesign: '查看docs/API_DESIGN.md了解接口设计',
      examples: '查看docs/目录下的相关文档'
    },
    
    authentication: {
      required: true,
      method: 'Bearer Token',
      description: '所有接口都需要在Authorization头中提供API密钥'
    }
  });
});

// 请求日志中间件
router.use((req, res, next) => {
  const startTime = Date.now();
  
  // 在响应结束时记录日志
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.apiRequest(req, res, duration);
  });
  
  next();
});

// 指纹同步路由
router.use('/fingerprint-sync', fingerprintRoutes);

// 健康检查路由
router.use('/health', healthRoutes);

// 错误日志上报路由（无需 userKey，需 API Key）
router.use('/error-report', errorReportRoutes);

// 404处理 - 针对/frkbapi/v1路径下的未匹配路由
router.use('*', (req, res) => {
  logger.warn('API路由未找到', {
    method: req.method,
    originalUrl: req.originalUrl,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  
  res.status(404).json({
    success: false,
    error: 'API_ROUTE_NOT_FOUND',
    message: `API路由不存在: ${req.method} ${req.originalUrl}`,
    suggestion: '请检查请求路径和方法是否正确',
    availableEndpoints: {
      fingerprintSync: '/frkbapi/v1/fingerprint-sync/*',
      health: '/frkbapi/v1/health/*',
      errorReport: '/frkbapi/v1/error-report/*'
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;