const mongoose = require('mongoose');
const { COLLECTIONS, SYNC_CONFIG } = require('../config/constants');

/**
 * 差异会话模型（持久化，带TTL）
 */
const diffSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
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
  clientFingerprints: { type: [String], default: [] },
  missingInClient: { type: [String], default: [] },
  missingInServer: { type: [String], default: [] },
  sortedMissingInClient: { type: [String], default: [] },
  totalClient: { type: Number, default: 0 },
  totalServer: { type: Number, default: 0 },
  processed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true },
  // TTL 字段：基于 createdAt 自动过期
  expiresAt: { type: Date, required: true, expires: 0, index: true }
}, {
  collection: COLLECTIONS.DIFF_SESSIONS,
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  versionKey: false
});

// 在保存之前，确保 expiresAt = createdAt + TTL
diffSessionSchema.pre('validate', function(next) {
  const ttlMs = (SYNC_CONFIG.DIFF_SESSION_TTL || 300) * 1000;
  if (!this.createdAt) {
    this.createdAt = new Date();
  }
  this.expiresAt = new Date(this.createdAt.getTime() + ttlMs);
  next();
});

module.exports = mongoose.model('DiffSession', diffSessionSchema);


