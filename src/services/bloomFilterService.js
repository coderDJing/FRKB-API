const { BloomFilter } = require('bloom-filters');
const UserCollectionMeta = require('../models/UserCollectionMeta');
const UserMd5Collection = require('../models/UserMd5Collection');
const HashUtils = require('../utils/hashUtils');
const logger = require('../utils/logger');
const { BLOOM_FILTER } = require('../config/constants');

/**
 * 布隆过滤器服务
 * 用于快速判断MD5是否可能存在，减少数据库查询次数
 */
class BloomFilterService {
  constructor() {
    this.filters = new Map(); // userKey -> BloomFilter
    this.filterMetas = new Map(); // userKey -> { size, hashFunctions, createdAt, version }
    this.enabled = BLOOM_FILTER.ENABLED;
    
    if (!this.enabled) {
      logger.info('布隆过滤器已禁用');
    }
  }

  /**
   * 创建布隆过滤器
   * @param {number} expectedElements - 预期元素数量
   * @param {number} falsePositiveRate - 误报率
   * @returns {BloomFilter} 布隆过滤器实例
   */
  createFilter(expectedElements, falsePositiveRate = BLOOM_FILTER.FALSE_POSITIVE_RATE) {
    try {
      const filter = new BloomFilter(expectedElements, falsePositiveRate);
      
      logger.info('创建布隆过滤器', {
        expectedElements,
        falsePositiveRate,
        actualSize: filter.bits.length,
        hashFunctions: filter.nbHashes
      });
      
      return filter;
    } catch (error) {
      logger.error('创建布隆过滤器失败', {
        error: error.message,
        expectedElements,
        falsePositiveRate
      });
      throw error;
    }
  }

