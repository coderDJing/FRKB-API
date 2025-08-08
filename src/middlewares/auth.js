const AuthorizedUserKey = require('../models/AuthorizedUserKey');
const UserKeyUtils = require('../utils/userKeyUtils');
const HashUtils = require('../utils/hashUtils');
const logger = require('../utils/logger');
const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

/**
 * API密钥认证中间件
 */
const apiKeyAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      logger.security('API密钥缺失', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        url: req.originalUrl
      });
      
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: ERROR_CODES.INVALID_API_KEY,
        message: '缺少Authorization头'
      });
    }

    const [scheme, token] = authHeader.split(' ');
    
    if (scheme !== 'Bearer' || !token) {
      logger.security('API密钥格式错误', {
        authHeader,
        ip: req.ip,
        url: req.originalUrl
      });
      
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: ERROR_CODES.INVALID_API_KEY,
        message: 'Authorization头格式错误，应为: Bearer <token>'
      });
    }

    const expectedApiKey = process.env.API_SECRET_KEY;
    
    if (!expectedApiKey) {
      logger.error('API密钥未配置', {
        url: req.originalUrl,
        environment: process.env.NODE_ENV
      });
      
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
        success: false,
        error: 'SERVER_CONFIG_ERROR',
        message: '服务器配置错误'
      });
    }
    // 使用时间恒定比较防止时序攻击
    if (!HashUtils.secureCompare(token, expectedApiKey)) {
      logger.security('API密钥验证失败', {
        providedKey: token.substring(0, 8) + '***',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        url: req.originalUrl
      });
      
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: ERROR_CODES.INVALID_API_KEY,
        message: 'API密钥无效'
      });
    }

    // 验证成功，继续处理
    req.apiKeyValidated = true;
    req.apiKeyUsedAt = new Date();
    
    next();
    
  } catch (error) {
    logger.error('API密钥验证异常', {
      error: error.message,
      stack: error.stack,
      url: req.originalUrl,
      ip: req.ip
    });
    
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'AUTH_ERROR',
      message: '认证过程中发生错误'
    });
  }
};

/**
 * UserKey验证中间件
 */
const userKeyAuth = async (req, res, next) => {
  try {
    const userKey = req.body.userKey || req.query.userKey;
    
    if (!userKey) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: ERROR_CODES.INVALID_USER_KEY,
        message: 'userKey参数缺失'
      });
    }

    // 基本格式验证
    const validation = UserKeyUtils.validate(userKey);
    if (!validation.valid) {
      logger.security('userKey格式无效', {
        userKey: UserKeyUtils.toShortId(userKey),
        error: validation.error,
        ip: req.ip,
        url: req.originalUrl
      });
      
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: ERROR_CODES.INVALID_USER_KEY,
        message: validation.error
      });
    }

    const normalizedUserKey = validation.normalized;

    // 数据库验证userKey是否授权
    const authResult = await AuthorizedUserKey.validateUserKey(normalizedUserKey, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      isSync: req.originalUrl.includes('/sync')
    });

    if (!authResult.valid) {
      logger.security('userKey验证失败', {
        userKey: UserKeyUtils.toShortId(normalizedUserKey),
        reason: authResult.reason,
        message: authResult.message,
        ip: req.ip,
        url: req.originalUrl
      });
      
      const statusCode = authResult.reason === 'USER_KEY_NOT_FOUND' 
        ? HTTP_STATUS.NOT_FOUND 
        : authResult.reason === 'DAILY_LIMIT_EXCEEDED'
        ? HTTP_STATUS.RATE_LIMITED
        : HTTP_STATUS.FORBIDDEN;
      
      return res.status(statusCode).json({
        success: false,
        error: authResult.reason,
        message: authResult.message,
        ...(authResult.limitInfo && { limitInfo: authResult.limitInfo })
      });
    }

    // 验证成功，设置请求上下文
    req.userKey = normalizedUserKey;
    req.authKey = authResult.authKey;
    req.userKeyValidatedAt = new Date();
    req.limitInfo = authResult.limitInfo;

    logger.info('userKey验证成功', {
      userKey: UserKeyUtils.toShortId(normalizedUserKey),
      ip: req.ip,
      url: req.originalUrl,
      remainingRequests: authResult.limitInfo?.remaining || '无限制'
    });

    next();
    
  } catch (error) {
    logger.error('userKey验证异常', {
      error: error.message,
      stack: error.stack,
      userKey: req.body.userKey ? UserKeyUtils.toShortId(req.body.userKey) : 'unknown',
      url: req.originalUrl,
      ip: req.ip
    });
    
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'AUTH_ERROR',
      message: 'userKey验证过程中发生错误'
    });
  }
};

