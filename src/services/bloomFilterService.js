const { BloomFilter } = require('bloom-filters');
const UserCollectionMeta = require('../models/UserCollectionMeta');
const UserFingerprintCollection = require('../models/UserFingerprintCollection');
const HashUtils = require('../utils/hashUtils');
const logger = require('../utils/logger');
const { BLOOM_FILTER } = require('../config/constants');

/**
 * 布隆过滤器服务
 * 用于快速判断指纹是否可能存在，减少数据库查询次数
 * 按 (userKey, mode) 维度管理过滤器
 */
class BloomFilterService {
  constructor() {
    this.filters = new Map(); // `${userKey}:${mode}` -> BloomFilter
    this.filterMetas = new Map(); // `${userKey}:${mode}` -> { size, hashFunctions, createdAt, version }
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
      // 根据期望元素数量和误报率计算最优参数
      const n = expectedElements;
      const p = falsePositiveRate;
      
      // 计算位数组大小: m = -n * ln(p) / (ln(2))^2
      const bitSize = Math.ceil(-n * Math.log(p) / (Math.log(2) * Math.log(2)));
      
      // 计算哈希函数数量: k = (m/n) * ln(2)
      const hashFunctions = Math.ceil((bitSize / n) * Math.log(2));
      
      // 确保哈希函数数量至少为1
      const finalHashFunctions = Math.max(1, hashFunctions);
      
      logger.info('布隆过滤器参数计算', {
        expectedElements: n,
        falsePositiveRate: p,
        calculatedBitSize: bitSize,
        calculatedHashFunctions: hashFunctions,
        finalHashFunctions
      });
      
      // 使用计算出的参数创建布隆过滤器
      const filter = new BloomFilter(n, finalHashFunctions, bitSize);
      
      logger.info('创建布隆过滤器成功', {
        expectedElements: n,
        falsePositiveRate: p,
        actualBitSize: filter.bits.length,
        actualHashFunctions: filter.nbHashes
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
   * 生成过滤器键
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @returns {string} 过滤器键
   */
  generateFilterKey(userKey, mode) {
    return `${userKey}:${mode}`;
  }

  /**
   * 为用户和模式初始化布隆过滤器
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @param {boolean} forceRebuild - 是否强制重建
   * @returns {Promise<BloomFilter>} 布隆过滤器实例
   */
  async initializeFilter(userKey, mode, forceRebuild = false) {
    if (!this.enabled) {
      return null;
    }

    try {
      const filterKey = this.generateFilterKey(userKey, mode);
      
      // 检查是否已有缓存的过滤器
      if (!forceRebuild && this.filters.has(filterKey)) {
        const filter = this.filters.get(filterKey);
        const meta = this.filterMetas.get(filterKey);
        
        logger.debug('使用缓存的布隆过滤器', {
          userKey: userKey.substring(0, 8) + '***',
          mode,
          size: meta?.size || 'unknown',
          createdAt: meta?.createdAt
        });
        
        return filter;
      }

      // 获取用户指纹数量（按 mode）
      const count = await UserFingerprintCollection.getUserFingerprintCount(userKey, mode);
      
      if (count === 0) {
        logger.debug('用户无指纹数据，跳过布隆过滤器初始化', {
          userKey: userKey.substring(0, 8) + '***',
          mode
        });
        return null;
      }

      // 创建新的布隆过滤器
      // 使用更保守的容量预估策略，考虑未来增长
      const baseCapacity = Math.max(count * BLOOM_FILTER.BASE_MULTIPLIER, 1000); // 基于当前数据预留空间
      const growthCapacity = Math.max(count * BLOOM_FILTER.GROWTH_MULTIPLIER, BLOOM_FILTER.MIN_CAPACITY); // 考虑增长空间
      const expectedElements = Math.max(baseCapacity, growthCapacity);
      
      logger.info('布隆过滤器容量计算', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        currentCount: count,
        baseCapacity,
        growthCapacity,
        finalExpectedElements: expectedElements
      });
      
      const filter = this.createFilter(expectedElements);

      // 分批加载指纹数据
      const batchSize = 10000;
      let skip = 0;
      let totalLoaded = 0;
      
      logger.info('开始构建布隆过滤器', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        totalFingerprints: count,
        expectedElements,
        batchSize
      });

      while (skip < count) {
        const docs = await UserFingerprintCollection
          .find({ userKey, mode })
          .select('fingerprint')
          .skip(skip)
          .limit(batchSize)
          .lean();

        for (const doc of docs) {
          filter.add(doc.fingerprint);
          totalLoaded++;
        }

        skip += batchSize;
        
        // 每加载1万条记录输出一次进度
        if (totalLoaded % 10000 === 0) {
          logger.debug('布隆过滤器构建进度', {
            userKey: userKey.substring(0, 8) + '***',
            mode,
            loaded: totalLoaded,
            total: count,
            progress: `${(totalLoaded / count * 100).toFixed(1)}%`
          });
        }
      }

      // 缓存过滤器和元数据
      this.filters.set(filterKey, filter);
      this.filterMetas.set(filterKey, {
        size: filter.bits.length,
        hashFunctions: filter.nbHashes,
        createdAt: new Date(),
        version: 1,
        elementCount: totalLoaded
      });

      logger.info('布隆过滤器构建完成', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        loadedElements: totalLoaded,
        filterSize: filter.bits.length,
        hashFunctions: filter.nbHashes,
        estimatedFalsePositiveRate: BLOOM_FILTER.FALSE_POSITIVE_RATE
      });

      // 异步保存到数据库
      this.saveFilterToDatabase(userKey, mode, filter).catch(error => {
        logger.error('保存布隆过滤器到数据库失败', {
          userKey: userKey.substring(0, 8) + '***',
          mode,
          error: error.message
        });
      });

      return filter;

    } catch (error) {
      logger.error('初始化布隆过滤器失败', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * 检查指纹是否可能存在
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @param {string} fingerprint - 指纹（SHA256）
   * @returns {Promise<Object>} 检查结果
   */
  async mightContain(userKey, mode, fingerprint) {
    if (!this.enabled) {
      return { possible: true, source: 'bloom_disabled' };
    }

    try {
      const filterKey = this.generateFilterKey(userKey, mode);
      let filter = this.filters.get(filterKey);
      
      // 如果没有过滤器，尝试初始化
      if (!filter) {
        filter = await this.initializeFilter(userKey, mode);
        
        if (!filter) {
          return { possible: false, source: 'no_data' };
        }
      }

      const possible = filter.has(String(fingerprint).toLowerCase());
      
      return {
        possible,
        source: 'bloom_filter',
        meta: this.filterMetas.get(filterKey)
      };

    } catch (error) {
      logger.error('布隆过滤器检查失败', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        fingerprint: String(fingerprint).substring(0, 8) + '***',
        error: error.message
      });
      
      // 出错时返回可能存在，避免误过滤
      return { possible: true, source: 'error_fallback' };
    }
  }

  /**
   * 批量检查指纹是否可能存在
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @param {string[]} fingerprintArray - 指纹数组
   * @returns {Promise<Object>} 批量检查结果
   */
  async batchMightContain(userKey, mode, fingerprintArray) {
    if (!this.enabled) {
      return {
        possible: fingerprintArray.map(fp => ({ fingerprint: fp, possible: true, source: 'bloom_disabled' })),
        summary: { total: fingerprintArray.length, possible: fingerprintArray.length, impossible: 0 }
      };
    }

    try {
      const filterKey = this.generateFilterKey(userKey, mode);
      let filter = this.filters.get(filterKey);
      
      if (!filter) {
        filter = await this.initializeFilter(userKey, mode);
        
        if (!filter) {
          return {
            possible: fingerprintArray.map(fp => ({ fingerprint: fp, possible: false, source: 'no_data' })),
            summary: { total: fingerprintArray.length, possible: 0, impossible: fingerprintArray.length }
          };
        }
      }

      const results = fingerprintArray.map(fp => ({
        fingerprint: fp,
        possible: filter.has(String(fp).toLowerCase()),
        source: 'bloom_filter'
      }));

      const possibleCount = results.filter(r => r.possible).length;
      const impossibleCount = results.length - possibleCount;

      logger.debug('布隆过滤器批量检查', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        total: fingerprintArray.length,
        possible: possibleCount,
        impossible: impossibleCount,
        filteredRatio: `${(impossibleCount / Math.max(fingerprintArray.length,1) * 100).toFixed(1)}%`
      });

      return {
        possible: results,
        summary: {
          total: fingerprintArray.length,
          possible: possibleCount,
          impossible: impossibleCount,
          filteredRatio: fingerprintArray.length ? (impossibleCount / fingerprintArray.length) : 0
        },
        meta: this.filterMetas.get(filterKey)
      };

    } catch (error) {
      logger.error('布隆过滤器批量检查失败', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        count: fingerprintArray.length,
        error: error.message
      });
      
      // 出错时返回全部可能存在
      return {
        possible: fingerprintArray.map(fp => ({ fingerprint: fp, possible: true, source: 'error_fallback' })),
        summary: { total: fingerprintArray.length, possible: fingerprintArray.length, impossible: 0 }
      };
    }
  }

