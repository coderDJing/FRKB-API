const logger = require('../utils/logger');
const UserKeyUtils = require('../utils/userKeyUtils');
const { HTTP_STATUS } = require('../config/constants');

/**
 * 统一错误处理中间件
 * 必须放在所有路由和中间件的最后
 */
const errorHandler = (error, req, res, next) => {
  // 如果响应已经发送，交给Express默认错误处理器
  if (res.headersSent) {
    return next(error);
  }

  // 构建错误上下文信息
  const errorContext = {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: error.code,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown',
    timestamp: new Date().toISOString(),
    requestId: req.id || 'unknown'
  };

  // 根据错误类型进行分类处理
  let statusCode = HTTP_STATUS.INTERNAL_ERROR;
  let errorCode = 'INTERNAL_ERROR';
  let message = '服务器内部错误';
  let details = {};

  // MongoDB/Mongoose错误
  if (error.name === 'ValidationError') {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    errorCode = 'VALIDATION_ERROR';
    message = '数据验证失败';
    details = {
      validationErrors: Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
        value: err.value
      }))
    };
    
    logger.warn('数据验证错误', { ...errorContext, details });
    
  } else if (error.name === 'CastError') {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    errorCode = 'INVALID_DATA_TYPE';
    message = '数据类型无效';
    details = {
      field: error.path,
      value: error.value,
      expectedType: error.kind
    };
    
    logger.warn('数据类型错误', { ...errorContext, details });
    
  } else if (error.name === 'MongoServerError' && error.code === 11000) {
    statusCode = HTTP_STATUS.CONFLICT;
    errorCode = 'DUPLICATE_ENTRY';
    message = '数据已存在，不能重复创建';
    
    // 解析重复键信息
    if (error.keyPattern) {
      details.duplicateFields = Object.keys(error.keyPattern);
    }
    
    logger.warn('重复数据错误', { ...errorContext, details });
    
  } else if (error.name === 'MongoNetworkError' || error.name === 'MongoTimeoutError') {
    statusCode = HTTP_STATUS.INTERNAL_ERROR;
    errorCode = 'DATABASE_CONNECTION_ERROR';
    message = '数据库连接错误';
    
    logger.error('数据库连接错误', errorContext);
    
  } else if (error.name === 'MongoParseError') {
    statusCode = HTTP_STATUS.INTERNAL_ERROR;
    errorCode = 'DATABASE_QUERY_ERROR';
    message = '数据库查询错误';
    
    logger.error('数据库查询错误', errorContext);

  // JWT相关错误
  } else if (error.name === 'JsonWebTokenError') {
    statusCode = HTTP_STATUS.UNAUTHORIZED;
    errorCode = 'INVALID_TOKEN';
    message = 'Token无效';
    
    logger.security('无效Token', errorContext);
    
  } else if (error.name === 'TokenExpiredError') {
    statusCode = HTTP_STATUS.UNAUTHORIZED;
    errorCode = 'TOKEN_EXPIRED';
    message = 'Token已过期';
    
    logger.security('Token过期', errorContext);

  // 语法错误（通常是JSON解析错误）
  } else if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    statusCode = HTTP_STATUS.BAD_REQUEST;
    errorCode = 'INVALID_JSON';
    message = 'JSON格式错误';
    
    logger.warn('JSON语法错误', errorContext);

  // 请求超时
  } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
    statusCode = HTTP_STATUS.REQUEST_TIMEOUT;
    errorCode = 'REQUEST_TIMEOUT';
    message = '请求超时';
    
    logger.warn('请求超时', errorContext);

  // 自定义应用错误
  } else if (error.status || error.statusCode) {
    statusCode = error.status || error.statusCode;
    errorCode = error.code || 'APPLICATION_ERROR';
    message = error.message || '应用错误';
    
    logger.warn('应用自定义错误', errorContext);

  // 权限相关错误
  } else if (error.message.includes('permission') || error.message.includes('权限')) {
    statusCode = HTTP_STATUS.FORBIDDEN;
    errorCode = 'PERMISSION_DENIED';
    message = '权限不足';
    
    logger.security('权限错误', errorContext);

  // 资源未找到错误
  } else if (error.message.includes('not found') || error.message.includes('未找到')) {
    statusCode = HTTP_STATUS.NOT_FOUND;
    errorCode = 'RESOURCE_NOT_FOUND';
    message = '资源未找到';
    
    logger.warn('资源未找到', errorContext);

  // 通用错误
  } else {
    // 记录未分类的错误
    logger.error('未分类错误', errorContext);
  }

  // 构建响应
  const response = {
    success: false,
    error: errorCode,
    message,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
    timestamp: new Date().toISOString()
  };

  // 开发环境返回更多错误信息
  if (process.env.NODE_ENV === 'development') {
    response.debug = {
      stack: error.stack,
      details,
      originalError: {
        name: error.name,
        message: error.message,
        code: error.code
      }
    };
  } else {
    // 生产环境只返回必要的details
    if (Object.keys(details).length > 0) {
      response.details = details;
    }
  }

  // 发送响应
  res.status(statusCode).json(response);
};