/**
 * 权限检查中间件工厂
 * @param {string} permission - 需要的权限类型
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    try {
      if (!req.authKey) {
        return res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: 'NO_AUTH_KEY',
          message: '权限验证失败：未找到认证信息'
        });
      }

      const permissions = req.authKey.permissions || {};
      
      switch (permission) {
        case 'sync':
          if (!permissions.canSync) {
            logger.security('同步权限被拒绝', {
              userKey: UserKeyUtils.toShortId(req.userKey),
              ip: req.ip,
              url: req.originalUrl
            });
            
            return res.status(HTTP_STATUS.FORBIDDEN).json({
              success: false,
              error: 'SYNC_PERMISSION_DENIED',
              message: '该userKey没有同步权限'
            });
          }
          break;
          
        case 'query':
          if (!permissions.canQuery) {
            logger.security('查询权限被拒绝', {
              userKey: UserKeyUtils.toShortId(req.userKey),
              ip: req.ip,
              url: req.originalUrl
            });
            
            return res.status(HTTP_STATUS.FORBIDDEN).json({
              success: false,
              error: 'QUERY_PERMISSION_DENIED',
              message: '该userKey没有查询权限'
            });
          }
          break;
          
        default:
          return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
            success: false,
            error: 'UNKNOWN_PERMISSION',
            message: '未知的权限类型'
          });
      }

      next();
      
    } catch (error) {
      logger.error('权限检查异常', {
        error: error.message,
        permission,
        userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown',
        url: req.originalUrl
      });
      
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
        success: false,
        error: 'PERMISSION_CHECK_ERROR',
        message: '权限检查过程中发生错误'
      });
    }
  };
};

/**
 * 组合认证中间件（API密钥 + userKey验证）
 */
const fullAuth = [apiKeyAuth, userKeyAuth];

/**
 * 同步操作认证中间件（包含同步权限检查）
 */
const syncAuth = [apiKeyAuth, userKeyAuth, requirePermission('sync')];

/**
 * 查询操作认证中间件（包含查询权限检查）
 */
const queryAuth = [apiKeyAuth, userKeyAuth, requirePermission('query')];

/**
 * 可选的userKey验证中间件（如果提供了userKey则验证，否则跳过）
 */
const optionalUserKeyAuth = async (req, res, next) => {
  const userKey = req.body.userKey || req.query.userKey;
  
  if (!userKey) {
    // 没有提供userKey，跳过验证
    return next();
  }
  
  // 有userKey，进行验证
  return userKeyAuth(req, res, next);
};

/**
 * 管理员认证中间件（仅用于管理接口）
 */
const adminAuth = (req, res, next) => {
  try {
    // 仅支持查询参数 adminToken（便于在浏览器直接访问GET接口）
    const adminToken = req.query?.adminToken;
    const expectedAdminToken = process.env.ADMIN_SECRET_TOKEN;
    
    if (!adminToken || !expectedAdminToken) {
      logger.security('管理员认证失败：token缺失', {
        hasQueryToken: !!adminToken,
        hasExpectedToken: !!expectedAdminToken,
        ip: req.ip,
        url: req.originalUrl
      });
      
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: 'ADMIN_AUTH_REQUIRED',
        message: '管理员认证失败'
      });
    }
    
    if (!HashUtils.secureCompare(adminToken, expectedAdminToken)) {
      logger.security('管理员token无效', {
        ip: req.ip,
        url: req.originalUrl,
        providedToken: adminToken.substring(0, 8) + '***'
      });
      
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: 'INVALID_ADMIN_TOKEN',
        message: '管理员token无效'
      });
    }
    
    req.isAdmin = true;
    req.adminAuthAt = new Date();
    
    logger.admin('管理员认证成功', {
      ip: req.ip,
      url: req.originalUrl
    });
    
    next();
    
  } catch (error) {
    logger.error('管理员认证异常', {
      error: error.message,
      url: req.originalUrl,
      ip: req.ip
    });
    
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'ADMIN_AUTH_ERROR',
      message: '管理员认证过程中发生错误'
    });
  }
};

module.exports = {
  apiKeyAuth,
  userKeyAuth,
  requirePermission,
  fullAuth,
  syncAuth,
  queryAuth,
  optionalUserKeyAuth,
  adminAuth
};