const mongoose = require('mongoose');
const crypto = require('crypto');
const { COLLECTIONS } = require('../config/constants');

/**
 * 用户集合元数据模型
 * 存储每个用户MD5集合的元信息，用于快速比较和统计
 */
const userCollectionMetaSchema = new mongoose.Schema({
  // 用户标识
  userKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
    validate: {
      validator: function(v) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
      },
      message: 'userKey必须是有效的UUID v4格式'
    }
  },

  // MD5集合总数
  totalCount: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },

  // 集合哈希值 (用于快速比较是否相同)
  collectionHash: {
    type: String,
    required: true,
    default: '',
    index: true
  },

  // 最后同步时间
  lastSyncAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  // 最后更新时间
  lastUpdateAt: {
    type: Date,
    default: Date.now
  },

  // 布隆过滤器数据 (可选，用于快速判断)
  bloomFilter: {
    type: Buffer,
    default: null
  },

  // 同步统计信息
  syncStats: {
    // 总同步次数
    totalSyncs: {
      type: Number,
      default: 0
    },
    
    // 最后一次同步添加的数量
    lastSyncAdded: {
      type: Number,
      default: 0
    },
    
    // 最后一次同步耗时(毫秒)
    lastSyncDuration: {
      type: Number,
      default: 0
    }
  },

  // 创建时间
  createdAt: {
    type: Date,
    default: Date.now
  },

  // 更新时间
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  // 集合名称
  collection: COLLECTIONS.USER_META,
  
  // 启用时间戳
  timestamps: true,
  
  // 优化设置
  versionKey: false
});

// 索引优化 (userKey已在schema中定义为unique和index)
userCollectionMetaSchema.index({ lastSyncAt: -1 });
userCollectionMetaSchema.index({ totalCount: 1 });

// 实例方法：计算集合哈希
userCollectionMetaSchema.methods.calculateCollectionHash = async function() {
  try {
    const UserMd5Collection = require('./UserMd5Collection');
    
    // 获取所有MD5并排序
    const md5s = await UserMd5Collection
      .find({ userKey: this.userKey })
      .select('md5')
      .sort({ md5: 1 })
      .lean();
    
    const md5Array = md5s.map(doc => doc.md5);
    
    // 计算哈希
    const hash = crypto
      .createHash('sha256')
      .update(md5Array.join(''))
      .digest('hex');
    
    this.collectionHash = hash;
    return hash;
  } catch (error) {
    console.error('计算集合哈希失败:', error);
    return null;
  }
};

// 实例方法：更新统计信息
userCollectionMetaSchema.methods.updateStats = async function(syncResult = {}) {
  try {
    const UserMd5Collection = require('./UserMd5Collection');
    
    // 更新总数
    this.totalCount = await UserMd5Collection.countDocuments({ 
      userKey: this.userKey 
    });
    
    // 重新计算集合哈希
    await this.calculateCollectionHash();
    
    // 更新同步统计
    if (syncResult.added !== undefined) {
      this.syncStats.totalSyncs += 1;
      this.syncStats.lastSyncAdded = syncResult.added;
      this.syncStats.lastSyncDuration = syncResult.duration || 0;
      this.lastSyncAt = new Date();
    }
    
    this.lastUpdateAt = new Date();
    
    return this.save();
  } catch (error) {
    console.error('更新统计信息失败:', error);
    throw error;
  }
};

// 静态方法：获取或创建用户元数据
userCollectionMetaSchema.statics.getOrCreate = async function(userKey) {
  try {
    let meta = await this.findOne({ userKey });
    
    if (!meta) {
      // 创建新的元数据记录（快速路径）：
      // 按业务约定，若不存在元数据则视为该用户当前无有效MD5数据，
      // 首次创建时不进行全量扫描与哈希计算，避免首个 /check 卡顿。
      meta = new this({
        userKey,
        totalCount: 0,
        collectionHash: '',
        // 首次初始化不认为发生过同步
        lastSyncAt: null,
        lastUpdateAt: new Date()
      });
      
      await meta.save();
    }
    
    return meta;
  } catch (error) {
    console.error('获取或创建用户元数据失败:', error);
    throw error;
  }
};

// 静态方法：批量更新元数据
userCollectionMetaSchema.statics.updateForUser = async function(userKey, syncResult) {
  try {
    const meta = await this.getOrCreate(userKey);
    await meta.updateStats(syncResult);
    return meta;
  } catch (error) {
    console.error('更新用户元数据失败:', error);
    throw error;
  }
};

// 静态方法：检查是否需要同步
userCollectionMetaSchema.statics.needsSync = async function(userKey, clientHash, clientCount) {
  try {
    const meta = await this.findOne({ userKey });
    
    if (!meta) {
      return { needSync: true, reason: 'no_server_data' };
    }
    
    // 如果数量不同，需要同步
    if (meta.totalCount !== clientCount) {
      return { 
        needSync: true, 
        reason: 'count_mismatch',
        serverCount: meta.totalCount,
        clientCount
      };
    }
    
    // 如果哈希不同，需要同步
    if (meta.collectionHash !== clientHash) {
      return { 
        needSync: true, 
        reason: 'hash_mismatch',
        serverHash: meta.collectionHash,
        clientHash
      };
    }
    
    return { 
      needSync: false, 
      reason: 'already_synced',
      lastSyncAt: meta.lastSyncAt
    };
  } catch (error) {
    console.error('检查同步需求失败:', error);
    return { needSync: true, reason: 'check_error', error: error.message };
  }
};

// 静态方法：获取用户统计信息
userCollectionMetaSchema.statics.getUserStats = async function(userKey) {
  try {
    const meta = await this.findOne({ userKey });
    
    if (!meta) {
      return {
        userKey,
        totalCount: 0,
        collectionHash: '',
        lastSyncAt: null,
        syncStats: {
          totalSyncs: 0,
          lastSyncAdded: 0,
          lastSyncDuration: 0
        }
      };
    }
    
    return {
      userKey: meta.userKey,
      totalCount: meta.totalCount,
      collectionHash: meta.collectionHash,
      lastSyncAt: meta.lastSyncAt,
      lastUpdateAt: meta.lastUpdateAt,
      syncStats: meta.syncStats,
      createdAt: meta.createdAt
    };
  } catch (error) {
    console.error('获取用户统计信息失败:', error);
    throw error;
  }
};

// 中间件：保存前更新时间戳
userCollectionMetaSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  if (this.isNew) {
    this.createdAt = new Date();
  }
  next();
});

module.exports = mongoose.model('UserCollectionMeta', userCollectionMetaSchema);