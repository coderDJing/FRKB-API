const { v4: uuidv4, validate: uuidValidate, version: uuidVersion } = require('uuid');
const { USER_KEY_REGEX } = require('../config/constants');

/**
 * UserKey管理工具类
 */
class UserKeyUtils {
  /**
   * 验证userKey格式是否正确
   * @param {string} userKey - 用户密钥
   * @returns {boolean} 是否为有效的UUID v4格式
   */
  static isValidFormat(userKey) {
    if (typeof userKey !== 'string') {
      return false;
    }

    // 基本格式检查
    if (!USER_KEY_REGEX.test(userKey)) {
      return false;
    }

    // 使用uuid库进行严格验证
    if (!uuidValidate(userKey)) {
      return false;
    }

    // 确保是UUID v4
    if (uuidVersion(userKey) !== 4) {
      return false;
    }

    return true;
  }

  /**
   * 生成新的userKey
   * @returns {string} 新的UUID v4格式userKey
   */
  static generate() {
    return uuidv4();
  }

  /**
   * 标准化userKey格式（转为小写）
   * @param {string} userKey - 用户密钥
   * @returns {string} 标准化后的userKey
   */
  static normalize(userKey) {
    if (typeof userKey !== 'string') {
      return '';
    }
    return userKey.toLowerCase();
  }

  /**
   * 验证userKey并返回详细信息
   * @param {string} userKey - 用户密钥
   * @returns {Object} 验证结果
   */
  static validate(userKey) {
    const result = {
      valid: false,
      normalized: '',
      error: null,
      details: {}
    };

    // 检查基本类型
    if (typeof userKey !== 'string') {
      result.error = 'userKey必须是字符串类型';
      return result;
    }

    // 检查长度
    if (userKey.length !== 36) {
      result.error = 'userKey长度必须为36个字符';
      result.details.expectedLength = 36;
      result.details.actualLength = userKey.length;
      return result;
    }

    // 标准化
    const normalized = this.normalize(userKey);
    result.normalized = normalized;

    // 格式验证
    if (!USER_KEY_REGEX.test(normalized)) {
      result.error = 'userKey格式不正确，必须是有效的UUID v4格式';
      result.details.pattern = USER_KEY_REGEX.toString();
      return result;
    }

    // UUID库验证
    if (!uuidValidate(normalized)) {
      result.error = 'userKey不是有效的UUID格式';
      return result;
    }

    // 检查UUID版本
    const version = uuidVersion(normalized);
    if (version !== 4) {
      result.error = `userKey必须是UUID v4格式，当前为v${version}`;
      result.details.expectedVersion = 4;
      result.details.actualVersion = version;
      return result;
    }

    // 验证通过
    result.valid = true;
    result.details.version = version;
    result.details.format = 'UUID v4';

    return result;
  }

  /**
   * 批量验证userKey
   * @param {string[]} userKeys - userKey数组
   * @returns {Object} 批量验证结果
   */
  static validateBatch(userKeys) {
    if (!Array.isArray(userKeys)) {
      return {
        success: false,
        error: 'userKeys必须是数组类型',
        results: []
      };
    }

    const results = userKeys.map((userKey, index) => {
      const validation = this.validate(userKey);
      return {
        index,
        userKey,
        ...validation
      };
    });

    const validResults = results.filter(r => r.valid);
    const invalidResults = results.filter(r => !r.valid);

    return {
      success: invalidResults.length === 0,
      total: userKeys.length,
      validCount: validResults.length,
      invalidCount: invalidResults.length,
      results,
      validUserKeys: validResults.map(r => r.normalized),
      invalidUserKeys: invalidResults.map(r => ({
        userKey: r.userKey,
        error: r.error,
        index: r.index
      }))
    };
  }

  /**
   * 检查userKey是否已存在于数组中
   * @param {string} userKey - 要检查的userKey
   * @param {string[]} userKeyList - userKey列表
   * @returns {boolean} 是否存在
   */
  static existsInList(userKey, userKeyList) {
    if (!this.isValidFormat(userKey) || !Array.isArray(userKeyList)) {
      return false;
    }

    const normalized = this.normalize(userKey);
    const normalizedList = userKeyList.map(key => this.normalize(key));
    
    return normalizedList.includes(normalized);
  }

