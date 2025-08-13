const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// 确保日志目录存在
const logDir = process.env.LOG_DIR || './logs';
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 日志格式配置
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
    
    // 添加额外的元数据
    const metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
      log += `\n  元数据: ${JSON.stringify(meta, null, 2)}`;
    }
    
    return log;
  })
);

// 控制台格式（带颜色）
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
    
    // 控制台也输出关键信息，便于快速诊断
    const metaKeys = Object.keys(meta);
    if (metaKeys.length > 0) {
      // 控制台打印精简版元数据
      log += `\n  meta: ${JSON.stringify(meta, null, 2)}`;
    }
    
    return log;
  })
);

// 创建Winston logger实例
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { 
    service: 'frkb-api',
    version: process.env.npm_package_version || '1.0.0'
  },
  transports: [
    // 应用日志 - 按日期轮转
    new DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: process.env.LOG_MAX_SIZE || '10m',
      maxFiles: process.env.LOG_MAX_FILES || '14d',
      level: 'info'
    }),

    // 错误日志 - 只记录错误级别
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: process.env.LOG_MAX_SIZE || '10m',
      maxFiles: process.env.LOG_MAX_FILES || '30d',
      level: 'error'
    }),

    // 控制台输出
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info'
    })
  ],

  // 未捕获异常处理
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '10m',
      maxFiles: '30d'
    })
  ],

  // 未处理的Promise拒绝
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '10m',
      maxFiles: '30d'
    })
  ],

  // 异常后不退出进程
  exitOnError: false
});

// 生产环境不输出debug级别到控制台
if (process.env.NODE_ENV === 'production') {
  logger.remove(winston.transports.Console);
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: 'warn'
  }));
}

// 扩展方法：记录API请求
logger.apiRequest = (req, res, duration) => {
  const { method, originalUrl, ip, headers } = req;
  const { statusCode } = res;
  
  const logData = {
    method,
    url: originalUrl,
    statusCode,
    ip,
    userAgent: headers['user-agent'],
    duration: `${duration}ms`,
    userKey: req.userKey || 'unknown',
    requestId: req.id || undefined,
    contentLength: res.get && res.get('content-length') || undefined
  };
  
  if (statusCode >= 400) {
    logger.error('API请求错误', logData);
  } else if (statusCode >= 300) {
    logger.warn('API请求重定向', logData);
  } else {
    logger.info('API请求成功', logData);
  }
};

// 扩展方法：记录数据库操作
logger.dbOperation = (operation, collection, data = {}) => {
  logger.info('数据库操作', {
    operation,
    collection,
    ...data
  });
};

// 扩展方法：记录性能指标
logger.performance = (operation, duration, details = {}) => {
  const level = duration > 5000 ? 'warn' : 'info';
  logger.log(level, '性能监控', {
    operation,
    duration: `${duration}ms`,
    ...details
  });
};

// 扩展方法：记录同步操作
logger.sync = (userKey, operation, stats = {}) => {
  logger.info('同步操作', {
    userKey,
    operation,
    ...stats
  });
};

// 扩展方法：记录安全事件
logger.security = (event, details = {}) => {
  logger.warn('安全事件', {
    event,
    timestamp: new Date().toISOString(),
    ...details
  });
};

// 扩展方法：记录管理员操作
logger.admin = (operation, operator, details = {}) => {
  logger.info('管理员操作', {
    operation,
    operator,
    timestamp: new Date().toISOString(),
    ...details
  });
};

// 扩展方法：记录系统启动信息
logger.startup = (message, config = {}) => {
  logger.info(`🚀 ${message}`, {
    environment: process.env.NODE_ENV,
    nodeVersion: process.version,
    pid: process.pid,
    ...config
  });
};

// 扩展方法：记录错误并返回用户友好的消息
logger.errorAndRespond = (error, req, res, userMessage = '服务器内部错误') => {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    userKey: req.userKey,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  };
  
  logger.error('请求处理错误', errorInfo);
  
  return res.status(500).json({
    success: false,
    message: userMessage,
    error: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
};

// 监听日志事件
logger.on('error', (error) => {
  console.error('Logger错误:', error);
});

// 优雅关闭处理
process.on('SIGINT', () => {
  logger.info('📴 收到SIGINT信号，正在关闭日志系统...');
  logger.end();
});

process.on('SIGTERM', () => {
  logger.info('📴 收到SIGTERM信号，正在关闭日志系统...');
  logger.end();
});

module.exports = logger;