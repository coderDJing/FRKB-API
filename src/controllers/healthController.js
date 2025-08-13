const mongoose = require('mongoose');
const { asyncHandler } = require('../middlewares/errorHandler');
const logger = require('../utils/logger');
const cacheService = require('../services/cacheService');
const bloomFilterService = require('../services/bloomFilterService');
const syncService = require('../services/syncService');
const UserFingerprintCollection = require('../models/UserFingerprintCollection');
const UserCollectionMeta = require('../models/UserCollectionMeta');
const AuthorizedUserKey = require('../models/AuthorizedUserKey');

/**
 * 健康检查控制器
 * 提供系统健康状态、监控信息和诊断接口
 */
class HealthController {
  /**
   * 基础健康检查
   * GET /health
   */
  static basicHealth = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    
    try {
      // 检查数据库连接状态
      const dbState = mongoose.connection.readyState;
      const dbStates = {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting'
      };
      
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV,
        version: process.env.npm_package_version || '1.0.0',
        
        database: {
          status: dbStates[dbState] || 'unknown',
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name
        },
        
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          external: Math.round(process.memoryUsage().external / 1024 / 1024),
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
        },
        
        performance: {
          checkDuration: Date.now() - startTime
        }
      };
      
      // 如果数据库未连接，标记为不健康
      if (dbState !== 1) {
        health.status = 'unhealthy';
        health.issues = ['数据库连接异常'];
      }
      
      const statusCode = health.status === 'healthy' ? 200 : 503;
      res.status(statusCode).json(health);
      
    } catch (error) {
      logger.error('健康检查失败', {
        error: error.message,
        stack: error.stack
      });
      
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message,
        performance: {
          checkDuration: Date.now() - startTime
        }
      });
    }
  });

  /**
   * 详细健康检查
   * GET /frkbapi/v1/health/detailed
   */
  static detailedHealth = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    
    try {
      // 基础系统信息
      const basicInfo = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: `${Math.floor(process.uptime())}s`,
        environment: process.env.NODE_ENV,
        version: process.env.npm_package_version || '1.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
      };
      
      // 数据库状态检查
      const dbHealth = await this.checkDatabaseHealth();
      
      // 缓存服务状态
      const cacheHealth = this.checkCacheHealth();
      
      // 布隆过滤器状态
      const bloomHealth = this.checkBloomFilterHealth();
      
      // 同步服务状态
      const syncHealth = this.checkSyncServiceHealth();
      
      // 内存使用情况
      const memoryUsage = process.memoryUsage();
      const memoryInfo = {
        heap: {
          used: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
          total: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
          utilization: `${Math.round(memoryUsage.heapUsed / memoryUsage.heapTotal * 100)}%`
        },
        external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`,
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`
      };
      
      // CPU使用情况
      const cpuUsage = process.cpuUsage();
      const cpuInfo = {
        user: `${Math.round(cpuUsage.user / 1000)}ms`,
        system: `${Math.round(cpuUsage.system / 1000)}ms`
      };
      
      // 汇总健康状态
      const issues = [];
      let overallStatus = 'healthy';
      
      if (dbHealth.status !== 'healthy') {
        issues.push(`数据库: ${dbHealth.message}`);
        overallStatus = 'unhealthy';
      }
      
      if (memoryUsage.heapUsed / memoryUsage.heapTotal > 0.9) {
        issues.push('内存使用率过高');
        overallStatus = 'warning';
      }
      
      const health = {
        ...basicInfo,
        status: overallStatus,
        issues: issues.length > 0 ? issues : undefined,
        
        components: {
          database: dbHealth,
          cache: cacheHealth,
          bloomFilter: bloomHealth,
          syncService: syncHealth
        },
        
        system: {
          memory: memoryInfo,
          cpu: cpuInfo
        },
        
        performance: {
          checkDuration: Date.now() - startTime
        }
      };
      
      const statusCode = overallStatus === 'healthy' ? 200 : 
                        overallStatus === 'warning' ? 200 : 503;
      
      res.status(statusCode).json(health);
      
    } catch (error) {
      logger.error('详细健康检查失败', {
        error: error.message,
        stack: error.stack
      });
      
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message,
        performance: {
          checkDuration: Date.now() - startTime
        }
      });
    }
  });

  /**
   * 系统统计信息
   * GET /frkbapi/v1/health/stats
   */
  static getSystemStats = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    
    try {
      // 数据库统计
      const dbStats = await this.getDatabaseStats();
      
      // 服务统计
      const serviceStats = syncService.getServiceStats();
      
      // 系统运行时统计
      const runtimeStats = {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        versions: process.versions
      };
      
      const stats = {
        success: true,
        timestamp: new Date().toISOString(),
        
        database: dbStats,
        services: serviceStats,
        runtime: runtimeStats,
        
        performance: {
          statsDuration: Date.now() - startTime
        }
      };
      
      res.json(stats);
      
    } catch (error) {
      logger.error('获取系统统计失败', {
        error: error.message,
        stack: error.stack
      });
      
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        performance: {
          statsDuration: Date.now() - startTime
        }
      });
    }
  });

  /**
   * 检查数据库健康状态
   */
  static async checkDatabaseHealth() {
    try {
      const dbState = mongoose.connection.readyState;
      
      if (dbState !== 1) {
        return {
          status: 'unhealthy',
          message: '数据库连接异常',
          details: {
            readyState: dbState,
            host: mongoose.connection.host,
            port: mongoose.connection.port
          }
        };
      }
      
      // 执行简单查询测试连接
      const startTime = Date.now();
      await UserFingerprintCollection.countDocuments().limit(1);
      const queryTime = Date.now() - startTime;
      
      return {
        status: 'healthy',
        message: '数据库连接正常',
        details: {
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name,
          queryTime: `${queryTime}ms`
        }
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        message: '数据库查询失败',
        error: error.message
      };
    }
  }

  /**
   * 检查缓存服务健康状态
   */
  static checkCacheHealth() {
    try {
      const stats = cacheService.getStats();
      
      return {
        status: stats.enabled ? 'healthy' : 'disabled',
        message: stats.enabled ? '缓存服务正常' : '缓存服务已禁用',
        details: stats
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        message: '缓存服务异常',
        error: error.message
      };
    }
  }

  /**
   * 检查布隆过滤器健康状态
   */
  static checkBloomFilterHealth() {
    try {
      const stats = bloomFilterService.getGlobalStats();
      
      return {
        status: stats.enabled ? 'healthy' : 'disabled',
        message: stats.enabled ? '布隆过滤器正常' : '布隆过滤器已禁用',
        details: stats
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        message: '布隆过滤器异常',
        error: error.message
      };
    }
  }

  /**
   * 检查同步服务健康状态
   */
  static checkSyncServiceHealth() {
    try {
      const stats = syncService.getServiceStats();
      
      return {
        status: 'healthy',
        message: '同步服务正常',
        details: {
          activeSessions: stats.activeSessions,
          syncLocks: stats.syncLocks
        }
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        message: '同步服务异常',
        error: error.message
      };
    }
  }

  /**
   * 获取数据库统计信息
   */
  static async getDatabaseStats() {
    try {
      const [
        fingerprintCount,
        metaCount,
        userKeyCount,
        activeUserKeyCount
      ] = await Promise.all([
        UserFingerprintCollection.estimatedDocumentCount(),
        UserCollectionMeta.estimatedDocumentCount(),
        AuthorizedUserKey.estimatedDocumentCount(),
        AuthorizedUserKey.countDocuments({ isActive: true })
      ]);
      
      return {
        collections: {
          fingerprintRecords: fingerprintCount,
          userMetas: metaCount,
          totalUserKeys: userKeyCount,
          activeUserKeys: activeUserKeyCount
        },
        connectionInfo: {
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name,
          readyState: mongoose.connection.readyState
        }
      };
      
    } catch (error) {
      logger.error('获取数据库统计失败', { error: error.message });
      return {
        error: error.message
      };
    }
  }

  /**
   * 系统诊断接口
   * GET /frkbapi/v1/health/diagnose
   */
  static diagnose = asyncHandler(async (req, res) => {
    const startTime = Date.now();
    
    try {
      const diagnostics = {
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV,
        
        checks: {
          database: await this.runDatabaseDiagnostics(),
          memory: this.runMemoryDiagnostics(),
          services: this.runServiceDiagnostics()
        },
        
        recommendations: [],
        performance: {
          diagnoseDuration: Date.now() - startTime
        }
      };
      
      // 生成建议
      diagnostics.recommendations = this.generateRecommendations(diagnostics.checks);
      
      res.json({
        success: true,
        diagnostics
      });
      
    } catch (error) {
      logger.error('系统诊断失败', {
        error: error.message,
        stack: error.stack
      });
      
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * 运行数据库诊断
   */
  static async runDatabaseDiagnostics() {
    try {
      const startTime = Date.now();
      
      // 测试查询性能
      const queryStart = Date.now();
      await UserFingerprintCollection.findOne().limit(1);
      const queryTime = Date.now() - queryStart;
      
      // 获取索引信息
      const indexes = await UserFingerprintCollection.collection.indexes();
      
      return {
        status: 'healthy',
        performance: {
          queryTime: `${queryTime}ms`,
          totalTime: `${Date.now() - startTime}ms`
        },
        indexes: indexes.length,
        connection: {
          host: mongoose.connection.host,
          port: mongoose.connection.port
        }
      };
      
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  /**
   * 运行内存诊断
   */
  static runMemoryDiagnostics() {
    const memUsage = process.memoryUsage();
    const heapUtilization = memUsage.heapUsed / memUsage.heapTotal;
    
    return {
      status: heapUtilization > 0.9 ? 'warning' : 'healthy',
      usage: {
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        utilization: `${Math.round(heapUtilization * 100)}%`,
        external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`
      }
    };
  }

  /**
   * 运行服务诊断
   */
  static runServiceDiagnostics() {
    const serviceStats = syncService.getServiceStats();
    const cacheStats = cacheService.getStats();
    const bloomStats = bloomFilterService.getGlobalStats();
    
    return {
      sync: {
        status: 'healthy',
        activeSessions: serviceStats.activeSessions,
        syncLocks: serviceStats.syncLocks
      },
      cache: {
        status: cacheStats.enabled ? 'healthy' : 'disabled',
        hitRate: cacheStats.hitRate,
        size: cacheStats.size
      },
      bloomFilter: {
        status: bloomStats.enabled ? 'healthy' : 'disabled',
        totalFilters: bloomStats.totalFilters,
        memoryUsage: bloomStats.totalMemoryUsage
      }
    };
  }

  /**
   * 生成优化建议
   */
  static generateRecommendations(checks) {
    const recommendations = [];
    
    // 内存建议
    if (checks.memory.status === 'warning') {
      recommendations.push({
        type: 'memory',
        priority: 'high',
        message: '内存使用率较高，建议优化或增加内存'
      });
    }
    
    // 缓存建议
    if (checks.services.cache.status === 'disabled') {
      recommendations.push({
        type: 'cache',
        priority: 'medium',
        message: '启用缓存可以提升性能'
      });
    }
    
    // 布隆过滤器建议
    if (checks.services.bloomFilter.status === 'disabled') {
      recommendations.push({
        type: 'bloomFilter',
        priority: 'medium',
        message: '启用布隆过滤器可以减少数据库查询'
      });
    }
    
    return recommendations;
  }
}

module.exports = HealthController;