const { v4: uuidv4 } = require('uuid');
const UserMd5Collection = require('../models/UserMd5Collection');
const UserCollectionMeta = require('../models/UserCollectionMeta');
const HashUtils = require('../utils/hashUtils');
const UserKeyUtils = require('../utils/userKeyUtils');
const BatchUtils = require('../utils/batchUtils');
const logger = require('../utils/logger');
const cacheService = require('./cacheService');
const bloomFilterService = require('./bloomFilterService');
const { BATCH_CONFIG, SYNC_CONFIG, HTTP_STATUS } = require('../config/constants');

/**
 * 同步服务
 * 核心业务逻辑：处理MD5集合的双向同步
 */
class SyncService {
  constructor() {
    this.activeSessions = new Map(); // sessionId -> session data
    this.syncLocks = new Map(); // userKey -> lock info
    
    logger.info('同步服务已启动');
  }

  /**
   * 同步预检查
   * 快速判断是否需要同步，避免不必要的数据传输
   * @param {string} userKey - 用户密钥
   * @param {number} clientCount - 客户端MD5数量
   * @param {string} clientHash - 客户端集合哈希
   * @returns {Promise<Object>} 预检查结果
   */
  async checkSyncRequired(userKey, clientCount, clientHash) {
    const startTime = Date.now();
    
    try {
      logger.sync(userKey, 'sync_check_start', {
        clientCount,
        clientHash: clientHash.substring(0, 16) + '...'
      });

      // 检查是否有正在进行的同步
      if (this.syncLocks.has(userKey)) {
        const lockInfo = this.syncLocks.get(userKey);
        logger.warn('同步已在进行中', {
          userKey: UserKeyUtils.toShortId(userKey),
          lockStartTime: lockInfo.startTime,
          lockDuration: `${Date.now() - lockInfo.startTime}ms`
        });
        
        return {
          needSync: false,
          reason: 'sync_in_progress',
          message: '同步操作正在进行中，请稍后再试',
          lockInfo
        };
      }

      // 尝试从缓存获取元数据
      let serverMeta = cacheService.getUserMeta(userKey);
      
      if (!serverMeta) {
        // 从数据库获取或创建元数据
        const metaDoc = await UserCollectionMeta.getOrCreate(userKey);
        serverMeta = {
          totalCount: metaDoc.totalCount,
          collectionHash: metaDoc.collectionHash,
          lastSyncAt: metaDoc.lastSyncAt,
          syncStats: metaDoc.syncStats
        };
        
        // 缓存元数据
        cacheService.setUserMeta(userKey, serverMeta);
      }

      const result = {
        needSync: false,
        reason: 'unknown',
        serverCount: serverMeta.totalCount,
        serverHash: serverMeta.collectionHash,
        clientCount,
        clientHash,
        lastSyncAt: serverMeta.lastSyncAt,
        performance: {
          checkDuration: Date.now() - startTime
        }
      };

      // 如果服务端没有数据
      if (serverMeta.totalCount === 0) {
        result.needSync = clientCount > 0;
        result.reason = clientCount > 0 ? 'server_empty' : 'both_empty';
        result.message = clientCount > 0 ? '服务端无数据，需要同步' : '双方都无数据';
      }
      // 如果客户端没有数据
      else if (clientCount === 0) {
        result.needSync = true;
        result.reason = 'client_empty';
        result.message = '客户端无数据，需要从服务端拉取';
      }
      // 数量不同
      else if (serverMeta.totalCount !== clientCount) {
        result.needSync = true;
        result.reason = 'count_mismatch';
        result.message = `数量不匹配：服务端${serverMeta.totalCount}，客户端${clientCount}`;
      }
      // 哈希不同
      else if (serverMeta.collectionHash !== clientHash) {
        result.needSync = true;
        result.reason = 'hash_mismatch';
        result.message = '集合哈希不匹配，内容有差异';
      }
      // 完全一致
      else {
        result.needSync = false;
        result.reason = 'already_synced';
        result.message = '数据已同步，无需操作';
      }

      logger.sync(userKey, 'sync_check_complete', {
        needSync: result.needSync,
        reason: result.reason,
        serverCount: result.serverCount,
        clientCount: result.clientCount,
        duration: `${Date.now() - startTime}ms`
      });

      return result;

    } catch (error) {
      logger.error('同步预检查失败', {
        userKey: UserKeyUtils.toShortId(userKey),
        error: error.message,
        stack: error.stack,
        duration: `${Date.now() - startTime}ms`
      });
      
      throw error;
    }
  }

