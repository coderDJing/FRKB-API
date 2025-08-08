const rateLimit = require('express-rate-limit');
const UserKeyUtils = require('../utils/userKeyUtils');
const logger = require('../utils/logger');
const { RATE_LIMIT, HTTP_STATUS } = require('../config/constants');

/**
 * 基础限流配置
 */
const basicRateLimit = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.MAX_REQUESTS,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: RATE_LIMIT.MESSAGE,
    retryAfter: Math.ceil(RATE_LIMIT.WINDOW_MS / 1000) // 秒
  },
  standardHeaders: RATE_LIMIT.HEADERS,
  legacyHeaders: false,
  
  // 自定义键生成器：根据IP和userKey组合
  keyGenerator: (req) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    const ip = req.ip;
    
    if (userKey && UserKeyUtils.isValidFormat(userKey)) {
      const shortUserKey = UserKeyUtils.toShortId(userKey);
      return `${ip}:${shortUserKey}`;
    }
    
    return ip;
  },
  
  // 自定义跳过逻辑
  skip: (req) => {
    // 健康检查接口不限流
    if (req.path === '/health' || req.path === '/') {
      return true;
    }
    
    // 开发环境跳过限流，便于开发调试
    if (process.env.NODE_ENV === 'development') {
      return true;
    }
    
    return false;
  },
  
  // 请求处理函数
  handler: (req, res) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    
    logger.security('请求频率超限', {
      ip: req.ip,
      userKey: userKey ? UserKeyUtils.toShortId(userKey) : 'unknown',
      url: req.originalUrl,
      method: req.method,
      userAgent: req.headers['user-agent'],
      rateLimitInfo: {
        windowMs: RATE_LIMIT.WINDOW_MS,
        maxRequests: RATE_LIMIT.MAX_REQUESTS
      }
    });
    
    return res.status(HTTP_STATUS.RATE_LIMITED).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: RATE_LIMIT.MESSAGE,
      details: {
        windowMs: RATE_LIMIT.WINDOW_MS,
        maxRequests: RATE_LIMIT.MAX_REQUESTS,
        retryAfter: Math.ceil(RATE_LIMIT.WINDOW_MS / 1000)
      }
    });
  },
  
  // 注意：onLimitReached已弃用，改为在handler中处理日志
});

/**
 * 严格限流（用于敏感操作）
 */
const strictRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5分钟
  max: 10, // 每5分钟最多10次请求
  message: {
    success: false,
    error: 'STRICT_RATE_LIMIT_EXCEEDED',
    message: '敏感操作请求过于频繁，请稍后再试',
    retryAfter: 300 // 5分钟
  },
  standardHeaders: true,
  legacyHeaders: false,
  
  keyGenerator: (req) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    const ip = req.ip;
    
    if (userKey && UserKeyUtils.isValidFormat(userKey)) {
      const shortUserKey = UserKeyUtils.toShortId(userKey);
      return `strict:${ip}:${shortUserKey}`;
    }
    
    return `strict:${ip}`;
  },
  
  skip: (req) => {
    // 开发环境跳过严格限流，便于开发调试
    if (process.env.NODE_ENV === 'development') {
      return true;
    }
    
    return false;
  },
  
  handler: (req, res) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    
    logger.security('严格限流触发', {
      ip: req.ip,
      userKey: userKey ? UserKeyUtils.toShortId(userKey) : 'unknown',
      url: req.originalUrl,
      method: req.method
    });
    
    return res.status(HTTP_STATUS.RATE_LIMITED).json({
      success: false,
      error: 'STRICT_RATE_LIMIT_EXCEEDED',
      message: '敏感操作请求过于频繁，请稍后再试',
      details: {
        windowMs: 5 * 60 * 1000,
        maxRequests: 10,
        retryAfter: 300
      }
    });
  }
});

/**
 * 宽松限流（用于查询操作）
 */
const relaxedRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分钟
  max: 200, // 每分钟最多200次请求
  message: {
    success: false,
    error: 'QUERY_RATE_LIMIT_EXCEEDED',
    message: '查询请求过于频繁，请稍后再试',
    retryAfter: 60 // 1分钟
  },
  standardHeaders: true,
  legacyHeaders: false,
  
  keyGenerator: (req) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    const ip = req.ip;
    
    if (userKey && UserKeyUtils.isValidFormat(userKey)) {
      const shortUserKey = UserKeyUtils.toShortId(userKey);
      return `relaxed:${ip}:${shortUserKey}`;
    }
    
    return `relaxed:${ip}`;
  },
  
  skip: (req) => {
    // 健康检查和根路径不限流
    return req.path === '/health' || req.path === '/';
  }
});

