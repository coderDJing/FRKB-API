const { body, query, param, validationResult } = require('express-validator');
const HashUtils = require('../utils/hashUtils');
const UserKeyUtils = require('../utils/userKeyUtils');
const logger = require('../utils/logger');
const { HTTP_STATUS, ERROR_CODES, BATCH_CONFIG, MD5_REGEX } = require('../config/constants');

/**
 * 处理验证错误的中间件
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map(error => ({
      field: error.param,
      message: error.msg,
      value: error.value,
      location: error.location
    }));
    
    logger.warn('请求验证失败', {
      url: req.originalUrl,
      method: req.method,
      userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown',
      errors: errorDetails,
      ip: req.ip
    });
    
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: ERROR_CODES.INVALID_MD5_FORMAT,
      message: '请求参数验证失败',
      errors: errorDetails
    });
  }
  
  next();
};

/**
 * userKey验证规则
 */
const validateUserKey = () => [
  body('userKey')
    .notEmpty()
    .withMessage('userKey不能为空')
    .isString()
    .withMessage('userKey必须是字符串')
    .isLength({ min: 36, max: 36 })
    .withMessage('userKey长度必须为36个字符')
    .matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    .withMessage('userKey必须是有效的UUID v4格式')
    .customSanitizer(value => value.toLowerCase()),
  handleValidationErrors
];

/**
 * MD5值验证规则
 */
const validateMd5 = (fieldName = 'md5') => [
  body(fieldName)
    .notEmpty()
    .withMessage(`${fieldName}不能为空`)
    .isString()
    .withMessage(`${fieldName}必须是字符串`)
    .isLength({ min: 32, max: 32 })
    .withMessage(`${fieldName}必须是32位字符`)
    .matches(MD5_REGEX)
    .withMessage(`${fieldName}必须是有效的MD5格式（32位十六进制）`)
    .customSanitizer(value => value.toLowerCase()),
  handleValidationErrors
];

/**
 * MD5数组验证规则
 */
const validateMd5Array = (fieldName = 'md5Array', options = {}) => {
  const {
    maxLength = BATCH_CONFIG.BATCH_SIZE,
    minLength = 1,
    required = true
  } = options;
  
  return [
    body(fieldName)
      .if(() => required)
      .notEmpty()
      .withMessage(`${fieldName}不能为空`)
      .isArray({ min: minLength, max: maxLength })
      .withMessage(`${fieldName}必须是数组，长度在${minLength}-${maxLength}之间`)
      .custom((array) => {
        if (!Array.isArray(array)) {
          throw new Error(`${fieldName}必须是数组`);
        }
        
        const invalidItems = [];
        const duplicates = [];
        const seen = new Set();
        
        array.forEach((item, index) => {
          if (typeof item !== 'string') {
            invalidItems.push({ index, value: item, reason: '必须是字符串' });
            return;
          }
          
          if (item.length !== 32) {
            invalidItems.push({ index, value: item, reason: '长度必须为32个字符' });
            return;
          }
          
          if (!MD5_REGEX.test(item)) {
            invalidItems.push({ index, value: item, reason: '不是有效的MD5格式' });
            return;
          }
          
          const normalizedItem = item.toLowerCase();
          if (seen.has(normalizedItem)) {
            duplicates.push({ index, value: item, reason: '重复的MD5值' });
          } else {
            seen.add(normalizedItem);
          }
        });
        
        if (invalidItems.length > 0) {
          throw new Error(`${fieldName}包含无效项: ${invalidItems.map(i => `索引${i.index}: ${i.reason}`).join(', ')}`);
        }
        
        if (duplicates.length > 0) {
          throw new Error(`${fieldName}包含重复项: ${duplicates.map(d => `索引${d.index}`).join(', ')}`);
        }
        
        return true;
      })
      .customSanitizer(array => array.map(item => item.toLowerCase())),
    handleValidationErrors
  ];
};

/**
 * 批次信息验证规则
 */
const validateBatchInfo = () => [
  body('batchIndex')
    .optional()
    .isInt({ min: 0 })
    .withMessage('batchIndex必须是非负整数')
    .toInt(),
  
  body('batchSize')
    .optional()
    .isInt({ min: 1, max: BATCH_CONFIG.BATCH_SIZE })
    .withMessage(`batchSize必须是1-${BATCH_CONFIG.BATCH_SIZE}之间的整数`)
    .toInt(),
  
  body('totalBatches')
    .optional()
    .isInt({ min: 1 })
    .withMessage('totalBatches必须是正整数')
    .toInt(),
  
  handleValidationErrors
];

/**
 * 集合哈希验证规则
 */
const validateCollectionHash = () => [
  body('hash')
    .notEmpty()
    .withMessage('集合哈希值不能为空')
    .isString()
    .withMessage('集合哈希值必须是字符串')
    .isLength({ min: 64, max: 64 })
    .withMessage('集合哈希值必须是64位字符')
    .matches(/^[a-f0-9]{64}$/i)
    .withMessage('集合哈希值必须是有效的SHA256格式')
    .customSanitizer(value => value.toLowerCase()),
  handleValidationErrors
];

/**
 * 集合数量验证规则
 */
const validateCount = () => [
  body('count')
    .notEmpty()
    .withMessage('集合数量不能为空')
    .isInt({ min: 0 })
    .withMessage('集合数量必须是非负整数')
    .toInt(),
  handleValidationErrors
];

/**
 * 分页参数验证规则
 */
