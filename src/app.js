const express = require('express');
// const cors = require('cors'); // 暂时注释，Electron客户端不需要CORS
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const app = express();

// 导入中间件
const { basicRateLimit, rateLimitMonitor } = require('./middlewares/rateLimit');
const { errorHandler, notFoundHandler, setupGlobalErrorHandlers } = require('./middlewares/errorHandler');
const logger = require('./utils/logger');

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// 注意：此项目专为Electron客户端设计，Electron主进程不受浏览器同源策略限制
// 因此无需CORS配置。如果将来需要支持Web客户端，可重新启用CORS配置。

// 压缩中间件
if (process.env.ENABLE_COMPRESSION !== 'false') {
  app.use(compression());
}

// 基础中间件
app.use(express.json({ 
  limit: process.env.REQUEST_SIZE_LIMIT || '10mb',
  strict: true
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: process.env.REQUEST_SIZE_LIMIT || '10mb'
}));

// 全局请求限制
app.use(basicRateLimit);
app.use(rateLimitMonitor);

// 精简的请求日志中间件
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // 在响应结束时使用精简的日志记录
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.apiRequest(req, res, duration);
  });
  
  next();
});

// 健康检查接口
const HealthController = require('./controllers/healthController');
app.get('/health', HealthController.basicHealth);

// 根路径
app.get('/', (req, res) => {
  res.json({
    message: '🚀 FRKB API 服务正在运行',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    endpoints: {
      health: '/health',
      api: process.env.API_PREFIX || '/frkbapi/v1'
    },
    docs: '查看README.md了解更多API文档'
  });
});

// API路由前缀
const apiPrefix = process.env.API_PREFIX || '/frkbapi/v1';

// API路由
const apiRoutes = require('./routes');
app.use(apiPrefix, apiRoutes);

// （移除调试启动打印）

// 404处理 - 必须在所有路由之后
app.use('*', notFoundHandler);

// 全局错误处理中间件 - 必须在最后
app.use(errorHandler);

// 设置全局错误处理器
setupGlobalErrorHandlers();

module.exports = app;