  /**
   * 向过滤器添加新的指纹
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @param {string[]} fingerprintArray - 指纹数组
   * @returns {Promise<boolean>} 是否成功
   */
  async addFingerprints(userKey, mode, fingerprintArray) {
    if (!this.enabled) {
      return true;
    }

    try {
      const filterKey = this.generateFilterKey(userKey, mode);
      let filter = this.filters.get(filterKey);
      
      if (!filter) {
        // 如果没有过滤器，先初始化
        filter = await this.initializeFilter(userKey, mode);
        
        if (!filter) {
          // 创建新的过滤器，使用更合理的容量估算
          const batchSize = fingerprintArray.length;
          const conservativeCapacity = Math.max(batchSize * BLOOM_FILTER.GROWTH_MULTIPLIER * 2, BLOOM_FILTER.MIN_CAPACITY); // 批量大小的10倍，最少配置的最小容量
          const expectedElements = conservativeCapacity;
          
          logger.info('为批量添加创建新布隆过滤器', {
            userKey: userKey.substring(0, 8) + '***',
            mode,
            batchSize,
            expectedElements
          });
          
          filter = this.createFilter(expectedElements);
          this.filters.set(filterKey, filter);
          this.filterMetas.set(filterKey, {
            size: filter.bits.length,
            hashFunctions: filter.nbHashes,
            createdAt: new Date(),
            version: 1,
            elementCount: 0
          });
        }
      }

      // 添加指纹到过滤器
      for (const fp of fingerprintArray) {
        filter.add(String(fp).toLowerCase());
      }

      // 更新元数据
      const meta = this.filterMetas.get(filterKey);
      if (meta) {
        meta.elementCount += fingerprintArray.length;
        meta.lastUpdatedAt = new Date();
      }

      logger.debug('向布隆过滤器添加指纹', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        addedCount: fingerprintArray.length,
        totalElements: meta?.elementCount || 'unknown'
      });

      return true;

    } catch (error) {
      logger.error('向布隆过滤器添加指纹失败', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        count: fingerprintArray.length,
        error: error.message
      });
      return false;
    }
  }

  /**
   * 清除用户的布隆过滤器（支持清除特定 mode 或所有 mode）
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式（可选，不传则清除所有 mode）
   */
  clearFilter(userKey, mode = null) {
    if (mode) {
      // 清除特定 mode 的过滤器
      const filterKey = this.generateFilterKey(userKey, mode);
      if (this.filters.has(filterKey)) {
        this.filters.delete(filterKey);
        this.filterMetas.delete(filterKey);
        
        logger.info('清除用户布隆过滤器', {
          userKey: userKey.substring(0, 8) + '***',
          mode
        });
      }
    } else {
      // 清除该 userKey 下所有 mode 的过滤器
      let clearedCount = 0;
      for (const filterKey of this.filters.keys()) {
        if (filterKey.startsWith(userKey + ':')) {
          this.filters.delete(filterKey);
          this.filterMetas.delete(filterKey);
          clearedCount++;
        }
      }
      
      if (clearedCount > 0) {
        logger.info('清除用户所有布隆过滤器', {
          userKey: userKey.substring(0, 8) + '***',
          clearedCount
        });
      }
    }
  }

  /**
   * 获取过滤器统计信息
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @returns {Object|null} 统计信息
   */
  getFilterStats(userKey, mode) {
    if (!this.enabled) {
      return { enabled: false };
    }

    const filterKey = this.generateFilterKey(userKey, mode);
    const filter = this.filters.get(filterKey);
    const meta = this.filterMetas.get(filterKey);
    
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
   * @param {string} mode - 指纹模式
   * @param {BloomFilter} filter - 布隆过滤器
   * @returns {Promise<boolean>} 是否成功
   */
  async saveFilterToDatabase(userKey, mode, filter) {
    try {
      const meta = await UserCollectionMeta.getOrCreate(userKey, mode);
      
      // 将过滤器序列化为Buffer
      const filterData = Buffer.from(filter.saveAsJSON());
      
      meta.bloomFilter = filterData;
      await meta.save();
      
      logger.debug('布隆过滤器已保存到数据库', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        dataSize: `${(filterData.length / 1024).toFixed(2)} KB`
      });
      
      return true;
      
    } catch (error) {
      logger.error('保存布隆过滤器到数据库失败', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        error: error.message
      });
      return false;
    }
  }

  /**
   * 从数据库加载过滤器
   * @param {string} userKey - 用户密钥
   * @param {string} mode - 指纹模式
   * @returns {Promise<BloomFilter|null>} 布隆过滤器实例
   */
  async loadFilterFromDatabase(userKey, mode) {
    if (!this.enabled) {
      return null;
    }

    try {
      const meta = await UserCollectionMeta.findOne({ userKey, mode });
      
      if (!meta || !meta.bloomFilter) {
        return null;
      }

      // 从Buffer反序列化过滤器
      const filterJSON = meta.bloomFilter.toString();
      const filter = BloomFilter.fromJSON(JSON.parse(filterJSON));
      
      const filterKey = this.generateFilterKey(userKey, mode);
      // 缓存过滤器
      this.filters.set(filterKey, filter);
      this.filterMetas.set(filterKey, {
        size: filter.bits.length,
        hashFunctions: filter.nbHashes,
        createdAt: meta.createdAt,
        version: 1,
        elementCount: meta.totalCount || 0
      });
      
      logger.info('从数据库加载布隆过滤器', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
        size: filter.bits.length,
        hashFunctions: filter.nbHashes
      });
      
      return filter;
      
    } catch (error) {
      logger.error('从数据库加载布隆过滤器失败', {
        userKey: userKey.substring(0, 8) + '***',
        mode,
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

    for (const [filterKey, meta] of this.filterMetas.entries()) {
      const filterStats = {
        filterKey: filterKey.substring(0, 16) + '...', // 显示部分 key
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