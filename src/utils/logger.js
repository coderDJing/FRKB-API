const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// 确保日志目录存在
const logDir = process.env.LOG_DIR || './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 日志配置
const LOG_CONFIG = {
  // 日志轮转配置
  maxSize: process.env.LOG_MAX_SIZE || '5m',       // 减小单文件大小
  appLogRetention: process.env.LOG_APP_RETENTION || '3d',   // 应用日志保留3天
  errorLogRetention: process.env.LOG_ERROR_RETENTION || '7d', // 错误日志保留7天
  
  // 精简模式控制
  minimal: process.env.LOG_MINIMAL === 'true',      // 最小日志模式
  skipHealthChecks: process.env.LOG_SKIP_HEALTH !== 'false',  // 跳过健康检查日志
  skipSuccessfulAuth: process.env.LOG_SKIP_AUTH_SUCCESS !== 'false', // 跳过成功认证日志
};

// 精简的日志格式配置
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    
    // 添加错误堆栈
    if (stack) {
      log += `\n${stack}`;
    }
    
    // 只在非精简模式下添加关键元数据
    if (!LOG_CONFIG.minimal && Object.keys(meta).length > 0) {
      // 过滤掉不重要的字段
      const filteredMeta = Object.fromEntries(
        Object.entries(meta).filter(([key, value]) => {
          // 排除默认服务信息和过于详细的字段
          return !['service', 'version', 'userAgent', 'ip'].includes(key) && 
                 value !== undefined && value !== null;
        })
      );
      
      if (Object.keys(filteredMeta).length > 0) {
        log += ` | ${JSON.stringify(filteredMeta)}`;
      }
    }
    
    return log;
  })
);

// 精简的控制台格式
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `[${timestamp}] ${level}: ${message}`;
    
    if (stack) {
      log += `\n${stack}`;
    }
    
    return log;
  })
);

// 创建Winston logger实例
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  // 精简的默认元数据
  defaultMeta: { 
    service: 'frkb-api'
  },
  transports: [
    // 应用日志 - 使用优化的轮转配置
    new DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: LOG_CONFIG.maxSize,
      maxFiles: LOG_CONFIG.appLogRetention,
      level: 'info'
    }),

    // 错误日志 - 缩短保留时间
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: LOG_CONFIG.maxSize,
      maxFiles: LOG_CONFIG.errorLogRetention,
      level: 'error'
    }),

    // 控制台输出 - 生产环境只输出警告以上级别
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'warn'
    })
  ],

  // 异常处理 - 缩短保留时间
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: LOG_CONFIG.maxSize,
      maxFiles: '7d'  // 异常日志保留7天即可
    })
  ],

  // Promise拒绝处理 - 缩短保留时间
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: LOG_CONFIG.maxSize,
      maxFiles: '7d'  // Promise拒绝日志保留7天即可
    })
  ],

  exitOnError: false
});

// 精简的扩展方法 - 只保留关键功能

// API请求日志 - 简化版本
logger.apiRequest = (req, res, duration) => {
  const { method, originalUrl } = req;
  const { statusCode } = res;
  
  // 跳过健康检查日志
  if (LOG_CONFIG.skipHealthChecks && originalUrl === '/health') {
    return;
  }
  
  // 只记录关键信息
  const logData = {
    method,
    url: originalUrl,
    status: statusCode,
    duration: `${duration}ms`,
    userKey: req.userKey || 'anonymous'
  };
  
  if (statusCode >= 500) {
    logger.error('服务器错误', logData);
  } else if (statusCode >= 400) {
    logger.warn('客户端错误', logData);
  } else if (statusCode >= 300) {
    logger.info('重定向', logData);
  } else if (!LOG_CONFIG.minimal) {
    // 正常请求在精简模式下不记录
    logger.info('请求成功', logData);
  }
};

// 性能监控 - 只记录慢请求
logger.performance = (operation, duration, critical = false) => {
  const slowThreshold = 3000; // 3秒阈值
  
  if (critical || duration > slowThreshold) {
    const level = duration > slowThreshold * 2 ? 'error' : 'warn';
    logger.log(level, `慢操作: ${operation}`, {
      duration: `${duration}ms`,
      threshold: `${slowThreshold}ms`
    });
  }
};

// 安全事件 - 重要事件必须记录
logger.security = (event, details = {}) => {
  logger.warn(`安全: ${event}`, {
    ...details,
    timestamp: new Date().toISOString()
  });
};

// 系统错误处理（尊重错误对象的状态码/错误码/细节）
logger.errorAndRespond = (error, req, res, userMessage = '服务器内部错误') => {
  const statusCode = error.status || error.statusCode || 500;
  const errorCode = error.code || 'INTERNAL_ERROR';
  const message = error.message || userMessage || '服务器内部错误';

  const errorInfo = {
    message,
    code: errorCode,
    statusCode,
    url: req.originalUrl,
    method: req.method,
    userKey: req.userKey || 'anonymous',
    details: error.details
  };

  // 只在开发环境记录完整堆栈
  if (process.env.NODE_ENV === 'development') {
    errorInfo.stack = error.stack;
  }

  logger.error('请求错误', errorInfo);

  const response = {
    success: false,
    error: errorCode,
    message,
    ...(error.details ? { details: error.details } : {}),
    timestamp: new Date().toISOString()
  };

  // 可选的 requestId（如果上游有注入）
  if (req && req.id) {
    response.requestId = req.id;
  }

  return res.status(statusCode).json(response);
};

// 系统启动日志
logger.startup = (message) => {
  logger.info(`🚀 ${message}`, {
    env: process.env.NODE_ENV,
    pid: process.pid
  });
};

// 管理员操作日志 - 单独记录管理员操作
logger.admin = (operation, details = {}) => {
  const adminLogData = {
    category: 'ADMIN',
    operation,
    timestamp: new Date().toISOString(),
    ...details
  };
  
  // 管理员操作始终记录，不受精简模式影响
  logger.warn(`🔧 管理员操作: ${operation}`, adminLogData);
};

// 同步操作日志 - 兼容原有接口但简化内容
logger.sync = (userKey, operation, stats = {}) => {
  // 只记录重要的同步操作，跳过过于频繁的操作
  const importantOps = [
    'sync_check_complete', 'bidirectional_diff_complete', 
    'batch_add_complete', 'pull_diff_page_complete', 'analyze_diff_complete'
  ];
  
  if (LOG_CONFIG.minimal && !importantOps.includes(operation)) {
    return; // 精简模式下跳过不重要的同步日志
  }
  
  const logData = {
    userKey: userKey ? userKey.substring(0, 8) + '***' : 'unknown',
    operation
  };
  
  // 只包含关键统计信息
  if (stats.needSync !== undefined) logData.needSync = stats.needSync;
  if (stats.addedCount !== undefined) logData.addedCount = stats.addedCount;
  if (stats.totalCount !== undefined) logData.totalCount = stats.totalCount;
  
  logger.info('同步操作', logData);
};

// 监听日志事件
logger.on('error', (error) => {
  console.error('Logger错误:', error);
});

// 优雅关闭处理
process.on('SIGINT', () => {
  logger.info('📴 服务正在关闭...');
  logger.end();
});

process.on('SIGTERM', () => {
  logger.info('📴 服务正在关闭...');
  logger.end();
});

// 导出配置供其他模块使用
logger.config = LOG_CONFIG;

module.exports = logger;