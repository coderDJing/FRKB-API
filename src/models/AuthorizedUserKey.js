const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { COLLECTIONS } = require('../config/constants');

/**
 * 授权用户密钥模型
 * 管理系统中授权的userKey白名单
 */
const authorizedUserKeySchema = new mongoose.Schema({
  // 用户标识 (UUID v4)
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

  // 描述信息（便于管理员识别）
  description: {
    type: String,
    required: true,
    trim: true,
    maxLength: 200
  },

  // 是否激活
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  // 创建者信息
  createdBy: {
    type: String,
    default: 'admin',
    trim: true
  },

  // 最后使用时间
  lastUsedAt: {
    type: Date,
    default: null,
    index: true
  },

  // 使用统计
  usageStats: {
    // 总使用次数
    totalRequests: {
      type: Number,
      default: 0
    },
    
    // 总同步次数
    totalSyncs: {
      type: Number,
      default: 0
    },
    
    // 最后IP地址
    lastIpAddress: {
      type: String,
      default: ''
    },
    
    // 最后用户代理
    lastUserAgent: {
      type: String,
      default: ''
    }
  },

  // 权限配置
  permissions: {
    // 是否允许同步
    canSync: {
      type: Boolean,
      default: true
    },
    
    // 是否允许查询
    canQuery: {
      type: Boolean,
      default: true
    },
    
    // 每日最大请求数 (0表示无限制)
    dailyRequestLimit: {
      type: Number,
      default: 0,
      min: 0
    }
  },


  // 备注信息
  notes: {
    type: String,
    default: '',
    maxLength: 500
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
  collection: COLLECTIONS.AUTH_KEYS,
  
  // 启用时间戳
  timestamps: true,
  
  // 优化设置
  versionKey: false
});

// 索引优化 (userKey、isActive 已在schema中定义)
authorizedUserKeySchema.index({ lastUsedAt: -1 });
authorizedUserKeySchema.index({ createdAt: -1 });

// 实例方法：检查是否有效（激活且未过期）
authorizedUserKeySchema.methods.isValid = function() {
  return this.isActive;
};

// 实例方法：更新使用统计
authorizedUserKeySchema.methods.updateUsage = async function(requestInfo = {}) {
  try {
    this.lastUsedAt = new Date();
    this.usageStats.totalRequests += 1;
    
    if (requestInfo.isSync) {
      this.usageStats.totalSyncs += 1;
    }
    
    if (requestInfo.ipAddress) {
      this.usageStats.lastIpAddress = requestInfo.ipAddress;
    }
    
    if (requestInfo.userAgent) {
      this.usageStats.lastUserAgent = requestInfo.userAgent;
    }
    
    this.updatedAt = new Date();
    
    return this.save();
  } catch (error) {
    console.error('更新使用统计失败:', error);
    throw error;
  }
};

// 实例方法：检查每日请求限制
authorizedUserKeySchema.methods.checkDailyLimit = async function() {
  if (this.permissions.dailyRequestLimit === 0) {
    return { allowed: true, remaining: -1 }; // 无限制
  }
  
  try {
    // 获取今日开始时间
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // 查询今日请求次数
    const dailyRequests = await this.constructor.aggregate([
      {
        $match: {
          userKey: this.userKey,
          lastUsedAt: {
            $gte: today,
            $lt: tomorrow
          }
        }
      },
      {
        $project: {
          totalRequests: '$usageStats.totalRequests'
        }
      }
    ]);
    
    const todayCount = dailyRequests.length > 0 ? dailyRequests[0].totalRequests : 0;
    const remaining = Math.max(0, this.permissions.dailyRequestLimit - todayCount);
    
    return {
      allowed: remaining > 0,
      remaining,
      dailyLimit: this.permissions.dailyRequestLimit,
      used: todayCount
    };
  } catch (error) {
    console.error('检查每日限制失败:', error);
    return { allowed: true, remaining: -1, error: error.message };
  }
};

// 静态方法：验证userKey是否有效
authorizedUserKeySchema.statics.validateUserKey = async function(userKey, requestInfo = {}) {
  try {
    const authKey = await this.findOne({ userKey });
    
    if (!authKey) {
      return { 
        valid: false, 
        reason: 'USER_KEY_NOT_FOUND',
        message: 'userKey未找到或未授权'
      };
    }
    
    if (!authKey.isValid()) {
      return { 
        valid: false, 
        reason: 'USER_KEY_INACTIVE',
        message: 'userKey已被禁用'
      };
    }
    
    // 检查每日限制
    const limitCheck = await authKey.checkDailyLimit();
    if (!limitCheck.allowed) {
      return {
        valid: false,
        reason: 'DAILY_LIMIT_EXCEEDED',
        message: '今日请求次数已达上限',
        limitInfo: limitCheck
      };
    }
    
    // 更新使用统计
    await authKey.updateUsage(requestInfo);
    
    return { 
      valid: true, 
      authKey,
      limitInfo: limitCheck
    };
  } catch (error) {
    console.error('验证userKey失败:', error);
    return { 
      valid: false, 
      reason: 'VALIDATION_ERROR',
      message: '验证过程中发生错误',
      error: error.message
    };
  }
};

// 静态方法：创建新的userKey
authorizedUserKeySchema.statics.createUserKey = async function(options = {}) {
  try {
    const userKey = uuidv4();
    
    const authKey = new this({
      userKey,
      description: options.description || '新创建的用户密钥',
      createdBy: options.createdBy || 'admin',
      permissions: {
        canSync: options.canSync !== false,
        canQuery: options.canQuery !== false,
        dailyRequestLimit: options.dailyRequestLimit || 0
      },
      notes: options.notes || ''
    });
    
    await authKey.save();
    
    return {
      success: true,
      userKey,
      authKey,
      message: 'userKey创建成功'
    };
  } catch (error) {
    console.error('创建userKey失败:', error);
    return {
      success: false,
      error: error.message,
      message: 'userKey创建失败'
    };
  }
};

// 静态方法：获取所有有效的userKey列表
authorizedUserKeySchema.statics.getActiveUserKeys = function(options = {}) {
  const query = { isActive: true };

  return this.find(query)
    .select('userKey description lastUsedAt usageStats permissions createdAt')
    .sort({ createdAt: -1 });
};

// 静态方法：禁用userKey
authorizedUserKeySchema.statics.deactivateUserKey = async function(userKey, reason = '') {
  try {
    const result = await this.updateOne(
      { userKey },
      { 
        isActive: false,
        updatedAt: new Date(),
        notes: reason ? `禁用原因: ${reason}` : 'userKey已被禁用'
      }
    );
    
    return {
      success: result.modifiedCount > 0,
      message: result.modifiedCount > 0 ? 'userKey已禁用' : 'userKey未找到'
    };
  } catch (error) {
    console.error('禁用userKey失败:', error);
    return {
      success: false,
      error: error.message,
      message: '禁用userKey失败'
    };
  }
};

// 静态方法：获取使用统计
authorizedUserKeySchema.statics.getUsageStats = async function(userKey = null) {
  try {
    const matchStage = userKey ? { userKey } : {};
    
    const stats = await this.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: userKey ? '$userKey' : null,
          totalUsers: { $sum: 1 },
          activeUsers: {
            $sum: {
              $cond: [{ $eq: ['$isActive', true] }, 1, 0]
            }
          },
          totalRequests: { $sum: '$usageStats.totalRequests' },
          totalSyncs: { $sum: '$usageStats.totalSyncs' },
          lastUsed: { $max: '$lastUsedAt' }
        }
      }
    ]);
    
    return stats.length > 0 ? stats[0] : {
      totalUsers: 0,
      activeUsers: 0,
      totalRequests: 0,
      totalSyncs: 0,
      lastUsed: null
    };
  } catch (error) {
    console.error('获取使用统计失败:', error);
    throw error;
  }
};

// 中间件：保存前更新时间戳
authorizedUserKeySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  if (this.isNew) {
    this.createdAt = new Date();
  }
  next();
});

module.exports = mongoose.model('AuthorizedUserKey', authorizedUserKeySchema);