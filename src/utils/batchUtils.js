const { BATCH_CONFIG } = require('../config/constants');
const logger = require('./logger');

/**
 * 批处理工具类
 * 用于处理大量数据的分批操作
 */
class BatchUtils {
  /**
   * 将数组分割为指定大小的批次
   * @param {Array} array - 要分割的数组
   * @param {number} batchSize - 批次大小
   * @returns {Array[]} 分割后的批次数组
   */
  static splitIntoBatches(array, batchSize = BATCH_CONFIG.BATCH_SIZE) {
    if (!Array.isArray(array)) {
      throw new Error('第一个参数必须是数组');
    }

    if (typeof batchSize !== 'number' || batchSize < 1) {
      throw new Error('批次大小必须是大于0的数字');
    }

    const batches = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }

    return batches;
  }

  /**
   * 串行处理批次（一个接一个）
   * @param {Array} array - 要处理的数组
   * @param {Function} processor - 处理函数
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 处理结果
   */
  static async processSerially(array, processor, options = {}) {
    const {
      batchSize = BATCH_CONFIG.BATCH_SIZE,
      retryTimes = BATCH_CONFIG.RETRY_TIMES,
      timeout = BATCH_CONFIG.TIMEOUT_PER_BATCH,
      onProgress = null,
      onBatchComplete = null
    } = options;

    const batches = this.splitIntoBatches(array, batchSize);
    const results = [];
    const errors = [];
    let processedCount = 0;

    logger.info('开始串行批处理', {
      totalItems: array.length,
      batchCount: batches.length,
      batchSize
    });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchInfo = {
        index: i,
        size: batch.length,
        total: batches.length
      };

      try {
        const startTime = Date.now();
        
        // 处理单个批次（带重试和超时）
        const result = await this.processSingleBatch(
          batch, 
          processor, 
          batchInfo,
          { retryTimes, timeout }
        );

        const duration = Date.now() - startTime;
        
        results.push({
          batchIndex: i,
          success: true,
          result,
          duration,
          processedItems: batch.length
        });

        processedCount += batch.length;

        // 进度回调
        if (onProgress) {
          onProgress({
            batchIndex: i,
            totalBatches: batches.length,
            processedItems: processedCount,
            totalItems: array.length,
            progress: (processedCount / array.length) * 100
          });
        }

        // 批次完成回调
        if (onBatchComplete) {
          onBatchComplete(batchInfo, result, duration);
        }

        logger.info('批次处理完成', {
          batchIndex: i,
          duration: `${duration}ms`,
          processedItems: batch.length
        });

      } catch (error) {
        logger.error('批次处理失败', {
          batchIndex: i,
          error: error.message,
          batchSize: batch.length
        });

        errors.push({
          batchIndex: i,
          error: error.message,
          batch
        });
      }
    }

    const summary = {
      success: errors.length === 0,
      totalItems: array.length,
      processedItems: processedCount,
      successfulBatches: results.length,
      failedBatches: errors.length,
      results,
      errors
    };

    logger.info('串行批处理完成', summary);
    return summary;
  }

  /**
   * 并行处理批次（同时处理多个批次）
   * @param {Array} array - 要处理的数组
   * @param {Function} processor - 处理函数
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 处理结果
   */
  static async processParallel(array, processor, options = {}) {
    const {
      batchSize = BATCH_CONFIG.BATCH_SIZE,
      maxConcurrent = BATCH_CONFIG.MAX_CONCURRENT,
      retryTimes = BATCH_CONFIG.RETRY_TIMES,
      timeout = BATCH_CONFIG.TIMEOUT_PER_BATCH,
      onProgress = null,
      onBatchComplete = null
    } = options;

    const batches = this.splitIntoBatches(array, batchSize);
    const results = [];
    const errors = [];
    let processedCount = 0;

    logger.info('开始并行批处理', {
      totalItems: array.length,
      batchCount: batches.length,
      batchSize,
      maxConcurrent
    });

    // 控制并发数的批次处理
    for (let i = 0; i < batches.length; i += maxConcurrent) {
      const currentBatches = batches.slice(i, i + maxConcurrent);
      
      const promises = currentBatches.map(async (batch, localIndex) => {
        const globalIndex = i + localIndex;
        const batchInfo = {
          index: globalIndex,
          size: batch.length,
          total: batches.length
        };

        try {
          const startTime = Date.now();
          
          const result = await this.processSingleBatch(
            batch,
            processor,
            batchInfo,
            { retryTimes, timeout }
          );

          const duration = Date.now() - startTime;

          if (onBatchComplete) {
            onBatchComplete(batchInfo, result, duration);
          }

          return {
            batchIndex: globalIndex,
            success: true,
            result,
            duration,
            processedItems: batch.length
          };

        } catch (error) {
          logger.error('并行批次处理失败', {
            batchIndex: globalIndex,
            error: error.message
          });

          return {
            batchIndex: globalIndex,
            success: false,
            error: error.message,
            batch
          };
        }
      });

      // 等待当前批次的所有并行处理完成
      const batchResults = await Promise.allSettled(promises);
      
      batchResults.forEach((settledResult, localIndex) => {
        const globalIndex = i + localIndex;
        
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          
          if (result.success) {
            results.push(result);
            processedCount += result.processedItems;
          } else {
            errors.push({
              batchIndex: result.batchIndex,
              error: result.error,
              batch: result.batch
            });
          }
        } else {
          errors.push({
            batchIndex: globalIndex,
            error: settledResult.reason.message,
            batch: currentBatches[localIndex]
          });
        }
      });

      // 进度回调
      if (onProgress) {
        onProgress({
          completedBatches: Math.min(i + maxConcurrent, batches.length),
          totalBatches: batches.length,
          processedItems: processedCount,
          totalItems: array.length,
          progress: (processedCount / array.length) * 100
        });
      }
    }

    const summary = {
      success: errors.length === 0,
      totalItems: array.length,
      processedItems: processedCount,
      successfulBatches: results.length,
      failedBatches: errors.length,
      results,
      errors
    };

    logger.info('并行批处理完成', summary);
    return summary;
  }

  /**
   * 处理单个批次（带重试机制）
   * @param {Array} batch - 批次数据
   * @param {Function} processor - 处理函数
   * @param {Object} batchInfo - 批次信息
   * @param {Object} options - 选项
   * @returns {Promise} 处理结果
   */
  static async processSingleBatch(batch, processor, batchInfo, options = {}) {
    const { retryTimes = BATCH_CONFIG.RETRY_TIMES, timeout = BATCH_CONFIG.TIMEOUT_PER_BATCH } = options;
    
    let lastError;
    
    for (let attempt = 1; attempt <= retryTimes + 1; attempt++) {
      try {
        // 包装超时处理
        const result = await Promise.race([
          processor(batch, batchInfo),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`批次处理超时 (${timeout}ms)`)), timeout)
          )
        ]);

        // 成功则返回结果
        if (attempt > 1) {
          logger.info('批次重试成功', {
            batchIndex: batchInfo.index,
            attempt,
            totalAttempts: retryTimes + 1
          });
        }

        return result;

      } catch (error) {
        lastError = error;
        
        if (attempt <= retryTimes) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最大5秒
          
          logger.warn('批次处理失败，准备重试', {
            batchIndex: batchInfo.index,
            attempt,
            totalAttempts: retryTimes + 1,
            error: error.message,
            retryDelay: `${delay}ms`
          });

          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`批次处理失败，已重试${retryTimes}次: ${lastError.message}`);
  }

  /**
   * 获取批次信息
   * @param {Array} array - 数组
   * @param {number} batchSize - 批次大小
   * @returns {Object} 批次信息
   */
  static getBatchInfo(array, batchSize = BATCH_CONFIG.BATCH_SIZE) {
    if (!Array.isArray(array)) {
      return {
        valid: false,
        error: '输入必须是数组'
      };
    }

    const totalItems = array.length;
    const batchCount = Math.ceil(totalItems / batchSize);
    const lastBatchSize = totalItems % batchSize || batchSize;

    return {
      valid: true,
      totalItems,
      batchSize,
      batchCount,
      lastBatchSize,
      estimatedMemoryUsage: this.estimateMemoryUsage(array, batchSize),
      recommendedConcurrency: this.getRecommendedConcurrency(batchCount)
    };
  }

  /**
   * 估算内存使用量
   * @param {Array} array - 数组
   * @param {number} batchSize - 批次大小
   * @returns {Object} 内存估算
   */
  static estimateMemoryUsage(array, batchSize) {
    if (!Array.isArray(array) || array.length === 0) {
      return { bytes: 0, readable: '0 B' };
    }

    // 简单估算：每个字符串项目大约占用其长度 * 2 字节（UTF-16）
    const sampleSize = Math.min(100, array.length);
    const avgItemSize = array.slice(0, sampleSize)
      .reduce((sum, item) => sum + (typeof item === 'string' ? item.length * 2 : 64), 0) / sampleSize;

    const bytesPerBatch = avgItemSize * batchSize;
    const totalBytes = avgItemSize * array.length;

    return {
      bytesPerBatch,
      totalBytes,
      readablePerBatch: this.formatBytes(bytesPerBatch),
      readableTotal: this.formatBytes(totalBytes)
    };
  }

  /**
   * 获取推荐的并发数
   * @param {number} batchCount - 批次数量
   * @returns {number} 推荐并发数
   */
  static getRecommendedConcurrency(batchCount) {
    if (batchCount <= 2) return 1;
    if (batchCount <= 10) return 2;
    if (batchCount <= 50) return 3;
    return Math.min(5, Math.ceil(batchCount / 20));
  }

  /**
   * 格式化字节数为可读字符串
   * @param {number} bytes - 字节数
   * @returns {string} 可读字符串
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  /**
   * 创建进度监控器
   * @param {string} operationName - 操作名称
   * @returns {Function} 进度回调函数
   */
  static createProgressMonitor(operationName = '批处理操作') {
    const startTime = Date.now();
    let lastLogTime = startTime;

    return (progress) => {
      const now = Date.now();
      const elapsed = now - startTime;
      const sinceLastLog = now - lastLogTime;

      // 每5秒或每25%进度记录一次
      if (sinceLastLog >= 5000 || progress.progress % 25 === 0) {
        const eta = progress.progress > 0 
          ? Math.round((elapsed / progress.progress) * (100 - progress.progress))
          : 0;

        logger.info(`${operationName}进度`, {
          progress: `${progress.progress.toFixed(1)}%`,
          processedItems: progress.processedItems,
          totalItems: progress.totalItems,
          elapsed: `${Math.round(elapsed / 1000)}s`,
          eta: eta > 0 ? `${Math.round(eta / 1000)}s` : 'N/A'
        });

        lastLogTime = now;
      }
    };
  }
}

module.exports = BatchUtils;