  /**
   * 为用户初始化布隆过滤器
   * @param {string} userKey - 用户密钥
   * @param {boolean} forceRebuild - 是否强制重建
   * @returns {Promise<BloomFilter>} 布隆过滤器实例
   */
  async initializeFilter(userKey, forceRebuild = false) {
    if (!this.enabled) {
      return null;
    }

    try {
      // 检查是否已有缓存的过滤器
      if (!forceRebuild && this.filters.has(userKey)) {
        const filter = this.filters.get(userKey);
        const meta = this.filterMetas.get(userKey);
        
        logger.debug('使用缓存的布隆过滤器', {
          userKey: userKey.substring(0, 8) + '***',
          size: meta?.size || 'unknown',
          createdAt: meta?.createdAt
        });
        
        return filter;
      }

      // 获取用户的MD5数量
      const count = await UserMd5Collection.getUserMd5Count(userKey);
      
      if (count === 0) {
        logger.debug('用户无MD5数据，跳过布隆过滤器初始化', {
          userKey: userKey.substring(0, 8) + '***'
        });
        return null;
      }

      // 创建新的布隆过滤器
      const expectedElements = Math.max(count * 1.2, 1000); // 预留20%空间
      const filter = this.createFilter(expectedElements);

      // 分批加载MD5数据
      const batchSize = 10000;
      let skip = 0;
      let totalLoaded = 0;
      
      logger.info('开始构建布隆过滤器', {
        userKey: userKey.substring(0, 8) + '***',
        totalMd5s: count,
        expectedElements,
        batchSize
      });

      while (skip < count) {
        const md5s = await UserMd5Collection
          .find({ userKey })
          .select('md5')
          .skip(skip)
          .limit(batchSize)
          .lean();

        for (const doc of md5s) {
          filter.add(doc.md5);
          totalLoaded++;
        }

        skip += batchSize;
        
        // 每加载1万条记录输出一次进度
        if (totalLoaded % 10000 === 0) {
          logger.debug('布隆过滤器构建进度', {
            userKey: userKey.substring(0, 8) + '***',
            loaded: totalLoaded,
            total: count,
            progress: `${(totalLoaded / count * 100).toFixed(1)}%`
          });
        }
      }

      // 缓存过滤器和元数据
      this.filters.set(userKey, filter);
      this.filterMetas.set(userKey, {
        size: filter.bits.length,
        hashFunctions: filter.nbHashes,
        createdAt: new Date(),
        version: 1,
        elementCount: totalLoaded
      });

      logger.info('布隆过滤器构建完成', {
        userKey: userKey.substring(0, 8) + '***',
        loadedElements: totalLoaded,
        filterSize: filter.bits.length,
        hashFunctions: filter.nbHashes,
        estimatedFalsePositiveRate: BLOOM_FILTER.FALSE_POSITIVE_RATE
      });

      // 异步保存到数据库
      this.saveFilterToDatabase(userKey, filter).catch(error => {
        logger.error('保存布隆过滤器到数据库失败', {
          userKey: userKey.substring(0, 8) + '***',
          error: error.message
        });
      });

      return filter;

    } catch (error) {
      logger.error('初始化布隆过滤器失败', {
        userKey: userKey.substring(0, 8) + '***',
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * 检查MD5是否可能存在
   * @param {string} userKey - 用户密钥
   * @param {string} md5 - MD5值
   * @returns {Promise<Object>} 检查结果
   */
  async mightContain(userKey, md5) {
    if (!this.enabled) {
      return { possible: true, source: 'bloom_disabled' };
    }

    try {
      let filter = this.filters.get(userKey);
      
      // 如果没有过滤器，尝试初始化
      if (!filter) {
        filter = await this.initializeFilter(userKey);
        
        if (!filter) {
          return { possible: false, source: 'no_data' };
        }
      }

      const possible = filter.has(md5.toLowerCase());
      
      return {
        possible,
        source: 'bloom_filter',
        meta: this.filterMetas.get(userKey)
      };

    } catch (error) {
      logger.error('布隆过滤器检查失败', {
        userKey: userKey.substring(0, 8) + '***',
        md5: md5.substring(0, 8) + '***',
        error: error.message
      });
      
      // 出错时返回可能存在，避免误过滤
      return { possible: true, source: 'error_fallback' };
    }
  }

  /**
   * 批量检查MD5是否可能存在
   * @param {string} userKey - 用户密钥
   * @param {string[]} md5Array - MD5数组
   * @returns {Promise<Object>} 批量检查结果
   */
  async batchMightContain(userKey, md5Array) {
    if (!this.enabled) {
      return {
        possible: md5Array.map(md5 => ({ md5, possible: true, source: 'bloom_disabled' })),
        summary: { total: md5Array.length, possible: md5Array.length, impossible: 0 }
      };
    }

    try {
      let filter = this.filters.get(userKey);
      
      if (!filter) {
        filter = await this.initializeFilter(userKey);
        
        if (!filter) {
          return {
            possible: md5Array.map(md5 => ({ md5, possible: false, source: 'no_data' })),
            summary: { total: md5Array.length, possible: 0, impossible: md5Array.length }
          };
        }
      }

      const results = md5Array.map(md5 => ({
        md5,
        possible: filter.has(md5.toLowerCase()),
        source: 'bloom_filter'
      }));

      const possibleCount = results.filter(r => r.possible).length;
      const impossibleCount = results.length - possibleCount;

      logger.debug('布隆过滤器批量检查', {
        userKey: userKey.substring(0, 8) + '***',
        total: md5Array.length,
        possible: possibleCount,
        impossible: impossibleCount,
        filteredRatio: `${(impossibleCount / md5Array.length * 100).toFixed(1)}%`
      });

      return {
        possible: results,
        summary: {
          total: md5Array.length,
          possible: possibleCount,
          impossible: impossibleCount,
          filteredRatio: impossibleCount / md5Array.length
        },
        meta: this.filterMetas.get(userKey)
      };

    } catch (error) {
      logger.error('布隆过滤器批量检查失败', {
        userKey: userKey.substring(0, 8) + '***',
        count: md5Array.length,
        error: error.message
      });
      
      // 出错时返回全部可能存在
      return {
        possible: md5Array.map(md5 => ({ md5, possible: true, source: 'error_fallback' })),
        summary: { total: md5Array.length, possible: md5Array.length, impossible: 0 }
      };
    }
  }

  /**
   * 向过滤器添加新的MD5
   * @param {string} userKey - 用户密钥
   * @param {string[]} md5Array - MD5数组
   * @returns {Promise<boolean>} 是否成功
   */
  async addMd5s(userKey, md5Array) {
    if (!this.enabled) {
      return true;
    }

    try {
      let filter = this.filters.get(userKey);
      
      if (!filter) {
        // 如果没有过滤器，先初始化
        filter = await this.initializeFilter(userKey);
        
        if (!filter) {
          // 创建新的过滤器
          const expectedElements = Math.max(md5Array.length * 10, 1000);
          filter = this.createFilter(expectedElements);
          this.filters.set(userKey, filter);
          this.filterMetas.set(userKey, {
            size: filter.bits.length,
            hashFunctions: filter.nbHashes,
            createdAt: new Date(),
            version: 1,
            elementCount: 0
          });
        }
      }

      // 添加MD5到过滤器
      for (const md5 of md5Array) {
        filter.add(md5.toLowerCase());
      }

      // 更新元数据
      const meta = this.filterMetas.get(userKey);
      if (meta) {
        meta.elementCount += md5Array.length;
        meta.lastUpdatedAt = new Date();
      }

      logger.debug('向布隆过滤器添加MD5', {
        userKey: userKey.substring(0, 8) + '***',
        addedCount: md5Array.length,
        totalElements: meta?.elementCount || 'unknown'
      });

      return true;

    } catch (error) {
      logger.error('向布隆过滤器添加MD5失败', {
        userKey: userKey.substring(0, 8) + '***',
        count: md5Array.length,
        error: error.message
      });
      return false;
    }
  }

  /**
   * 清除用户的布隆过滤器
   * @param {string} userKey - 用户密钥
   */
  clearFilter(userKey) {
    if (this.filters.has(userKey)) {
      this.filters.delete(userKey);
      this.filterMetas.delete(userKey);
      
      logger.info('清除用户布隆过滤器', {
        userKey: userKey.substring(0, 8) + '***'
      });
    }
  }

  /**
   * 获取过滤器统计信息
   * @param {string} userKey - 用户密钥
   * @returns {Object|null} 统计信息
   */
  getFilterStats(userKey) {
    if (!this.enabled) {
      return { enabled: false };
    }

    const filter = this.filters.get(userKey);
    const meta = this.filterMetas.get(userKey);
    
    if (!filter || !meta) {
      return null;
    }

    return {
      enabled: true,
      size: meta.size,
      hashFunctions: meta.hashFunctions,
      elementCount: meta.elementCount,
      createdAt: meta.createdAt,
      lastUpdatedAt: meta.lastUpdatedAt,
      version: meta.version,
      estimatedFalsePositiveRate: BLOOM_FILTER.FALSE_POSITIVE_RATE,
      memoryUsage: `${(meta.size / 8 / 1024).toFixed(2)} KB`
    };
  }

  /**
   * 保存过滤器到数据库
   * @param {string} userKey - 用户密钥
   * @param {BloomFilter} filter - 布隆过滤器
   * @returns {Promise<boolean>} 是否成功
   */
  async saveFilterToDatabase(userKey, filter) {
    try {
      const meta = await UserCollectionMeta.getOrCreate(userKey);
      
      // 将过滤器序列化为Buffer
      const filterData = Buffer.from(filter.saveAsJSON());
      
      meta.bloomFilter = filterData;
      await meta.save();
      
      logger.debug('布隆过滤器已保存到数据库', {
        userKey: userKey.substring(0, 8) + '***',
        dataSize: `${(filterData.length / 1024).toFixed(2)} KB`
      });
      
      return true;
      
    } catch (error) {
      logger.error('保存布隆过滤器到数据库失败', {
        userKey: userKey.substring(0, 8) + '***',
        error: error.message
      });
      return false;
    }
  }

  /**
   * 从数据库加载过滤器
   * @param {string} userKey - 用户密钥
   * @returns {Promise<BloomFilter|null>} 布隆过滤器实例
   */
  async loadFilterFromDatabase(userKey) {
    if (!this.enabled) {
      return null;
    }

    try {
      const meta = await UserCollectionMeta.findOne({ userKey });
      
      if (!meta || !meta.bloomFilter) {
        return null;
      }

      // 从Buffer反序列化过滤器
      const filterJSON = meta.bloomFilter.toString();
      const filter = BloomFilter.fromJSON(JSON.parse(filterJSON));
      
      // 缓存过滤器
      this.filters.set(userKey, filter);
      this.filterMetas.set(userKey, {
        size: filter.bits.length,
        hashFunctions: filter.nbHashes,
        createdAt: meta.createdAt,
        version: 1,
        elementCount: meta.totalCount || 0
      });
      
      logger.info('从数据库加载布隆过滤器', {
        userKey: userKey.substring(0, 8) + '***',
        size: filter.bits.length,
        hashFunctions: filter.nbHashes
      });
      
      return filter;
      
    } catch (error) {
      logger.error('从数据库加载布隆过滤器失败', {
        userKey: userKey.substring(0, 8) + '***',
        error: error.message
      });
      return null;
    }
  }

  /**
   * 获取全局统计信息
   * @returns {Object} 全局统计
   */
  getGlobalStats() {
    const stats = {
      enabled: this.enabled,
      totalFilters: this.filters.size,
      totalMemoryUsage: 0,
      averageSize: 0,
      filters: []
    };

    if (!this.enabled) {
      return stats;
    }

    for (const [userKey, meta] of this.filterMetas.entries()) {
      const filterStats = {
        userKey: userKey.substring(0, 8) + '***',
        size: meta.size,
        elementCount: meta.elementCount,
        memoryUsage: meta.size / 8 // 字节
      };
      
      stats.filters.push(filterStats);
      stats.totalMemoryUsage += filterStats.memoryUsage;
    }

    if (stats.filters.length > 0) {
      stats.averageSize = stats.totalMemoryUsage / stats.filters.length;
    }

    stats.totalMemoryUsage = `${(stats.totalMemoryUsage / 1024).toFixed(2)} KB`;
    stats.averageSize = `${(stats.averageSize / 1024).toFixed(2)} KB`;

    return stats;
  }
}

// 创建单例实例
const bloomFilterService = new BloomFilterService();

module.exports = bloomFilterService;