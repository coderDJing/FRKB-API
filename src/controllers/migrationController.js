const mongoose = require('mongoose');
const fetch = require('node-fetch');
const { COLLECTIONS, HTTP_STATUS, CURATED_LIBRARY_SYNC, FINGERPRINT_REGEX, API_PREFIX } = require('../config/constants');
const logger = require('../utils/logger');
const blobStore = require('../services/curatedLibraryBlobStore');

// 需要迁移的集合列表（diff_sessions是临时数据，不迁移）
const MIGRATABLE_COLLECTIONS = [
  COLLECTIONS.AUTH_KEYS,
  COLLECTIONS.USER_FINGERPRINTS,
  COLLECTIONS.USER_META,
  COLLECTIONS.USER_CURATED_ARTIST_SNAPSHOTS,
  COLLECTIONS.USER_CURATED_LIBRARY_SNAPSHOTS,
  COLLECTIONS.USER_CURATED_LIBRARY_BLOBS
];

const COLLECTION_LABELS = {
  [COLLECTIONS.AUTH_KEYS]: '授权用户密钥',
  [COLLECTIONS.USER_FINGERPRINTS]: '用户指纹',
  [COLLECTIONS.USER_META]: '用户元数据',
  [COLLECTIONS.USER_CURATED_ARTIST_SNAPSHOTS]: '精选艺人快照',
  [COLLECTIONS.USER_CURATED_LIBRARY_SNAPSHOTS]: '精选库快照',
  [COLLECTIONS.USER_CURATED_LIBRARY_BLOBS]: '精选库音频元数据'
};

/**
 * 将MongoDB文档中的Buffer字段转为base64字符串（便于JSON传输）
 */
function serializeDoc(doc) {
  if (!doc) return doc;

  const serialized = { ...doc };

  // 处理 _id
  if (serialized._id instanceof mongoose.Types.ObjectId) {
    serialized._id = serialized._id.toString();
  }

  // 处理 Buffer 字段（bloomFilter）
  if (Buffer.isBuffer(serialized.bloomFilter)) {
    serialized.bloomFilter = {
      __type: 'Buffer',
      data: serialized.bloomFilter.toString('base64')
    };
  }

  // 递归处理嵌套对象中的Date和ObjectId
  for (const key of Object.keys(serialized)) {
    if (serialized[key] instanceof Date) {
      serialized[key] = { __type: 'Date', value: serialized[key].toISOString() };
    } else if (serialized[key] instanceof mongoose.Types.ObjectId) {
      serialized[key] = serialized[key].toString();
    }
  }

  return serialized;
}

/**
 * 将序列化的文档还原为MongoDB可用格式
 */
function deserializeDoc(doc) {
  if (!doc) return doc;

  const deserialized = { ...doc };

  // 处理 _id
  if (typeof deserialized._id === 'string') {
    deserialized._id = new mongoose.Types.ObjectId(deserialized._id);
  }

  // 还原 Buffer 字段
  if (deserialized.bloomFilter?.__type === 'Buffer') {
    deserialized.bloomFilter = Buffer.from(deserialized.bloomFilter.data, 'base64');
  }

  // 还原 Date 字段
  for (const key of Object.keys(deserialized)) {
    if (deserialized[key]?.__type === 'Date') {
      deserialized[key] = new Date(deserialized[key].value);
    }
  }

  return deserialized;
}

/**
 * 导出所有集合数据
 * GET /frkbapi/v1/admin/migration/export
 */
