const logger = require('../utils/logger');
const HashUtils = require('../utils/hashUtils');
const UserKeyUtils = require('../utils/userKeyUtils');
const { CACHE_CONFIG, SYNC_CONFIG } = require('../config/constants');

/**
 * 缓存服务
 * 提供内存缓存功能，减少数据库查询，提升性能
 */
class CacheService {
  constructor() {
    this.enabled = CACHE_CONFIG.ENABLED;
    this.defaultTTL = CACHE_CONFIG.TTL * 1000; // 转换为毫秒
    this.maxSize = CACHE_CONFIG.MAX_SIZE;
    
    // 缓存存储
    this.cache = new Map();
    this.timestamps = new Map();
    this.accessTimes = new Map();
    
    // 统计信息
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      startTime: Date.now()
    };
    
    if (!this.enabled) {
      logger.info('缓存服务已禁用');
      return;
    }
    
    logger.info('缓存服务已启动', {
      enabled: this.enabled,
      defaultTTL: `${CACHE_CONFIG.TTL}s`,
      maxSize: this.maxSize
    });
    
    // 定期清理过期缓存
    this.startCleanupTimer();
  }

  /**
   * 生成缓存键
   * @param {string} type - 缓存类型
   * @param {string} userKey - 用户密钥
   * @param {string} identifier - 标识符
   * @returns {string} 缓存键
   */
  generateKey(type, userKey, identifier = '') {
    const shortUserKey = UserKeyUtils.toShortId(userKey);
    return identifier ? `${type}:${shortUserKey}:${identifier}` : `${type}:${shortUserKey}`;
  }

  /**
   * 设置缓存
   * @param {string} key - 缓存键
   * @param {any} value - 缓存值
   * @param {number} ttl - 过期时间（毫秒）
   * @returns {boolean} 是否成功
   */
  set(key, value, ttl = this.defaultTTL) {
    if (!this.enabled) {
      return false;
    }

    try {
      // 检查是否需要清理空间
      if (this.cache.size >= this.maxSize) {
        this.evictLRU();
      }

      const expiresAt = Date.now() + ttl;
      
      this.cache.set(key, value);
      this.timestamps.set(key, expiresAt);
      this.accessTimes.set(key, Date.now());
      
      this.stats.sets++;
      
      logger.debug('缓存设置', {
        key: key.length > 50 ? key.substring(0, 50) + '...' : key,
        ttl: `${ttl}ms`,
        cacheSize: this.cache.size
      });
      
      return true;
      
    } catch (error) {
      logger.error('设置缓存失败', {
        key,
        error: error.message
      });
      return false;
    }
  }

  /**
   * 获取缓存
   * @param {string} key - 缓存键
   * @returns {any|null} 缓存值
   */
  get(key) {
    if (!this.enabled) {
      return null;
    }

    try {
      if (!this.cache.has(key)) {
        this.stats.misses++;
        return null;
      }

      const expiresAt = this.timestamps.get(key);
      const now = Date.now();

      // 检查是否过期
      if (now > expiresAt) {
        this.delete(key);
        this.stats.misses++;
        return null;
      }

      // 更新访问时间
      this.accessTimes.set(key, now);
      this.stats.hits++;

      const value = this.cache.get(key);
      
      logger.debug('缓存命中', {
        key: key.length > 50 ? key.substring(0, 50) + '...' : key,
        remainingTTL: `${Math.round((expiresAt - now) / 1000)}s`
      });
      
      return value;
      
    } catch (error) {
      logger.error('获取缓存失败', {
        key,
        error: error.message
      });
      this.stats.misses++;
      return null;
    }
  }

  /**
   * 删除缓存
   * @param {string} key - 缓存键
   * @returns {boolean} 是否成功
   */
  delete(key) {
    if (!this.enabled) {
      return false;
    }

    try {
      const existed = this.cache.has(key);
      
      this.cache.delete(key);
      this.timestamps.delete(key);
      this.accessTimes.delete(key);
      
      if (existed) {
        this.stats.deletes++;
        
        logger.debug('缓存删除', {
          key: key.length > 50 ? key.substring(0, 50) + '...' : key
        });
      }
      
      return existed;
      
    } catch (error) {
      logger.error('删除缓存失败', {
        key,
        error: error.message
      });
      return false;
    }
  }

  /**
   * 检查缓存是否存在且未过期
   * @param {string} key - 缓存键
   * @returns {boolean} 是否存在
   */
  has(key) {
    if (!this.enabled) {
      return false;
    }

    if (!this.cache.has(key)) {
      return false;
    }

    const expiresAt = this.timestamps.get(key);
    if (Date.now() > expiresAt) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 清空所有缓存
   */
  clear() {
    if (!this.enabled) {
      return;
    }

    const size = this.cache.size;
    
    this.cache.clear();
    this.timestamps.clear();
    this.accessTimes.clear();
    
    logger.info('缓存已清空', { clearedCount: size });
  }

  /**
   * 按前缀删除缓存
   * @param {string} prefix - 键前缀
   * @returns {number} 删除的数量
   */
  deleteByPrefix(prefix) {
    if (!this.enabled) {
      return 0;
    }

    let deletedCount = 0;
    
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key);
        deletedCount++;
      }
    }
    
    logger.debug('按前缀删除缓存', {
      prefix,
      deletedCount
    });
    
    return deletedCount;
  }

  /**
   * LRU eviction - 删除最近最少使用的缓存项
   */
  evictLRU() {
    if (this.cache.size === 0) {
      return;
    }

    let oldestKey = null;
    let oldestTime = Date.now();

    // 找到最久未访问的键
    for (const [key, accessTime] of this.accessTimes.entries()) {
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey);
      this.stats.evictions++;
      
      logger.debug('LRU淘汰缓存', {
        key: oldestKey.length > 50 ? oldestKey.substring(0, 50) + '...' : oldestKey,
        accessTime: new Date(oldestTime).toISOString()
      });
    }
  }

  /**
   * 定期清理过期缓存
   */
  startCleanupTimer() {
    if (!this.enabled) {
      return;
    }

    const cleanupInterval = Math.min(this.defaultTTL / 4, 60000); // 最多1分钟清理一次
    
    setInterval(() => {
      this.cleanupExpired();
    }, cleanupInterval);
    
    logger.debug('缓存清理定时器已启动', {
      interval: `${cleanupInterval}ms`
    });
  }

  /**
   * 清理过期缓存
   */
  cleanupExpired() {
    if (!this.enabled) {
      return;
    }

    const now = Date.now();
    let expiredCount = 0;

    for (const [key, expiresAt] of this.timestamps.entries()) {
      if (now > expiresAt) {
        this.delete(key);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logger.debug('清理过期缓存', {
        expiredCount,
        remainingCount: this.cache.size
      });
    }
  }

  /**
   * 获取缓存统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    const now = Date.now();
    const runtime = now - this.stats.startTime;
    const total = this.stats.hits + this.stats.misses;
    
    return {
      enabled: this.enabled,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%',
      stats: {
        ...this.stats,
        runtime: `${Math.round(runtime / 1000)}s`
      },
      memory: {
        used: this.cache.size,
        max: this.maxSize,
        utilization: `${(this.cache.size / this.maxSize * 100).toFixed(1)}%`
      }
    };
  }

  // === 业务相关的缓存方法 ===

  /**
   * 缓存用户元数据
   * @param {string} userKey - 用户密钥
   * @param {Object} metadata - 元数据
   * @param {number} ttl - 过期时间
   */
  setUserMeta(userKey, metadata, ttl = this.defaultTTL) {
    const key = this.generateKey('user_meta', userKey);
    return this.set(key, metadata, ttl);
  }

  /**
   * 获取用户元数据
   * @param {string} userKey - 用户密钥
   * @returns {Object|null} 元数据
   */
  getUserMeta(userKey) {
    const key = this.generateKey('user_meta', userKey);
    return this.get(key);
  }

  /**
   * 缓存差异会话
   * @param {string} sessionId - 会话ID
   * @param {Object} sessionData - 会话数据
   * @param {number} ttl - 过期时间
   */
  setDiffSession(sessionId, sessionData, ttl = SYNC_CONFIG.DIFF_SESSION_TTL * 1000) {
    const key = `diff_session:${sessionId}`;
    return this.set(key, sessionData, ttl);
  }

  /**
   * 获取差异会话
   * @param {string} sessionId - 会话ID
   * @returns {Object|null} 会话数据
   */
  getDiffSession(sessionId) {
    const key = `diff_session:${sessionId}`;
    return this.get(key);
  }

  /**
   * 删除差异会话
   * @param {string} sessionId - 会话ID
   */
  deleteDiffSession(sessionId) {
    const key = `diff_session:${sessionId}`;
    return this.delete(key);
  }

  /**
   * 缓存MD5存在性检查结果
   * @param {string} userKey - 用户密钥
   * @param {string} md5Hash - MD5数组的哈希
   * @param {Object} result - 检查结果
   * @param {number} ttl - 过期时间
   */
  setMd5ExistCheck(userKey, md5Hash, result, ttl = 300000) { // 5分钟
    const key = this.generateKey('md5_exist', userKey, md5Hash);
    return this.set(key, result, ttl);
  }

  /**
   * 获取MD5存在性检查结果
   * @param {string} userKey - 用户密钥
   * @param {string} md5Hash - MD5数组的哈希
   * @returns {Object|null} 检查结果
   */
  getMd5ExistCheck(userKey, md5Hash) {
    const key = this.generateKey('md5_exist', userKey, md5Hash);
    return this.get(key);
  }

  /**
   * 缓存集合哈希
   * @param {string} userKey - 用户密钥
   * @param {string} collectionHash - 集合哈希
   * @param {number} ttl - 过期时间
   */
  setCollectionHash(userKey, collectionHash, ttl = this.defaultTTL) {
    const key = this.generateKey('collection_hash', userKey);
    return this.set(key, collectionHash, ttl);
  }

  /**
   * 获取集合哈希
   * @param {string} userKey - 用户密钥
   * @returns {string|null} 集合哈希
   */
  getCollectionHash(userKey) {
    const key = this.generateKey('collection_hash', userKey);
    return this.get(key);
  }

  /**
   * 清除用户相关的所有缓存
   * @param {string} userKey - 用户密钥
   * @returns {number} 删除的数量
   */
  clearUserCache(userKey) {
    const shortUserKey = UserKeyUtils.toShortId(userKey);
    return this.deleteByPrefix(`user_meta:${shortUserKey}`) +
           this.deleteByPrefix(`md5_exist:${shortUserKey}`) +
           this.deleteByPrefix(`collection_hash:${shortUserKey}`);
  }

  /**
   * 预热缓存
   * @param {string} userKey - 用户密钥
   * @param {Object} data - 预热数据
   */
  async warmupCache(userKey, data = {}) {
    if (!this.enabled) {
      return;
    }

    try {
      const { metadata, collectionHash } = data;
      
      if (metadata) {
        this.setUserMeta(userKey, metadata);
      }
      
      if (collectionHash) {
        this.setCollectionHash(userKey, collectionHash);
      }
      
      logger.debug('缓存预热完成', {
        userKey: UserKeyUtils.toShortId(userKey),
        warmedData: Object.keys(data)
      });
      
    } catch (error) {
      logger.error('缓存预热失败', {
        userKey: UserKeyUtils.toShortId(userKey),
        error: error.message
      });
    }
  }
}

// 创建单例实例
const cacheService = new CacheService();

module.exports = cacheService;