  /**
   * 双向差异检测
   * 分析客户端和服务端的差异，支持分批处理
   * @param {string} userKey - 用户密钥
   * @param {string[]} clientMd5s - 客户端MD5数组（当前批次）
   * @param {number} batchIndex - 批次索引
   * @param {number} batchSize - 批次大小
   * @returns {Promise<Object>} 差异检测结果
   */
  async bidirectionalDiff(userKey, clientMd5s, batchIndex, batchSize) {
    const startTime = Date.now();
    
    try {
      logger.sync(userKey, 'bidirectional_diff_start', {
        batchIndex,
        batchSize,
        clientMd5Count: clientMd5s.length
      });

      // 验证MD5数组
      const validation = HashUtils.validateMd5Array(clientMd5s);
      if (!validation.valid) {
        throw new Error(`批次${batchIndex}包含无效MD5: ${validation.invalidItems.length}个`);
      }

      const normalizedClientMd5s = validation.validItems;

      // 使用布隆过滤器快速过滤（如果启用）
      let bloomResult = null;
      if (bloomFilterService.enabled) {
        bloomResult = await bloomFilterService.batchMightContain(userKey, normalizedClientMd5s);
        
        // 过滤掉不可能存在的MD5，减少数据库查询
        const possibleMd5s = bloomResult.possible
          .filter(item => item.possible)
          .map(item => item.md5);
        
        logger.debug('布隆过滤器预过滤', {
          userKey: UserKeyUtils.toShortId(userKey),
          originalCount: normalizedClientMd5s.length,
          filteredCount: possibleMd5s.length,
          filteredRatio: `${((normalizedClientMd5s.length - possibleMd5s.length) / normalizedClientMd5s.length * 100).toFixed(1)}%`
        });
      }

      // 查询服务端存在的MD5
      const existingMd5s = await UserMd5Collection.checkMd5Exists(
        userKey, 
        normalizedClientMd5s
      );
      const existingSet = new Set(existingMd5s.map(doc => doc.md5));

      // 计算差异
      const serverMissingMd5s = normalizedClientMd5s.filter(md5 => !existingSet.has(md5));
      const serverExistingMd5s = normalizedClientMd5s.filter(md5 => existingSet.has(md5));

      // 如果是第一个批次，初始化会话来处理客户端缺失的MD5
      let sessionInfo = null;
      if (batchIndex === 0) {
        // 获取服务端的MD5总数（用于估算客户端缺失数量）
        const serverMeta = await UserCollectionMeta.getOrCreate(userKey);
        const serverTotalCount = serverMeta.totalCount;
        
        // 估算客户端缺失的MD5数量
        const estimatedClientMissing = Math.max(0, serverTotalCount - clientMd5s.length);
        
        if (estimatedClientMissing > 0) {
          sessionInfo = {
            sessionId: `diff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            userKey,
            createdAt: new Date(),
            clientTotalEstimate: clientMd5s.length * (batchSize > 0 ? Math.ceil(clientMd5s.length / batchSize) : 1),
            serverTotalCount,
            estimatedMissing: estimatedClientMissing,
            processed: false
          };
          
          // 缓存会话信息
          cacheService.setDiffSession(sessionInfo.sessionId, sessionInfo);
        }
      }

      const result = {
        batchIndex,
        batchSize,
        serverMissingMd5s,
        serverExistingMd5s,
        counts: {
          clientBatch: normalizedClientMd5s.length,
          serverMissing: serverMissingMd5s.length,
          serverExisting: serverExistingMd5s.length
        },
        sessionInfo,
        bloomFilterStats: bloomResult?.summary,
        performance: {
          diffDuration: Date.now() - startTime
        }
      };

      logger.sync(userKey, 'bidirectional_diff_complete', {
        batchIndex,
        serverMissing: serverMissingMd5s.length,
        serverExisting: serverExistingMd5s.length,
        sessionCreated: !!sessionInfo,
        duration: `${Date.now() - startTime}ms`
      });

      return result;

    } catch (error) {
      logger.error('双向差异检测失败', {
        userKey: UserKeyUtils.toShortId(userKey),
        batchIndex,
        error: error.message,
        stack: error.stack,
        duration: `${Date.now() - startTime}ms`
      });
      
      throw error;
    }
  }

  /**
   * 批量添加MD5
   * 将客户端的新MD5添加到服务端
   * @param {string} userKey - 用户密钥
   * @param {string[]} addMd5s - 要添加的MD5数组
   * @returns {Promise<Object>} 添加结果
   */
  async batchAddMd5s(userKey, addMd5s) {
    const startTime = Date.now();
    
    try {
      // 获取同步锁
      await this.acquireSyncLock(userKey, 'batch_add');
      
      logger.sync(userKey, 'batch_add_start', {
        count: addMd5s.length
      });

      // 验证MD5数组
      const validation = HashUtils.validateMd5Array(addMd5s);
      if (!validation.valid) {
        throw new Error(`包含无效MD5: ${validation.invalidItems.length}个`);
      }

      const normalizedMd5s = validation.validItems;

      // 批量添加到数据库
      const addResult = await UserMd5Collection.addBatch(userKey, normalizedMd5s);

      // 更新用户元数据
      const updateResult = { added: addResult.insertedCount, duration: Date.now() - startTime };
      await UserCollectionMeta.updateForUser(userKey, updateResult);

      // 更新布隆过滤器
      if (bloomFilterService.enabled && addResult.insertedCount > 0) {
        await bloomFilterService.addMd5s(userKey, normalizedMd5s);
      }

      // 清除相关缓存
      cacheService.clearUserCache(userKey);

      const result = {
        success: true,
        addedCount: addResult.insertedCount,
        duplicateCount: addResult.duplicateCount,
        totalRequested: normalizedMd5s.length,
        performance: {
          addDuration: Date.now() - startTime
        }
      };

      logger.sync(userKey, 'batch_add_complete', {
        added: result.addedCount,
        duplicates: result.duplicateCount,
        duration: `${Date.now() - startTime}ms`
      });

      return result;

    } catch (error) {
      logger.error('批量添加MD5失败', {
        userKey: UserKeyUtils.toShortId(userKey),
        count: addMd5s?.length || 0,
        error: error.message,
        stack: error.stack,
        duration: `${Date.now() - startTime}ms`
      });
      
      throw error;
      
    } finally {
      // 释放同步锁
      this.releaseSyncLock(userKey);
    }
  }

  /**
   * 分页获取差异MD5
   * 获取客户端缺失的MD5数据
   * @param {string} userKey - 用户密钥
   * @param {string} sessionId - 差异会话ID
   * @param {number} pageIndex - 页码
   * @returns {Promise<Object>} 分页结果
   */
  async pullDiffPage(userKey, sessionId, pageIndex) {
    const startTime = Date.now();
    
    try {
      logger.sync(userKey, 'pull_diff_page_start', {
        sessionId: sessionId.substring(0, 16) + '...',
        pageIndex
      });

      // 获取会话信息
      const sessionInfo = cacheService.getDiffSession(sessionId);
      if (!sessionInfo) {
        throw new Error('差异会话已过期或不存在');
      }

      if (sessionInfo.userKey !== userKey) {
        throw new Error('会话用户不匹配');
      }

      const pageSize = SYNC_CONFIG.DEFAULT_PAGE_SIZE;
      const skip = pageIndex * pageSize;

      // 分页获取服务端MD5
      const md5Docs = await UserMd5Collection
        .find({ userKey })
        .select('md5')
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

      const missingMd5s = md5Docs.map(doc => doc.md5);
      
      // 获取总页数
      const totalCount = await UserMd5Collection.getUserMd5Count(userKey);
      const totalPages = Math.ceil(totalCount / pageSize);
      const hasMore = pageIndex < totalPages - 1;

      const result = {
        sessionId,
        missingMd5s,
        pageInfo: {
          currentPage: pageIndex,
          pageSize,
          totalPages,
          hasMore,
          totalCount
        },
        performance: {
          pullDuration: Date.now() - startTime
        }
      };

      logger.sync(userKey, 'pull_diff_page_complete', {
        sessionId: sessionId.substring(0, 16) + '...',
        pageIndex,
        returnedCount: missingMd5s.length,
        hasMore,
        duration: `${Date.now() - startTime}ms`
      });

      return result;

    } catch (error) {
      logger.error('分页获取差异MD5失败', {
        userKey: UserKeyUtils.toShortId(userKey),
        sessionId: sessionId?.substring(0, 16) + '...',
        pageIndex,
        error: error.message,
        stack: error.stack,
        duration: `${Date.now() - startTime}ms`
      });
      
      throw error;
    }
  }

  /**
   * 完整的差异分析
   * 分析客户端和服务端的完整差异（适用于客户端发送完整MD5列表的场景）
   * @param {string} userKey - 用户密钥
   * @param {string[]} clientMd5s - 客户端完整MD5数组
   * @returns {Promise<Object>} 差异分析结果
   */
  async analyzeDifference(userKey, clientMd5s) {
    const startTime = Date.now();
    
    try {
      logger.sync(userKey, 'analyze_diff_start', {
        clientCount: clientMd5s.length
      });

      // 验证MD5数组
      const validation = HashUtils.validateMd5Array(clientMd5s);
      if (!validation.valid) {
        throw new Error(`包含无效MD5: ${validation.invalidItems.length}个`);
      }

      const normalizedClientMd5s = validation.validItems;

      // 获取服务端和客户端的差异
      const diffResult = await UserMd5Collection.findMissingMd5s(userKey, normalizedClientMd5s);

      // 创建差异会话
      const sessionId = `diff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const sessionData = {
        sessionId,
        userKey,
        clientMd5s: normalizedClientMd5s,
        missingInClient: diffResult.missingInClient,
        missingInServer: diffResult.missingInServer,
        totalClient: diffResult.totalClient,
        totalServer: diffResult.totalServer,
        createdAt: new Date(),
        processed: false
      };

      // 缓存会话数据
      cacheService.setDiffSession(sessionId, sessionData);

      const pageSize = SYNC_CONFIG.DEFAULT_PAGE_SIZE;
      const totalPages = Math.ceil(diffResult.missingInClient.length / pageSize);

      const result = {
        diffSessionId: sessionId,
        diffStats: {
          clientMissingCount: diffResult.missingInClient.length,
          serverMissingCount: diffResult.missingInServer.length,
          totalPages,
          pageSize
        },
        serverStats: {
          totalMd5Count: diffResult.totalServer,
          clientCurrentCount: diffResult.totalClient
        },
        recommendations: this.generateSyncRecommendations(diffResult),
        performance: {
          analysisDuration: Date.now() - startTime
        }
      };

      logger.sync(userKey, 'analyze_diff_complete', {
        sessionId: sessionId.substring(0, 16) + '...',
        clientMissing: diffResult.missingInClient.length,
        serverMissing: diffResult.missingInServer.length,
        duration: `${Date.now() - startTime}ms`
      });

      return result;

    } catch (error) {
      logger.error('差异分析失败', {
        userKey: UserKeyUtils.toShortId(userKey),
        clientCount: clientMd5s?.length || 0,
        error: error.message,
        stack: error.stack,
        duration: `${Date.now() - startTime}ms`
      });
      
      throw error;
    }
  }

  /**
   * 生成同步建议
   * @param {Object} diffResult - 差异结果
   * @returns {Object} 同步建议
   */
  generateSyncRecommendations(diffResult) {
    const recommendations = {
      priority: 'normal',
      estimatedTime: 'unknown',
      suggestions: []
    };

    const { missingInClient, missingInServer, totalClient, totalServer } = diffResult;

    // 优先级判断
    if (missingInClient.length > 10000 || missingInServer.length > 10000) {
      recommendations.priority = 'high';
      recommendations.suggestions.push('数据量较大，建议分批同步');
    }

    if (missingInClient.length === 0 && missingInServer.length > 0) {
      recommendations.suggestions.push('客户端数据完整，只需推送到服务端');
    } else if (missingInServer.length === 0 && missingInClient.length > 0) {
      recommendations.suggestions.push('服务端数据完整，只需从服务端拉取');
    } else if (missingInClient.length > 0 && missingInServer.length > 0) {
      recommendations.suggestions.push('需要双向同步');
    }

    // 估算时间
    const totalOperations = missingInClient.length + missingInServer.length;
    const estimatedSeconds = Math.ceil(totalOperations / 1000) * 2; // 假设每1000个MD5需要2秒
    recommendations.estimatedTime = `约${estimatedSeconds}秒`;

    return recommendations;
  }

  /**
   * 获取同步锁
   * @param {string} userKey - 用户密钥
   * @param {string} operation - 操作类型
   */
  async acquireSyncLock(userKey, operation) {
    if (this.syncLocks.has(userKey)) {
      const lockInfo = this.syncLocks.get(userKey);
      const lockDuration = Date.now() - lockInfo.startTime;
      
      // 如果锁超过5分钟，强制释放
      if (lockDuration > 5 * 60 * 1000) {
        logger.warn('强制释放超时同步锁', {
          userKey: UserKeyUtils.toShortId(userKey),
          operation: lockInfo.operation,
          lockDuration: `${lockDuration}ms`
        });
        this.syncLocks.delete(userKey);
      } else {
        throw new Error('同步操作正在进行中，请稍后再试');
      }
    }

    this.syncLocks.set(userKey, {
      operation,
      startTime: Date.now(),
      lockId: uuidv4()
    });

    logger.debug('获取同步锁', {
      userKey: UserKeyUtils.toShortId(userKey),
      operation
    });
  }

  /**
   * 释放同步锁
   * @param {string} userKey - 用户密钥
   */
  releaseSyncLock(userKey) {
    if (this.syncLocks.has(userKey)) {
      const lockInfo = this.syncLocks.get(userKey);
      const lockDuration = Date.now() - lockInfo.startTime;
      
      this.syncLocks.delete(userKey);
      
      logger.debug('释放同步锁', {
        userKey: UserKeyUtils.toShortId(userKey),
        operation: lockInfo.operation,
        lockDuration: `${lockDuration}ms`
      });
    }
  }

  /**
   * 获取同步状态
   * @param {string} userKey - 用户密钥
   * @returns {Object|null} 同步状态
   */
  getSyncStatus(userKey) {
    const lockInfo = this.syncLocks.get(userKey);
    
    if (!lockInfo) {
      return null;
    }

    return {
      operation: lockInfo.operation,
      startTime: lockInfo.startTime,
      duration: Date.now() - lockInfo.startTime,
      lockId: lockInfo.lockId
    };
  }

  /**
   * 获取服务统计信息
   * @returns {Object} 统计信息
   */
  getServiceStats() {
    return {
      activeSessions: this.activeSessions.size,
      syncLocks: this.syncLocks.size,
      cacheStats: cacheService.getStats(),
      bloomFilterStats: bloomFilterService.getGlobalStats()
    };
  }

  /**
   * 清理过期会话和锁
   */
  cleanup() {
    const now = Date.now();
    let cleanedLocks = 0;
    let cleanedSessions = 0;

    // 清理超时的同步锁（超过10分钟）
    for (const [userKey, lockInfo] of this.syncLocks.entries()) {
      if (now - lockInfo.startTime > 10 * 60 * 1000) {
        this.syncLocks.delete(userKey);
        cleanedLocks++;
      }
    }

    // 清理过期的会话（超过1小时）
    for (const [sessionId, sessionInfo] of this.activeSessions.entries()) {
      if (now - new Date(sessionInfo.createdAt).getTime() > 60 * 60 * 1000) {
        this.activeSessions.delete(sessionId);
        cleanedSessions++;
      }
    }

    if (cleanedLocks > 0 || cleanedSessions > 0) {
      logger.info('清理过期资源', {
        cleanedLocks,
        cleanedSessions
      });
    }
  }
}

// 创建单例实例
const syncService = new SyncService();

// 定期清理
setInterval(() => {
  syncService.cleanup();
}, 5 * 60 * 1000); // 每5分钟清理一次

module.exports = syncService;