/**
 * 同步操作专用限流
 */
const syncRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分钟
  max: 30, // 每分钟最多30次同步请求
  message: {
    success: false,
    error: 'SYNC_RATE_LIMIT_EXCEEDED',
    message: '同步请求过于频繁，请稍后再试',
    retryAfter: 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  
  keyGenerator: (req) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    const ip = req.ip;
    
    if (userKey && UserKeyUtils.isValidFormat(userKey)) {
      const shortUserKey = UserKeyUtils.toShortId(userKey);
      return `sync:${ip}:${shortUserKey}`;
    }
    
    return `sync:${ip}`;
  },
  
  skip: (req) => {
    // 开发环境跳过同步限流，便于开发调试
    if (process.env.NODE_ENV === 'development') {
      return true;
    }
    
    return false;
  },
  
  handler: (req, res) => {
    const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
    
    logger.security('同步操作限流触发', {
      ip: req.ip,
      userKey: userKey ? UserKeyUtils.toShortId(userKey) : 'unknown',
      url: req.originalUrl,
      method: req.method
    });
    
    return res.status(HTTP_STATUS.RATE_LIMITED).json({
      success: false,
      error: 'SYNC_RATE_LIMIT_EXCEEDED',
      message: '同步请求过于频繁，请稍后再试',
      details: {
        windowMs: 1 * 60 * 1000,
        maxRequests: 30,
        retryAfter: 60,
        suggestion: '建议增加批次大小或减少同步频率'
      }
    });
  }
  
  // 注意：onLimitReached已弃用，改为在handler中处理日志
});

/**
 * 创建自定义限流中间件
 * @param {Object} options - 限流选项
 */
const createCustomRateLimit = (options = {}) => {
  const {
    windowMs = RATE_LIMIT.WINDOW_MS,
    max = RATE_LIMIT.MAX_REQUESTS,
    message = RATE_LIMIT.MESSAGE,
    keyPrefix = 'custom',
    skipSuccessfulRequests = false,
    skipFailedRequests = false
  } = options;
  
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: 'CUSTOM_RATE_LIMIT_EXCEEDED',
      message,
      retryAfter: Math.ceil(windowMs / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    skipFailedRequests,
    
    keyGenerator: (req) => {
      const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
      const ip = req.ip;
      
      if (userKey && UserKeyUtils.isValidFormat(userKey)) {
        const shortUserKey = UserKeyUtils.toShortId(userKey);
        return `${keyPrefix}:${ip}:${shortUserKey}`;
      }
      
      return `${keyPrefix}:${ip}`;
    },
    
    skip: (req) => {
      // 开发环境跳过自定义限流，便于开发调试
      if (process.env.NODE_ENV === 'development') {
        return true;
      }
      
      return false;
    },
    
    handler: (req, res) => {
      const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
      
      logger.security('自定义限流触发', {
        ip: req.ip,
        userKey: userKey ? UserKeyUtils.toShortId(userKey) : 'unknown',
        url: req.originalUrl,
        keyPrefix,
        windowMs,
        maxRequests: max
      });
      
      return res.status(HTTP_STATUS.RATE_LIMITED).json({
        success: false,
        error: 'CUSTOM_RATE_LIMIT_EXCEEDED',
        message,
        details: {
          windowMs,
          maxRequests: max,
          retryAfter: Math.ceil(windowMs / 1000)
        }
      });
    }
  });
};

/**
 * 限流状态监控中间件
 */
const rateLimitMonitor = (req, res, next) => {
  // 记录限流相关的头信息
  res.on('finish', () => {
    const rateLimitHeaders = {
      remaining: res.getHeader('X-RateLimit-Remaining'),
      limit: res.getHeader('X-RateLimit-Limit'),
      reset: res.getHeader('X-RateLimit-Reset')
    };
    
    // 如果剩余请求数较少，记录警告
    const remaining = parseInt(rateLimitHeaders.remaining);
    const limit = parseInt(rateLimitHeaders.limit);
    
    if (remaining !== null && limit !== null && remaining < limit * 0.1) {
      const userKey = req.userKey || req.body?.userKey || req.query?.userKey;
      
      logger.warn('请求频率接近限制', {
        ip: req.ip,
        userKey: userKey ? UserKeyUtils.toShortId(userKey) : 'unknown',
        url: req.originalUrl,
        remaining,
        limit,
        utilization: `${((limit - remaining) / limit * 100).toFixed(1)}%`
      });
    }
  });
  
  next();
};

module.exports = {
  basicRateLimit,
  strictRateLimit,
  relaxedRateLimit,
  syncRateLimit,
  createCustomRateLimit,
  rateLimitMonitor
};