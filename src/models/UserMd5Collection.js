const mongoose = require('mongoose');
const { COLLECTIONS } = require('../config/constants');

/**
 * 用户MD5集合模型
 * 存储每个用户的MD5值集合
 */
const userMd5CollectionSchema = new mongoose.Schema({
  // 用户标识
  userKey: {
    type: String,
    required: true,
    index: true,
    validate: {
      validator: function(v) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
      },
      message: 'userKey必须是有效的UUID v4格式'
    }
  },

  // MD5值
  md5: {
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        return /^[a-f0-9]{32}$/i.test(v);
      },
      message: 'MD5值格式不正确，必须是32位十六进制字符'
    }
  },

  // 创建时间
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  // 最后更新时间
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  // 集合名称
  collection: COLLECTIONS.USER_MD5,
  
  // 启用时间戳
  timestamps: true,
  
  // 优化设置
  versionKey: false
});

// 复合索引：userKey + md5 组合唯一
userMd5CollectionSchema.index({ userKey: 1, md5: 1 }, { unique: true });

// 按用户Key查询的索引
userMd5CollectionSchema.index({ userKey: 1, createdAt: -1 });

// 实例方法：验证MD5格式
userMd5CollectionSchema.methods.validateMd5 = function() {
  return /^[a-f0-9]{32}$/i.test(this.md5);
};

// 静态方法：按用户获取所有MD5
userMd5CollectionSchema.statics.findByUserKey = function(userKey, options = {}) {
  const query = this.find({ userKey });
  
  if (options.limit) {
    query.limit(options.limit);
  }
  
  if (options.skip) {
    query.skip(options.skip);
  }
  
  if (options.sort) {
    query.sort(options.sort);
  }
  
  return query;
};

// 静态方法：批量添加MD5
userMd5CollectionSchema.statics.addBatch = async function(userKey, md5Array) {
  const docs = md5Array.map(md5 => ({
    userKey,
    md5: md5.toLowerCase(),
    createdAt: new Date(),
    updatedAt: new Date()
  }));
  
  try {
    // 使用insertMany的ordered: false来跳过重复项
    const result = await this.insertMany(docs, { 
      ordered: false,
      rawResult: true
    });
    
    return {
      success: true,
      insertedCount: result.insertedCount,
      duplicateCount: md5Array.length - result.insertedCount
    };
  } catch (error) {
    // 处理重复键错误
    if (error.code === 11000) {
      const insertedCount = error.result?.result?.writeErrors ? 
        md5Array.length - error.result.result.writeErrors.length : 0;
      
      return {
        success: true,
        insertedCount,
        duplicateCount: md5Array.length - insertedCount,
        duplicateErrors: error.result?.result?.writeErrors || []
      };
    }
    
    throw error;
  }
};

// 静态方法：获取用户MD5总数
userMd5CollectionSchema.statics.getUserMd5Count = function(userKey) {
  return this.countDocuments({ userKey });
};

// 静态方法：检查MD5是否存在
userMd5CollectionSchema.statics.checkMd5Exists = function(userKey, md5Array) {
  return this.find({ 
    userKey, 
    md5: { $in: md5Array.map(md5 => md5.toLowerCase()) }
  }).select('md5').lean();
};

// 静态方法：获取差异MD5
userMd5CollectionSchema.statics.findMissingMd5s = async function(userKey, clientMd5s) {
  // 获取服务端所有MD5
  const serverMd5s = await this.find({ userKey })
    .select('md5')
    .lean()
    .then(docs => docs.map(doc => doc.md5));
  
  const clientSet = new Set(clientMd5s.map(md5 => md5.toLowerCase()));
  const serverSet = new Set(serverMd5s);
  
  // 找出客户端缺失的MD5（服务端有，客户端没有）
  const missingInClient = serverMd5s.filter(md5 => !clientSet.has(md5));
  
  // 找出服务端缺失的MD5（客户端有，服务端没有）
  const missingInServer = clientMd5s
    .map(md5 => md5.toLowerCase())
    .filter(md5 => !serverSet.has(md5));
  
  return {
    missingInClient,
    missingInServer,
    totalServer: serverMd5s.length,
    totalClient: clientMd5s.length
  };
};

// 中间件：保存前转换MD5为小写
userMd5CollectionSchema.pre('save', function(next) {
  if (this.md5) {
    this.md5 = this.md5.toLowerCase();
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('UserMd5Collection', userMd5CollectionSchema);