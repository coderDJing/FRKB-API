const express = require('express');
const fingerprintRoutes = require('./fingerprint');
const curatedArtistRoutes = require('./curatedArtist');
const curatedLibraryRoutes = require('./curatedLibrary');
const healthRoutes = require('./health');
const logger = require('../utils/logger');
const errorReportRoutes = require('./errorReport');
const adminRoutes = require('./admin');
const { API_PREFIX } = require('../config/constants');

const router = express.Router();

function describe(method, path, text) {
  return `${method} ${API_PREFIX}${path} - ${text}`;
}

/**
 * API路由入口
 * 统一管理所有API路由
 */

// API信息接口
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🚀 Track Studio API v1 - 指纹、精选艺人与精选库同步',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    
    endpoints: {
      // 指纹同步相关接口
      sync: {
        check: describe('POST', '/fingerprint-sync/check', '同步预检查'),
        validateUserKey: describe('POST', '/fingerprint-sync/validate-user-key', '仅校验 userKey 是否有效'),
        bidirectionalDiff: describe('POST', '/fingerprint-sync/bidirectional-diff', '双向差异检测'),
        add: describe('POST', '/fingerprint-sync/add', '批量添加指纹'),
        pullDiffPage: describe('POST', '/fingerprint-sync/pull-diff-page', '分页拉取差异数据'),
        analyzeDiff: describe('POST', '/fingerprint-sync/analyze-diff', '完整差异分析'),
        reset: describe('POST', '/fingerprint-sync/reset', '重置指定userKey的所有数据（不重置使用统计）'),
        status: describe('GET', '/fingerprint-sync/status?userKey=xxx', '获取同步状态'),
        serviceStats: describe('GET', '/fingerprint-sync/service-stats', '服务统计'),
        clearCache: describe('DELETE', '/fingerprint-sync/cache/:userKey', '清除用户缓存'),
        forceUnlock: describe('DELETE', '/fingerprint-sync/lock/:userKey', '强制释放同步锁')
      },

      curatedArtistSync: {
        sync: describe('POST', '/curated-artist-sync/sync', '精选艺人快照同步')
      },
      curatedLibrarySync: {
        status: describe('POST', '/curated-library-sync/status', '精选库同步状态'),
        pull: describe('POST', '/curated-library-sync/pull', '拉取精选库 revision diff'),
        push: describe('POST', '/curated-library-sync/push', '推送精选库变更'),
        blob: describe('PUT/GET', '/curated-library-sync/blob/:sha256', '分片上传与断点下载'),
        events: describe('GET', '/curated-library-sync/events', '精选库修订 SSE'),
        reset: describe('POST', '/curated-library-sync/reset', '清空云端精选库快照与音频')
      },
      
      // 健康检查接口
      health: {
        basic: 'GET /health - 基础健康检查',
        detailed: describe('GET', '/health/detailed', '详细健康检查'),
        stats: describe('GET', '/health/stats', '系统统计'),
        diagnose: describe('GET', '/health/diagnose', '系统诊断')
      },

      // 错误日志上报
      errorReport: {
        upload: describe('POST', '/error-report/upload', '错误日志上报（无需userKey，需API Key，严格限流）')
      },

      // 管理员接口（需要adminToken）
      admin: {
        migrationStatus: describe('GET', '/admin/migration/status', '查看迁移状态'),
        export: describe('GET', '/admin/migration/export', '导出所有 Mongo 数据（不含精选库音频文件）'),
        exportCollection: describe('GET', '/admin/migration/export/:collection', '导出单个集合'),
        import: describe('POST', '/admin/migration/import', '导入数据'),
        pull: describe('POST', '/admin/migration/pull', '从源服务器拉取数据并拷贝精选库音频'),
        getBlob: describe('GET', '/admin/migration/blob/:sha256', '拉取单个精选库音频'),
        putBlob: describe('PUT', '/admin/migration/blob/:sha256', '写入单个精选库音频')
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

// 精选艺人同步路由
router.use('/curated-artist-sync', curatedArtistRoutes);
router.use('/curated-library-sync', curatedLibraryRoutes);

// 健康检查路由
router.use('/health', healthRoutes);

// 错误日志上报路由（无需 userKey，需 API Key）
router.use('/error-report', errorReportRoutes);

// 管理员路由（需要 adminToken）
router.use('/admin', adminRoutes);

// 404处理 - 针对当前 API 前缀下的未匹配路由
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
      fingerprintSync: `${API_PREFIX}/fingerprint-sync/*`,
      curatedArtistSync: `${API_PREFIX}/curated-artist-sync/*`,
      curatedLibrarySync: `${API_PREFIX}/curated-library-sync/*`,
      health: `${API_PREFIX}/health/*`,
      errorReport: `${API_PREFIX}/error-report/*`,
      admin: `${API_PREFIX}/admin/*`
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