const validatePagination = () => [
  query('page')
    .optional()
    .isInt({ min: 0 })
    .withMessage('页码必须是非负整数')
    .toInt(),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: BATCH_CONFIG.BATCH_SIZE })
    .withMessage(`每页数量必须是1-${BATCH_CONFIG.BATCH_SIZE}之间的整数`)
    .toInt(),
  
  query('sortBy')
    .optional()
    .isIn(['createdAt', 'updatedAt', 'md5'])
    .withMessage('排序字段只能是 createdAt, updatedAt, md5'),
  
  query('sortOrder')
    .optional()
    .isIn(['asc', 'desc'])
    .withMessage('排序方向只能是 asc 或 desc'),
  
  handleValidationErrors
];

/**
 * 同步预检查验证规则
 */
const validateSyncCheck = () => [
  ...validateUserKey(),
  ...validateCount(),
  ...validateCollectionHash()
];

/**
 * 批量推送验证规则
 */
const validateBatchPush = () => [
  ...validateUserKey(),
  ...validateMd5Array('md5Batch', { maxLength: BATCH_CONFIG.BATCH_SIZE }),
  ...validateBatchInfo()
];

/**
 * 差异分析验证规则
 */
const validateDiffAnalysis = () => [
  ...validateUserKey(),
  ...validateMd5Array('clientMd5s', { maxLength: 100000 }) // 允许更大的数组用于完整差异分析
];

/**
 * 分页拉取验证规则
 */
const validatePullDiffPage = () => [
  ...validateUserKey(),
  
  body('diffSessionId')
    .notEmpty()
    .withMessage('差异会话ID不能为空')
    .isString()
    .withMessage('差异会话ID必须是字符串')
    .matches(/^diff_[a-z0-9]+$/i)
    .withMessage('差异会话ID格式无效'),
  
  body('pageIndex')
    .notEmpty()
    .withMessage('页码不能为空')
    .isInt({ min: 0 })
    .withMessage('页码必须是非负整数')
    .toInt(),
  
  handleValidationErrors
];

/**
 * 双向差异检测验证规则
 */
const validateBidirectionalDiff = () => [
  ...validateUserKey(),
  ...validateMd5Array('clientMd5s', { maxLength: BATCH_CONFIG.BATCH_SIZE }),
  
  body('batchIndex')
    .notEmpty()
    .withMessage('批次索引不能为空')
    .isInt({ min: 0 })
    .withMessage('批次索引必须是非负整数')
    .toInt(),
  
  body('batchSize')
    .notEmpty()
    .withMessage('批次大小不能为空')
    .isInt({ min: 1, max: BATCH_CONFIG.BATCH_SIZE })
    .withMessage(`批次大小必须是1-${BATCH_CONFIG.BATCH_SIZE}之间的整数`)
    .toInt(),
  
  handleValidationErrors
];

/**
 * 批量添加MD5验证规则
 */
const validateBatchAdd = () => [
  ...validateUserKey(),
  ...validateMd5Array('addMd5s', { maxLength: BATCH_CONFIG.BATCH_SIZE }),
  handleValidationErrors
];

/**
 * 自定义验证：检查MD5数组实际内容
 */
const validateMd5ArrayContent = (req, res, next) => {
  try {
    const md5Arrays = ['md5Array', 'md5Batch', 'clientMd5s', 'addMd5s'];
    
    for (const fieldName of md5Arrays) {
      const array = req.body[fieldName];
      
      if (array && Array.isArray(array)) {
        const validation = HashUtils.validateMd5Array(array);
        
        if (!validation.valid) {
          logger.warn('MD5数组内容验证失败', {
            field: fieldName,
            totalCount: array.length,
            validCount: validation.validCount,
            invalidCount: validation.invalidCount,
            invalidItems: validation.invalidItems.slice(0, 5), // 只记录前5个错误
            userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown',
            url: req.originalUrl
          });
          
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: ERROR_CODES.INVALID_MD5_FORMAT,
            message: `${fieldName}包含无效的MD5值`,
            details: {
              totalCount: array.length,
              validCount: validation.validCount,
              invalidCount: validation.invalidCount,
              invalidItems: validation.invalidItems.slice(0, 10) // 返回前10个错误
            }
          });
        }
        
        // 替换为验证后的数组
        req.body[fieldName] = validation.validItems;
      }
    }
    
    next();
    
  } catch (error) {
    logger.error('MD5数组内容验证异常', {
      error: error.message,
      url: req.originalUrl,
      userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown'
    });
    
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'MD5数组验证过程中发生错误'
    });
  }
};

/**
 * 请求体大小验证中间件
 */
const validateRequestSize = (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length']) || 0;
  const maxSize = 10 * 1024 * 1024; // 10MB
  
  if (contentLength > maxSize) {
    logger.warn('请求体过大', {
      contentLength,
      maxSize,
      url: req.originalUrl,
      userKey: req.userKey ? UserKeyUtils.toShortId(req.userKey) : 'unknown',
      ip: req.ip
    });
    
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: 'REQUEST_TOO_LARGE',
      message: `请求体大小超过限制（最大${maxSize / 1024 / 1024}MB）`,
      details: {
        currentSize: `${(contentLength / 1024 / 1024).toFixed(2)}MB`,
        maxSize: `${maxSize / 1024 / 1024}MB`
      }
    });
  }
  
  next();
};

module.exports = {
  handleValidationErrors,
  validateUserKey,
  validateMd5,
  validateMd5Array,
  validateBatchInfo,
  validateCollectionHash,
  validateCount,
  validatePagination,
  validateSyncCheck,
  validateBatchPush,
  validateDiffAnalysis,
  validatePullDiffPage,
  validateBidirectionalDiff,
  validateBatchAdd,
  validateMd5ArrayContent,
  validateRequestSize
};