async function exportAll(req, res) {
  try {
    const db = mongoose.connection.db;
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: process.env.MONGODB_DATABASE || 'frkb_database',
      collections: {}
    };

    let totalDocs = 0;

    for (const collectionName of MIGRATABLE_COLLECTIONS) {
      const collection = db.collection(collectionName);
      const docs = await collection.find({}).toArray();
      exportData.collections[collectionName] = docs.map(serializeDoc);
      totalDocs += docs.length;

      logger.info(`导出集合 ${collectionName}: ${docs.length} 条记录`);
    }

    logger.admin('数据导出完成', {
      totalDocs,
      collections: MIGRATABLE_COLLECTIONS.length,
      ip: req.ip,
      blobNote: '精选库音频文件不进入 JSON，需通过 /admin/migration/blob/:sha256 或磁盘目录对账拷贝'
    });

    res.json({
      success: true,
      message: '数据导出成功',
      data: exportData,
      summary: {
        totalDocs,
        collections: MIGRATABLE_COLLECTIONS.map(name => ({
          name,
          label: COLLECTION_LABELS[name],
          count: exportData.collections[name].length
        }))
      }
    });

  } catch (error) {
    logger.error('数据导出失败', { error: error.message, stack: error.stack });
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'EXPORT_FAILED',
      message: `数据导出失败: ${error.message}`
    });
  }
}

/**
 * 导出单个集合
 * GET /frkbapi/v1/admin/migration/export/:collection
 */
async function exportCollection(req, res) {
  try {
    const { collection } = req.params;

    if (!MIGRATABLE_COLLECTIONS.includes(collection)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'INVALID_COLLECTION',
        message: `不可迁移的集合: ${collection}`,
        allowedCollections: MIGRATABLE_COLLECTIONS
      });
    }

    const db = mongoose.connection.db;
    const coll = db.collection(collection);
    const docs = await coll.find({}).toArray();

    logger.admin(`导出集合 ${collection}`, { count: docs.length, ip: req.ip });

    res.json({
      success: true,
      message: `集合 ${collection} 导出成功`,
      collection,
      label: COLLECTION_LABELS[collection],
      count: docs.length,
      data: docs.map(serializeDoc)
    });

  } catch (error) {
    logger.error('集合导出失败', { error: error.message, collection: req.params.collection });
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'EXPORT_FAILED',
      message: `集合导出失败: ${error.message}`
    });
  }
}

/**
 * 导入数据
 * POST /frkbapi/v1/admin/migration/import
 * body: { version, collections: { [collectionName]: [docs] } }
 */
async function importData(req, res) {
  try {
    const { version, collections } = req.body;

    if (!version || !collections) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'INVALID_IMPORT_DATA',
        message: '导入数据格式无效，需要 { version, collections }'
      });
    }

    const db = mongoose.connection.db;
    const results = {};
    let totalImported = 0;
    let totalSkipped = 0;

    for (const collectionName of MIGRATABLE_COLLECTIONS) {
      const docs = collections[collectionName];
      if (!docs || !Array.isArray(docs) || docs.length === 0) {
        results[collectionName] = { imported: 0, skipped: 0, status: 'no_data' };
        continue;
      }

      const collection = db.collection(collectionName);
      const deserializedDocs = docs.map(deserializeDoc);

      let imported = 0;
      let skipped = 0;

      // 使用 upsert 模式导入，避免重复数据报错
      for (const doc of deserializedDocs) {
        try {
          const filter = { _id: doc._id };
          await collection.replaceOne(filter, doc, { upsert: true });
          imported++;
        } catch (err) {
          // 如果是重复键错误，跳过
          if (err.code === 11000) {
            skipped++;
          } else {
            throw err;
          }
        }
      }

      results[collectionName] = {
        label: COLLECTION_LABELS[collectionName],
        imported,
        skipped,
        total: docs.length,
        status: 'ok'
      };

      totalImported += imported;
      totalSkipped += skipped;

      logger.info(`导入集合 ${collectionName}: ${imported} 条导入, ${skipped} 条跳过`);
    }

    logger.admin('数据导入完成', {
      totalImported,
      totalSkipped,
      ip: req.ip
    });

    const blobSync = await copyLocalBlobDirectoryIfConfigured();

    res.json({
      success: true,
      message: '数据导入成功',
      summary: {
        totalImported,
        totalSkipped,
        details: results,
        blobs: blobSync
      }
    });

  } catch (error) {
    logger.error('数据导入失败', { error: error.message, stack: error.stack });
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'IMPORT_FAILED',
      message: `数据导入失败: ${error.message}`
    });
  }
}

