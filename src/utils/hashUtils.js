const crypto = require('crypto');
const { SYNC_CONFIG } = require('../config/constants');

/**
 * 哈希计算工具类
 */
class HashUtils {
  /**
   * 计算字符串的哈希值
   * @param {string} data - 要计算哈希的数据
   * @param {string} algorithm - 哈希算法，默认为sha256
   * @returns {string} 十六进制哈希值
   */
  static hash(data, algorithm = SYNC_CONFIG.HASH_ALGORITHM) {
    try {
      return crypto
        .createHash(algorithm)
        .update(data, 'utf8')
        .digest('hex');
    } catch (error) {
      throw new Error(`哈希计算失败: ${error.message}`);
    }
  }

  /**
   * 计算MD5数组的集合哈希
   * @param {string[]} md5Array - MD5数组
   * @returns {string} 集合哈希值
   */
  static calculateCollectionHash(md5Array) {
    if (!Array.isArray(md5Array)) {
      throw new Error('MD5数组参数无效');
    }

    if (md5Array.length === 0) {
      return this.hash('');
    }

    // 排序以确保相同集合产生相同哈希
    const sortedMd5s = [...md5Array]
      .map(md5 => md5.toLowerCase())
      .sort();

    // 连接所有MD5值
    const concatenated = sortedMd5s.join('');
    
    return this.hash(concatenated);
  }

  /**
   * 验证MD5格式是否正确
   * @param {string} md5 - MD5字符串
   * @returns {boolean} 是否为有效的MD5格式
   */
  static isValidMd5(md5) {
    if (typeof md5 !== 'string') {
      return false;
    }
    
    return /^[a-f0-9]{32}$/i.test(md5);
  }

  /**
   * 验证MD5数组
   * @param {string[]} md5Array - MD5数组
   * @returns {Object} 验证结果
   */
  static validateMd5Array(md5Array) {
    if (!Array.isArray(md5Array)) {
      return {
        valid: false,
        error: 'MD5数组格式无效',
        invalidItems: []
      };
    }

    const invalidItems = [];
    const validItems = [];

    md5Array.forEach((md5, index) => {
      if (this.isValidMd5(md5)) {
        validItems.push(md5.toLowerCase());
      } else {
        invalidItems.push({
          index,
          value: md5,
          reason: '不是有效的32位十六进制MD5值'
        });
      }
    });

    return {
      valid: invalidItems.length === 0,
      validCount: validItems.length,
      invalidCount: invalidItems.length,
      invalidItems,
      validItems
    };
  }

  /**
   * 计算两个集合的差异
   * @param {string[]} set1 - 第一个集合
   * @param {string[]} set2 - 第二个集合
   * @returns {Object} 差异结果
   */
  static calculateSetDifference(set1, set2) {
    const normalizedSet1 = new Set(set1.map(item => item.toLowerCase()));
    const normalizedSet2 = new Set(set2.map(item => item.toLowerCase()));

    // set1中有但set2中没有的
    const onlyInSet1 = [...normalizedSet1].filter(item => !normalizedSet2.has(item));
    
    // set2中有但set1中没有的
    const onlyInSet2 = [...normalizedSet2].filter(item => !normalizedSet1.has(item));
    
    // 两个集合的交集
    const intersection = [...normalizedSet1].filter(item => normalizedSet2.has(item));

    return {
      onlyInSet1,
      onlyInSet2,
      intersection,
      set1Count: normalizedSet1.size,
      set2Count: normalizedSet2.size,
      intersectionCount: intersection.length,
      unionCount: normalizedSet1.size + normalizedSet2.size - intersection.length
    };
  }

  /**
   * 生成随机哈希
   * @param {number} length - 哈希长度
   * @returns {string} 随机哈希值
   */
  static generateRandomHash(length = 32) {
    return crypto
      .randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length);
  }

  /**
   * 计算数据的MD5哈希
   * @param {string} data - 要计算的数据
   * @returns {string} MD5哈希值
   */
  static md5(data) {
    return crypto
      .createHash('md5')
      .update(data, 'utf8')
      .digest('hex');
  }

  /**
   * 计算数据的SHA1哈希
   * @param {string} data - 要计算的数据
   * @returns {string} SHA1哈希值
   */
  static sha1(data) {
    return crypto
      .createHash('sha1')
      .update(data, 'utf8')
      .digest('hex');
  }

  /**
   * 计算数据的SHA256哈希
   * @param {string} data - 要计算的数据
   * @returns {string} SHA256哈希值
   */
  static sha256(data) {
    return crypto
      .createHash('sha256')
      .update(data, 'utf8')
      .digest('hex');
  }

  /**
   * 比较两个哈希值是否相等（时间恒定比较，防止时序攻击）
   * @param {string} hash1 - 第一个哈希值
   * @param {string} hash2 - 第二个哈希值
   * @returns {boolean} 是否相等
   */
  static secureCompare(hash1, hash2) {
    if (typeof hash1 !== 'string' || typeof hash2 !== 'string') {
      return false;
    }

    if (hash1.length !== hash2.length) {
      return false;
    }

    // 使用crypto.timingSafeEqual进行恒定时间比较
    try {
      return crypto.timingSafeEqual(
        Buffer.from(hash1, 'hex'),
        Buffer.from(hash2, 'hex')
      );
    } catch (error) {
      return false;
    }
  }

  /**
   * 创建HMAC哈希
   * @param {string} data - 要计算的数据
   * @param {string} secret - 密钥
   * @param {string} algorithm - 算法，默认为sha256
   * @returns {string} HMAC哈希值
   */
  static hmac(data, secret, algorithm = 'sha256') {
    try {
      return crypto
        .createHmac(algorithm, secret)
        .update(data, 'utf8')
        .digest('hex');
    } catch (error) {
      throw new Error(`HMAC计算失败: ${error.message}`);
    }
  }

  /**
   * 对MD5数组进行去重和排序
   * @param {string[]} md5Array - MD5数组
   * @returns {string[]} 去重排序后的MD5数组
   */
  static deduplicateAndSort(md5Array) {
    if (!Array.isArray(md5Array)) {
      return [];
    }

    const uniqueSet = new Set(md5Array.map(md5 => md5.toLowerCase()));
    return [...uniqueSet].sort();
  }

  /**
   * 计算数组的快速哈希（用于布隆过滤器等场景）
   * @param {string[]} array - 字符串数组
   * @returns {string} 快速哈希值
   */
  static quickHash(array) {
    if (!Array.isArray(array) || array.length === 0) {
      return '0';
    }

    let hash = 0;
    const str = array.join('|');
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 转换为32位整数
    }
    
    return Math.abs(hash).toString(16);
  }

  /**
   * 生成用于API的签名
   * @param {Object} params - 参数对象
   * @param {string} secret - 密钥
   * @returns {string} API签名
   */
  static generateApiSignature(params, secret) {
    // 按键名排序
    const sortedKeys = Object.keys(params).sort();
    
    // 构造查询字符串
    const queryString = sortedKeys
      .map(key => `${key}=${params[key]}`)
      .join('&');
    
    // 生成HMAC签名
    return this.hmac(queryString, secret);
  }

  /**
   * 验证API签名
   * @param {Object} params - 参数对象
   * @param {string} signature - 提供的签名
   * @param {string} secret - 密钥
   * @returns {boolean} 签名是否有效
   */
  static verifyApiSignature(params, signature, secret) {
    const expectedSignature = this.generateApiSignature(params, secret);
    return this.secureCompare(expectedSignature, signature);
  }
}

module.exports = HashUtils;