/**
 * 404错误处理中间件
 * 处理未匹配到任何路由的请求
 */
const notFoundHandler = (req, res, next) => {
  const error = {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown'
  };

  logger.warn('404 - 路由未找到', error);

  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: 'ROUTE_NOT_FOUND',
    message: `路由不存在: ${req.method} ${req.originalUrl}`,
    suggestion: '请检查请求路径和方法是否正确',
    timestamp: new Date().toISOString()
  });
};

/**
 * 异步错误捕获包装器
 * 用于包装异步路由处理函数，自动捕获Promise拒绝
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * 创建自定义错误
 */
class AppError extends Error {
  constructor(message, statusCode = HTTP_STATUS.INTERNAL_ERROR, code = 'APPLICATION_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 创建验证错误
 */
class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, HTTP_STATUS.BAD_REQUEST, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * 创建认证错误
 */
class AuthenticationError extends AppError {
  constructor(message = '认证失败') {
    super(message, HTTP_STATUS.UNAUTHORIZED, 'AUTHENTICATION_ERROR');
    this.name = 'AuthenticationError';
  }
}

/**
 * 创建权限错误
 */
class AuthorizationError extends AppError {
  constructor(message = '权限不足') {
    super(message, HTTP_STATUS.FORBIDDEN, 'AUTHORIZATION_ERROR');
    this.name = 'AuthorizationError';
  }
}

/**
 * 创建资源未找到错误
 */
class NotFoundError extends AppError {
  constructor(message = '资源未找到') {
    super(message, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

/**
 * 创建冲突错误
 */
class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, HTTP_STATUS.CONFLICT, 'CONFLICT_ERROR');
    this.name = 'ConflictError';
  }
}

/**
 * 错误工厂函数
 */
const createError = {
  badRequest: (message, details) => new ValidationError(message, details),
  unauthorized: (message) => new AuthenticationError(message),
  forbidden: (message) => new AuthorizationError(message),
  notFound: (message) => new NotFoundError(message),
  conflict: (message) => new ConflictError(message),
  internal: (message, code) => new AppError(message, HTTP_STATUS.INTERNAL_ERROR, code)
};

/**
 * 全局未捕获异常处理器
 */
const setupGlobalErrorHandlers = () => {
  // 捕获未处理的Promise拒绝
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝', {
      reason: reason.message || reason,
      stack: reason.stack,
      promise: promise.toString()
    });
    
    // 在生产环境中，可能需要优雅关闭应用
    if (process.env.NODE_ENV === 'production') {
      logger.error('因未处理的Promise拒绝而关闭应用');
      process.exit(1);
    }
  });

  // 捕获未捕获的异常
  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    // 未捕获的异常通常意味着应用处于不确定状态，应该退出
    logger.error('因未捕获的异常而关闭应用');
    process.exit(1);
  });

  // 捕获警告
  process.on('warning', (warning) => {
    logger.warn('Node.js警告', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack
    });
  });
};

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  createError,
  setupGlobalErrorHandlers
};