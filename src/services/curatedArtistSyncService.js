const UserCuratedArtistSnapshot = require('../models/UserCuratedArtistSnapshot');
const { ERROR_CODES } = require('../config/constants');

class CuratedArtistSyncService {
  buildSnapshotError(message, details = {}) {
    const error = new Error(message);
    error.status = 400;
    error.code = ERROR_CODES.INVALID_CURATED_ARTIST_SNAPSHOT;
    error.details = details;
    return error;
  }

  buildSnapshotPayload(stats, items, extra = {}) {
    return {
      artistCount: stats.totalArtists,
      totalCount: stats.totalCount,
      fingerprintCount: stats.totalFingerprints,
      hash: stats.collectionHash,
      items: items.map((item) => ({
        name: item.name,
        count: item.count,
        fingerprints: item.fingerprints
      })),
      ...extra
    };
  }

  resolveReason({ alreadySynced, changed, serverStats, clientStats }) {
    if (alreadySynced) return 'already_synced';
    if (serverStats.totalArtists === 0 && clientStats.totalArtists > 0) return 'server_empty';
    if (clientStats.totalArtists === 0 && serverStats.totalArtists > 0) return 'client_empty';
    if (changed) return 'merged';
    return 'client_outdated';
  }

  resolveMessage(reason) {
    switch (reason) {
      case 'already_synced':
        return '精选艺人数据已同步，无需更新';
      case 'server_empty':
        return '服务端无精选艺人数据，已接收客户端快照';
      case 'client_empty':
        return '客户端无精选艺人数据，已返回服务端快照';
      case 'merged':
        return '精选艺人数据已完成双向合并';
      case 'client_outdated':
      default:
        return '客户端数据较旧，请使用服务端返回快照覆盖本地';
    }
  }

  assertDeclaredSnapshot(clientStats, declaredCount, declaredHash) {
    if (declaredCount !== undefined && declaredCount !== clientStats.totalArtists) {
      throw this.buildSnapshotError('count与artists归一化后的数量不一致', {
        declaredCount,
        normalizedArtistCount: clientStats.totalArtists
      });
    }

    if (declaredHash && declaredHash !== clientStats.collectionHash) {
      throw this.buildSnapshotError('hash与artists归一化后的快照哈希不一致', {
        declaredHash,
        normalizedHash: clientStats.collectionHash
      });
    }
  }

  async syncSnapshot(userKey, artists, options = {}) {
    const startedAt = Date.now();
    const normalizedClientItems = UserCuratedArtistSnapshot.normalizeItems(artists);
    const clientStats = UserCuratedArtistSnapshot.buildSnapshotStats(normalizedClientItems);

    this.assertDeclaredSnapshot(
      clientStats,
      Number.isFinite(options.count) ? options.count : undefined,
      typeof options.hash === 'string' ? options.hash.trim().toLowerCase() : ''
    );

    const snapshotDoc = await UserCuratedArtistSnapshot.getOrCreate(userKey);
    const previousLastSyncAt = snapshotDoc.lastSyncAt;
    const serverItems = UserCuratedArtistSnapshot.normalizeItems(snapshotDoc.items || []);
    const serverStats = UserCuratedArtistSnapshot.buildSnapshotStats(serverItems);
    const alreadySynced =
      serverStats.totalArtists === clientStats.totalArtists &&
      serverStats.collectionHash === clientStats.collectionHash;

    const mergedItems = alreadySynced
      ? serverItems
      : UserCuratedArtistSnapshot.mergeItems(serverItems, normalizedClientItems);
    const mergedStats = UserCuratedArtistSnapshot.buildSnapshotStats(mergedItems);
    const changed = mergedStats.collectionHash !== serverStats.collectionHash;

    if (changed) {
      snapshotDoc.items = mergedItems;
      snapshotDoc.lastSyncAt = new Date();
      snapshotDoc.syncStats.totalSyncs += 1;
      snapshotDoc.syncStats.lastSyncMergedArtists = mergedStats.totalArtists;
      snapshotDoc.syncStats.lastSyncDuration = Date.now() - startedAt;
      await snapshotDoc.save();
    }

    const reason = this.resolveReason({
      alreadySynced,
      changed,
      serverStats,
      clientStats
    });

    return {
      needSync: !alreadySynced,
      changed,
      reason,
      message: this.resolveMessage(reason),
      clientSnapshot: this.buildSnapshotPayload(clientStats, normalizedClientItems),
      serverSnapshotBefore: this.buildSnapshotPayload(serverStats, serverItems, {
        lastSyncAt: previousLastSyncAt
      }),
      mergedSnapshot: this.buildSnapshotPayload(mergedStats, mergedItems, {
        lastSyncAt: snapshotDoc.lastSyncAt
      }),
      performance: {
        syncDuration: Date.now() - startedAt
      }
    };
  }
}

module.exports = new CuratedArtistSyncService();
