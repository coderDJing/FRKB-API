const mongoose = require('mongoose');
const crypto = require('crypto');
const { COLLECTIONS, FINGERPRINT_REGEX } = require('../config/constants');

function normalizeArtistName(value) {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  return text ? text.toLocaleLowerCase() : '';
}

function sanitizeArtistName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function sanitizeArtistCount(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.round(numeric));
}

function normalizeFingerprintList(values) {
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const fingerprints = [];

  for (const value of values) {
    const fingerprint = String(value || '').trim().toLowerCase();
    if (!FINGERPRINT_REGEX.test(fingerprint) || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    fingerprints.push(fingerprint);
  }

  fingerprints.sort();
  return fingerprints;
}

function normalizeCuratedArtistItems(values) {
  const merged = new Map();

  for (const value of Array.isArray(values) ? values : []) {
    const rawName = sanitizeArtistName(value?.name);
    const normalizedName = normalizeArtistName(rawName);
    if (!normalizedName) continue;

    const fingerprints = normalizeFingerprintList(value?.fingerprints);
    const nextCount = sanitizeArtistCount(value?.count, 1);
    const existing = merged.get(normalizedName);

    if (!existing) {
      merged.set(normalizedName, {
        normalizedName,
        name: rawName,
        count: Math.max(nextCount, fingerprints.length || 0, 1),
        fingerprints
      });
      continue;
    }

    if (!existing.name && rawName) {
      existing.name = rawName;
    }

    const fingerprintSet = new Set(existing.fingerprints);
    for (const fingerprint of fingerprints) {
      fingerprintSet.add(fingerprint);
    }

    existing.fingerprints = Array.from(fingerprintSet).sort();
    existing.count = Math.max(
      existing.count,
      nextCount,
      existing.fingerprints.length || 0,
      1
    );
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.normalizedName.localeCompare(right.normalizedName)
  );
}

function calculateCollectionHash(items) {
  const normalizedItems = normalizeCuratedArtistItems(items);
  const canonical = normalizedItems.map((item) => [
    item.normalizedName,
    item.count,
    item.fingerprints
  ]);

  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function buildSnapshotStats(items) {
  const normalizedItems = normalizeCuratedArtistItems(items);

  return {
    totalArtists: normalizedItems.length,
    totalCount: normalizedItems.reduce((sum, item) => sum + item.count, 0),
    totalFingerprints: normalizedItems.reduce((sum, item) => sum + item.fingerprints.length, 0),
    collectionHash: calculateCollectionHash(normalizedItems)
  };
}

function mergeSnapshotItems(baseItems, incomingItems) {
  return normalizeCuratedArtistItems([
    ...normalizeCuratedArtistItems(baseItems),
    ...normalizeCuratedArtistItems(incomingItems)
  ]);
}

const curatedArtistItemSchema = new mongoose.Schema(
  {
    normalizedName: {
      type: String,
      required: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxLength: 200
    },
    count: {
      type: Number,
      required: true,
      min: 1
    },
    fingerprints: {
      type: [String],
      default: []
    }
  },
  {
    _id: false
  }
);

const userCuratedArtistSnapshotSchema = new mongoose.Schema(
  {
    userKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      validate: {
        validator(v) {
          return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
        },
        message: 'userKey必须是有效的UUID v4格式'
      }
    },
    items: {
      type: [curatedArtistItemSchema],
      default: []
    },
    totalArtists: {
      type: Number,
      default: 0,
      min: 0
    },
    totalCount: {
      type: Number,
      default: 0,
      min: 0
    },
    totalFingerprints: {
      type: Number,
      default: 0,
      min: 0
    },
    collectionHash: {
      type: String,
      default: () => calculateCollectionHash([]),
      index: true
    },
    lastSyncAt: {
      type: Date,
      default: null,
      index: true
    },
    lastUpdateAt: {
      type: Date,
      default: Date.now
    },
    syncStats: {
      totalSyncs: {
        type: Number,
        default: 0
      },
      lastSyncMergedArtists: {
        type: Number,
        default: 0
      },
      lastSyncDuration: {
        type: Number,
        default: 0
      }
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    collection: COLLECTIONS.USER_CURATED_ARTIST_SNAPSHOTS,
    timestamps: true,
    versionKey: false
  }
);

userCuratedArtistSnapshotSchema.index({ lastSyncAt: -1 });
userCuratedArtistSnapshotSchema.index({ totalArtists: 1 });
userCuratedArtistSnapshotSchema.index({ totalCount: 1 });

userCuratedArtistSnapshotSchema.statics.normalizeArtistName = normalizeArtistName;
userCuratedArtistSnapshotSchema.statics.normalizeItems = normalizeCuratedArtistItems;
userCuratedArtistSnapshotSchema.statics.mergeItems = mergeSnapshotItems;
userCuratedArtistSnapshotSchema.statics.calculateCollectionHash = calculateCollectionHash;
userCuratedArtistSnapshotSchema.statics.buildSnapshotStats = buildSnapshotStats;

userCuratedArtistSnapshotSchema.statics.getOrCreate = async function(userKey) {
  let snapshot = await this.findOne({ userKey });

  if (!snapshot) {
    snapshot = await this.create({
      userKey,
      items: [],
      totalArtists: 0,
      totalCount: 0,
      totalFingerprints: 0,
      collectionHash: calculateCollectionHash([]),
      lastSyncAt: null,
      lastUpdateAt: new Date()
    });
  }

  return snapshot;
};

userCuratedArtistSnapshotSchema.pre('save', function(next) {
  const normalizedItems = normalizeCuratedArtistItems(this.items || []);
  const stats = buildSnapshotStats(normalizedItems);

  this.items = normalizedItems;
  this.totalArtists = stats.totalArtists;
  this.totalCount = stats.totalCount;
  this.totalFingerprints = stats.totalFingerprints;
  this.collectionHash = stats.collectionHash;
  this.lastUpdateAt = new Date();
  this.updatedAt = new Date();

  if (this.isNew) {
    this.createdAt = new Date();
  }

  next();
});

module.exports = mongoose.model('UserCuratedArtistSnapshot', userCuratedArtistSnapshotSchema);