  /**
   * 从数组中移除重复的userKey
   * @param {string[]} userKeys - userKey数组
   * @returns {string[]} 去重后的userKey数组
   */
  static removeDuplicates(userKeys) {
    if (!Array.isArray(userKeys)) {
      return [];
    }

    const seen = new Set();
    const result = [];

    for (const userKey of userKeys) {
      if (this.isValidFormat(userKey)) {
        const normalized = this.normalize(userKey);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          result.push(normalized);
        }
      }
    }

    return result;
  }

  /**
   * 生成指定数量的userKey
   * @param {number} count - 生成数量
   * @returns {string[]} userKey数组
   */
  static generateBatch(count = 1) {
    if (typeof count !== 'number' || count < 1 || count > 1000) {
      throw new Error('生成数量必须是1-1000之间的数字');
    }

    const userKeys = [];
    for (let i = 0; i < count; i++) {
      userKeys.push(this.generate());
    }

    return userKeys;
  }

  /**
   * 从userKey提取信息
   * @param {string} userKey - 用户密钥
   * @returns {Object} userKey信息
   */
  static extractInfo(userKey) {
    const validation = this.validate(userKey);
    
    if (!validation.valid) {
      return {
        valid: false,
        error: validation.error
      };
    }

    const normalized = validation.normalized;
    
    // 提取时间戳信息（UUID v4没有时间戳，但可以提供格式信息）
    const parts = normalized.split('-');
    
    return {
      valid: true,
      userKey: normalized,
      format: 'UUID v4',
      version: 4,
      parts: {
        timeLow: parts[0],
        timeMid: parts[1],
        timeHiAndVersion: parts[2],
        clockSeqHiAndReserved: parts[3].substring(0, 2),
        clockSeqLow: parts[3].substring(2, 4),
        node: parts[4]
      },
      length: normalized.length,
      createdAt: new Date().toISOString(), // 当前时间，因为UUID v4无法推断创建时间
      isRandomBased: true
    };
  }

  /**
   * 比较两个userKey是否相同
   * @param {string} userKey1 - 第一个userKey
   * @param {string} userKey2 - 第二个userKey
   * @returns {boolean} 是否相同
   */
  static equals(userKey1, userKey2) {
    if (!this.isValidFormat(userKey1) || !this.isValidFormat(userKey2)) {
      return false;
    }

    return this.normalize(userKey1) === this.normalize(userKey2);
  }

  /**
   * 生成userKey的短标识（用于日志显示）
   * @param {string} userKey - 用户密钥
   * @param {number} length - 短标识长度，默认8
   * @returns {string} 短标识
   */
  static toShortId(userKey, length = 8) {
    if (!this.isValidFormat(userKey)) {
      return 'invalid';
    }

    const normalized = this.normalize(userKey);
    return normalized.substring(0, length);
  }

  /**
   * 验证userKey并抛出错误（用于中间件）
   * @param {string} userKey - 用户密钥
   * @throws {Error} 验证失败时抛出错误
   * @returns {string} 标准化的userKey
   */
  static validateOrThrow(userKey) {
    const validation = this.validate(userKey);
    
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    return validation.normalized;
  }

  /**
   * 检查userKey是否接近过期（仅适用于有过期时间的场景）
   * @param {Date} expiresAt - 过期时间
   * @param {number} warningDays - 提前警告天数，默认7天
   * @returns {Object} 过期检查结果
   */
  static checkExpiration(expiresAt, warningDays = 7) {
    if (!expiresAt || !(expiresAt instanceof Date)) {
      return {
        isExpired: false,
        isNearExpiry: false,
        daysUntilExpiry: null,
        message: '无过期时间限制'
      };
    }

    const now = new Date();
    const timeDiff = expiresAt.getTime() - now.getTime();
    const daysUntilExpiry = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

    return {
      isExpired: daysUntilExpiry < 0,
      isNearExpiry: daysUntilExpiry > 0 && daysUntilExpiry <= warningDays,
      daysUntilExpiry,
      expiresAt,
      message: daysUntilExpiry < 0 
        ? `已过期 ${Math.abs(daysUntilExpiry)} 天`
        : daysUntilExpiry === 0 
        ? '今天过期'
        : daysUntilExpiry <= warningDays
        ? `${daysUntilExpiry} 天后过期`
        : '有效期充足'
    };
  }
}

module.exports = UserKeyUtils;