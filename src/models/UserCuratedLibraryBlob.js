const mongoose = require('mongoose');
const { COLLECTIONS, USER_KEY_REGEX, FINGERPRINT_REGEX } = require('../config/constants');

const blobSchema = new mongoose.Schema(
  {
    userKey: {
      type: String,
      required: true,
      index: true,
      validate: {
        validator(value) {
          return USER_KEY_REGEX.test(value);
        },
        message: 'userKey必须是有效的UUID v4格式'
      }
    },
    sha256: {
      type: String,
      required: true,
      lowercase: true,
      validate: {
        validator(value) {
          return FINGERPRINT_REGEX.test(value);
        },
        message: 'sha256必须是64位十六进制'
      }
    },
    size: { type: Number, required: true, min: 0 },
    ready: { type: Boolean, default: false, index: true }
  },
  {
    collection: COLLECTIONS.USER_CURATED_LIBRARY_BLOBS,
    timestamps: true,
    versionKey: false
  }
);

blobSchema.index({ userKey: 1, sha256: 1 }, { unique: true });
blobSchema.index({ sha256: 1, ready: 1 });

module.exports = mongoose.model('UserCuratedLibraryBlob', blobSchema);
