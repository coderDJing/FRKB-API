const mongoose = require('mongoose');
const { COLLECTIONS, USER_KEY_REGEX } = require('../config/constants');

const nodeSchema = new mongoose.Schema(
  {
    uuid: { type: String, required: true },
    parentUuid: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxLength: 255 },
    nodeType: { type: String, enum: ['dir', 'songList'], required: true },
    sortOrder: { type: Number, default: null },
    updatedAtMs: { type: Number, required: true },
    revision: { type: Number, default: null }
  },
  { _id: false }
);

const fileSchema = new mongoose.Schema(
  {
    fileId: { type: String, required: true },
    parentUuid: { type: String, required: true },
    fileName: { type: String, required: true, trim: true, maxLength: 255 },
    sha256: { type: String, required: true, lowercase: true },
    size: { type: Number, required: true, min: 0 },
    trackNumber: { type: Number, default: null },
    addedAtMs: { type: Number, default: null },
    updatedAtMs: { type: Number, required: true },
    revision: { type: Number, default: null }
  },
  { _id: false }
);

const tombstoneSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['file', 'node'], required: true },
    id: { type: String, required: true },
    revision: { type: Number, required: true },
    deletedAtMs: { type: Number, required: true }
  },
  { _id: false }
);

const snapshotSchema = new mongoose.Schema(
  {
    userKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      validate: {
        validator(value) {
          return USER_KEY_REGEX.test(value);
        },
        message: 'userKey必须是有效的UUID v4格式'
      }
    },
    protocolVersion: { type: Number, default: 1 },
    revision: { type: Number, default: 0, min: 0 },
    snapshotReady: { type: Boolean, default: false, index: true },
    firstSnapshotSessionId: { type: String, default: null },
    firstSnapshotLockUntil: { type: Date, default: null },
    nodes: { type: [nodeSchema], default: [] },
    files: { type: [fileSchema], default: [] },
    tombstones: { type: [tombstoneSchema], default: [] },
    lastSyncAt: { type: Date, default: null },
    lastUpdateAt: { type: Date, default: Date.now }
  },
  {
    collection: COLLECTIONS.USER_CURATED_LIBRARY_SNAPSHOTS,
    timestamps: true,
    versionKey: false
  }
);

snapshotSchema.statics.getOrCreate = async function getOrCreate(userKey) {
  let snapshot = await this.findOne({ userKey });
  if (!snapshot) {
    snapshot = await this.create({
      userKey,
      protocolVersion: 1,
      revision: 0,
      snapshotReady: false,
      nodes: [],
      files: [],
      tombstones: []
    });
  }
  return snapshot;
};

module.exports = mongoose.model('UserCuratedLibrarySnapshot', snapshotSchema);