/**
 * 从源服务器拉取数据并导入
 * POST /frkbapi/v1/admin/migration/pull
 * body: { sourceUrl, adminToken }
 */
async function pullFromSource(req, res) {
  try {
    const { sourceUrl, adminToken } = req.body;

    if (!sourceUrl) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'MISSING_SOURCE_URL',
        message: '请提供源服务器地址 sourceUrl'
      });
    }

    if (!adminToken) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'MISSING_ADMIN_TOKEN',
        message: '请提供源服务器的管理员令牌 adminToken'
      });
    }

    // 构建导出URL
    const exportUrl = `${sourceUrl.replace(/\/$/, '')}${API_PREFIX}/admin/migration/export?adminToken=${encodeURIComponent(adminToken)}`;

    logger.admin('开始从源服务器拉取数据', { sourceUrl, ip: req.ip });

    // 拉取数据
    const response = await fetch(exportUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`源服务器返回错误: ${response.status} - ${errorText}`);
    }

    const exportResult = await response.json();

    if (!exportResult.success) {
      throw new Error(`源服务器导出失败: ${exportResult.message}`);
    }

    // 导入数据
    const db = mongoose.connection.db;
    const collections = exportResult.data.collections;
    const results = {};
    let totalImported = 0;
    let totalSkipped = 0;

    for (const collectionName of MIGRATABLE_COLLECTIONS) {
      const docs = collections[collectionName];
      if (!docs || !Array.isArray(docs) || docs.length === 0) {
        results[collectionName] = { imported: 0, skipped: 0, status: 'no_data' };
        continue;
      }

      const collection = db.collection(collectionName);
      const deserializedDocs = docs.map(deserializeDoc);

      let imported = 0;
      let skipped = 0;

      for (const doc of deserializedDocs) {
        try {
          const filter = { _id: doc._id };
          await collection.replaceOne(filter, doc, { upsert: true });
          imported++;
        } catch (err) {
          if (err.code === 11000) {
            skipped++;
          } else {
            throw err;
          }
        }
      }

      results[collectionName] = {
        label: COLLECTION_LABELS[collectionName],
        imported,
        skipped,
        total: docs.length,
        status: 'ok'
      };

      totalImported += imported;
      totalSkipped += skipped;
    }

    logger.admin('数据拉取导入完成', {
      sourceUrl,
      totalImported,
      totalSkipped,
      ip: req.ip
    });

    const blobSync = await syncBlobsFromSource({
      sourceUrl: sourceUrl.replace(/\/$/, ''),
      adminToken
    });

    res.json({
      success: true,
      message: '数据拉取导入成功',
      source: sourceUrl,
      summary: {
        totalImported,
        totalSkipped,
        details: results,
        blobs: blobSync
      }
    });

  } catch (error) {
    logger.error('数据拉取导入失败', { error: error.message, stack: error.stack });
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'PULL_FAILED',
      message: `数据拉取导入失败: ${error.message}`
    });
  }
}

/**
 * 管理员按 sha256 读取精选库音频（不进 JSON export）
 * GET /frkbapi/v1/admin/migration/blob/:sha256
 */
async function getBlob(req, res) {
  try {
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!FINGERPRINT_REGEX.test(sha256)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'INVALID_BLOB_HASH',
        message: 'sha256 无效'
      });
    }
    if (!(await blobStore.blobExists(sha256))) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'BLOB_NOT_FOUND',
        message: '音频文件不存在'
      });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${sha256}"`);
    blobStore.createBlobReadStream(sha256).pipe(res);
  } catch (error) {
    logger.error('导出精选库音频失败', { error: error.message, sha256: req.params.sha256 });
    if (!res.headersSent) {
      res.status(HTTP_STATUS.INTERNAL_ERROR).json({
        success: false,
        error: 'BLOB_EXPORT_FAILED',
        message: `导出音频失败: ${error.message}`
      });
    }
  }
}

