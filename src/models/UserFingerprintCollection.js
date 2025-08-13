const mongoose = require('mongoose');
const { COLLECTIONS } = require('../config/constants');

/**
 * 用户指纹集合模型（64 位十六进制 SHA256）
 */
const userFingerprintCollectionSchema = new mongoose.Schema({
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

  // 指纹值（64 位十六进制 SHA256）
  fingerprint: {
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        return /^[a-f0-9]{64}$/i.test(v);
      },
      message: '指纹格式不正确，必须是64位十六进制字符（SHA256）'
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
  collection: COLLECTIONS.USER_FINGERPRINTS,
  timestamps: true,
  versionKey: false
});

// 复合索引：userKey + fingerprint 组合唯一
userFingerprintCollectionSchema.index({ userKey: 1, fingerprint: 1 }, { unique: true });
// 按用户Key查询的索引
userFingerprintCollectionSchema.index({ userKey: 1, createdAt: -1 });

// 实例方法：验证指纹格式
userFingerprintCollectionSchema.methods.validateFingerprint = function() {
  return /^[a-f0-9]{64}$/i.test(this.fingerprint);
};

// 静态方法：按用户获取全部（可选项）
userFingerprintCollectionSchema.statics.findByUserKey = function(userKey, options = {}) {
  const query = this.find({ userKey });
  if (options.limit) query.limit(options.limit);
  if (options.skip) query.skip(options.skip);
  if (options.sort) query.sort(options.sort);
  return query;
};

// 静态方法：批量添加指纹
userFingerprintCollectionSchema.statics.addBatch = async function(userKey, fingerprintArray) {
  const docs = fingerprintArray.map(fp => ({
    userKey,
    fingerprint: fp.toLowerCase(),
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  try {
    const result = await this.insertMany(docs, { ordered: false, rawResult: true });
    return {
      success: true,
      insertedCount: result.insertedCount,
      duplicateCount: fingerprintArray.length - result.insertedCount
    };
  } catch (error) {
    if (error.code === 11000) {
      const insertedCount = error.result?.result?.writeErrors ?
        fingerprintArray.length - error.result.result.writeErrors.length : 0;
      return {
        success: true,
        insertedCount,
        duplicateCount: fingerprintArray.length - insertedCount,
        duplicateErrors: error.result?.result?.writeErrors || []
      };
    }
    throw error;
  }
};

// 静态方法：获取用户指纹总数
userFingerprintCollectionSchema.statics.getUserFingerprintCount = function(userKey) {
  return this.countDocuments({ userKey });
};

// 静态方法：检查指纹是否存在
userFingerprintCollectionSchema.statics.checkFingerprintExists = function(userKey, fingerprintArray) {
  return this.find({
    userKey,
    fingerprint: { $in: fingerprintArray.map(fp => fp.toLowerCase()) }
  }).select('fingerprint').lean();
};

// 静态方法：获取差异（客户端缺失与服务端缺失）
userFingerprintCollectionSchema.statics.findMissingFingerprints = async function(userKey, clientFingerprints) {
  const serverFingerprints = await this.find({ userKey })
    .select('fingerprint')
    .lean()
    .then(docs => docs.map(doc => doc.fingerprint));

  const clientSet = new Set(clientFingerprints.map(fp => fp.toLowerCase()));
  const serverSet = new Set(serverFingerprints);

  const missingInClient = serverFingerprints.filter(fp => !clientSet.has(fp));
  const missingInServer = clientFingerprints
    .map(fp => fp.toLowerCase())
    .filter(fp => !serverSet.has(fp));

  return {
    missingInClient,
    missingInServer,
    totalServer: serverFingerprints.length,
    totalClient: clientFingerprints.length
  };
};

// 保存前标准化为小写
userFingerprintCollectionSchema.pre('save', function(next) {
  if (this.fingerprint) {
    this.fingerprint = this.fingerprint.toLowerCase();
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('UserFingerprintCollection', userFingerprintCollectionSchema);