/**
 * 管理员写入精选库音频
 * PUT /frkbapi/v1/admin/migration/blob/:sha256
 */
async function putBlob(req, res) {
  try {
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!FINGERPRINT_REGEX.test(sha256)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'INVALID_BLOB_HASH',
        message: 'sha256 无效'
      });
    }
    const size = Number(req.query.size || req.headers['content-length'] || 0);
    const readable = Buffer.isBuffer(req.body)
      ? require('stream').Readable.from(req.body)
      : req;
    const result = await blobStore.writeBlobFromStream(sha256, size, readable);
    res.json({
      success: true,
      sha256,
      size: result.size,
      alreadyReady: result.alreadyReady === true
    });
  } catch (error) {
    logger.error('导入精选库音频失败', { error: error.message, sha256: req.params.sha256 });
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'BLOB_IMPORT_FAILED',
      message: `导入音频失败: ${error.message}`
    });
  }
}

async function copyLocalBlobDirectoryIfConfigured() {
  const sourceRoot = String(process.env.CURATED_LIBRARY_BLOB_MIGRATE_SOURCE || '').trim();
  if (!sourceRoot) return { copied: 0, verified: 0, failed: 0, skipped: true };
  return blobStore.copyBlobDirectory(sourceRoot, CURATED_LIBRARY_SYNC.BLOB_ROOT);
}

async function collectBlobHashesFromDb() {
  const db = mongoose.connection.db;
  const rows = await db
    .collection(COLLECTIONS.USER_CURATED_LIBRARY_BLOBS)
    .find({})
    .project({ sha256: 1, size: 1 })
    .toArray();
  const unique = new Map();
  for (const row of rows) {
    const sha256 = String(row.sha256 || '').trim().toLowerCase();
    if (!FINGERPRINT_REGEX.test(sha256)) continue;
    unique.set(sha256, Number(row.size) || 0);
  }
  return unique;
}

async function syncBlobsFromSource({ sourceUrl, adminToken }) {
  const directoryCopy = await copyLocalBlobDirectoryIfConfigured();
  const unique = await collectBlobHashesFromDb();
  let downloaded = 0;
  let existed = 0;
  let failed = 0;
  for (const [sha256, size] of unique) {
    if (await blobStore.blobExists(sha256)) {
      existed += 1;
      continue;
    }
    try {
      const url = `${String(sourceUrl).replace(/\/$/, '')}${API_PREFIX}/admin/migration/blob/${sha256}?adminToken=${encodeURIComponent(adminToken)}`;
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        failed += 1;
        continue;
      }
      await blobStore.writeBlobFromStream(sha256, size, response.body);
      downloaded += 1;
    } catch (error) {
      logger.warn('拉取精选库音频失败', { sha256, error: error.message });
      failed += 1;
    }
  }
  return {
    directoryCopy,
    downloaded,
    existed,
    failed,
    total: unique.size
  };
}

/**
 * 获取迁移状态信息（查看本地数据概况）
 * GET /frkbapi/v1/admin/migration/status
 */
async function getMigrationStatus(req, res) {
  try {
    const db = mongoose.connection.db;
    const stats = {};

    for (const collectionName of MIGRATABLE_COLLECTIONS) {
      const collection = db.collection(collectionName);
      const count = await collection.countDocuments();
      stats[collectionName] = {
        label: COLLECTION_LABELS[collectionName],
        count
      };
    }

    res.json({
      success: true,
      database: process.env.MONGODB_DATABASE || 'frkb_database',
      collections: stats
    });

  } catch (error) {
    logger.error('获取迁移状态失败', { error: error.message });
    res.status(HTTP_STATUS.INTERNAL_ERROR).json({
      success: false,
      error: 'STATUS_FAILED',
      message: `获取迁移状态失败: ${error.message}`
    });
  }
}

module.exports = {
  exportAll,
  exportCollection,
  importData,
  pullFromSource,
  getMigrationStatus,
  getBlob,
  putBlob,
  MIGRATABLE_COLLECTIONS,
  COLLECTION_LABELS
};
