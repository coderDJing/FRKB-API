# 双向同步算法详解

## 同步算法概述

双向同步算法确保客户端和服务端的指纹集合（SHA256）最终完全一致，采用“只增不减”策略保证数据完整性。

### 核心原理

```
同步前：
客户端: [A, B, C, D]      (4万个指纹)
服务端: [B, C, E, F, G]   (5万个指纹)

算法处理：
1. 找出客户端独有: [A, D]
2. 找出服务端独有: [E, F, G]
3. 双向传输: 客户端获取[E,F,G]，服务端获取[A,D]

同步后：
客户端: [A, B, C, D, E, F, G]  (6万个指纹)
服务端: [A, B, C, D, E, F, G]  (6万个指纹)
```

## 完整同步流程

### 1. 预检查阶段

```javascript
async function preCheckSync(userKey, clientFingerprintArray) {
  // 1. 计算客户端集合哈希（指纹集合，SHA256）
  const clientHash = calculateSetHash(clientFingerprintArray);
  const clientCount = clientFingerprintArray.length;
  
  // 2. 获取服务端信息
  const serverCount = await UserFingerprintCollection.countDocuments({ userKey });
  
  if (serverCount === 0) {
    return {
      needSync: true,
      strategy: 'first_upload', // 首次上传
      serverCount: 0
    };
  }
  
  // 3. 计算服务端集合哈希
  const serverFps = await UserFingerprintCollection
    .find({ userKey })
    .select('fingerprint')
    .lean();
  const serverHash = calculateSetHash(serverFps.map(doc => doc.fingerprint));
  
  // 4. 比较哈希值
  if (clientHash === serverHash) {
    return {
      needSync: false,
      message: '数据已同步'
    };
  }
  
  return {
    needSync: true,
    strategy: determineStrategy(clientCount, serverCount),
    serverCount,
    clientCount,
    clientHash,
    serverHash
  };
}
```

### 2. 策略选择算法

```javascript
function determineStrategy(clientCount, serverCount) {
  const diff = Math.abs(clientCount - serverCount);
  const larger = Math.max(clientCount, serverCount);
  const diffRatio = diff / Math.max(larger, 1);
  
  // 首次同步
  if (clientCount === 0) {
    return 'pull_all';
  }
  
  if (serverCount === 0) {
    return 'push_all';
  }
  
  // 差异很小 (< 5%)
  if (diffRatio < 0.05) {
    return 'incremental_diff';
  }
  
  // 差异中等 (5% - 20%)
  if (diffRatio < 0.20) {
    return 'bidirectional_diff';
  }
  
  // 差异很大 (> 20%)
  return 'full_sync';
}
```

### 3. 核心同步算法

#### 双向差异检测算法

```javascript
async function bidirectionalDiffAlgorithm(userKey, clientFingerprintArray) {
  console.log(`🔄 开始双向差异检测: 客户端${clientFingerprintArray.length}个指纹`);
  
  const BATCH_SIZE = 1000;
  const missingOnClient = new Set();
  const missingOnServer = new Set();
  
  // 1. 获取完整的服务端数据
  const allServerFps = await UserFingerprintCollection
    .find({ userKey })
    .select('fingerprint')
    .lean();
  
  const serverFingerprintSet = new Set(allServerFps.map(doc => doc.fingerprint));
  const clientFingerprintSet = new Set(clientFingerprintArray);
  
  console.log(`📊 服务端${serverFingerprintSet.size}个指纹，客户端${clientFingerprintSet.size}个指纹`);
  
  // 2. 找出服务端独有的指纹（客户端需要拉取）
  for (const serverFp of serverFingerprintSet) {
    if (!clientFingerprintSet.has(serverFp)) {
      missingOnClient.add(serverFp);
    }
  }
  
  // 3. 分批处理客户端指纹，找出服务端缺失的
  for (let i = 0; i < clientFingerprintArray.length; i += BATCH_SIZE) {
    const batch = clientFingerprintArray.slice(i, i + BATCH_SIZE);
    
    // 使用布隆过滤器优化（如果可用）
    const batchMissingOnServer = await findMissingInServer(userKey, batch, serverFingerprintSet);
    
    batchMissingOnServer.forEach(fp => missingOnServer.add(fp));
    
    console.log(`📈 进度: ${Math.min(i + BATCH_SIZE, clientFingerprintArray.length)}/${clientFingerprintArray.length}`);
  }
  
  const result = {
    missingOnClient: Array.from(missingOnClient),
    missingOnServer: Array.from(missingOnServer),
    summary: {
      clientNeedsPull: missingOnClient.size,
      serverNeedsPush: missingOnServer.size,
      totalAfterSync: serverFingerprintSet.size + missingOnServer.size
    }
  };
  
  console.log(`✅ 差异检测完成: 客户端需拉取${result.summary.clientNeedsPull}个，服务端需推送${result.summary.serverNeedsPush}个`);
  
  return result;
}

// 优化的服务端缺失检测
async function findMissingInServer(userKey, clientBatch, serverFingerprintSet) {
  // 方法1：直接使用内存中的Set（推荐，性能最好）
  if (serverFingerprintSet) {
    return clientBatch.filter(fp => !serverFingerprintSet.has(fp));
  }
  
  // 方法2：使用布隆过滤器 + 数据库查询
  const bloomFilter = await bloomFilterService.getOrCreate(userKey);
  
  // 布隆过滤器快速筛选
  const possibleMissing = clientBatch.filter(fp => !bloomFilter.has(fp));
  
  if (possibleMissing.length === 0) {
    return [];
  }
  
  // 精确查询
  const existing = await UserFingerprintCollection.find({
    userKey,
    fingerprint: { $in: possibleMissing }
  }).select('fingerprint').lean();
  
  const existingSet = new Set(existing.map(doc => doc.fingerprint));
  return possibleMissing.filter(fp => !existingSet.has(fp));
}
```

### 4. 分批传输算法

#### 客户端拉取算法

```javascript
async function pullMissingData(userKey, missingFingerprintArray) {
  console.log(`📥 开始拉取${missingFingerprintArray.length}个缺失的指纹`);
  
  const BATCH_SIZE = 1000;
  const pulledData = [];
  
  for (let i = 0; i < missingFingerprintArray.length; i += BATCH_SIZE) {
    const batch = missingFingerprintArray.slice(i, i + BATCH_SIZE);
    
    try {
      // 从服务端获取这批指纹数据
      const batchData = await UserFingerprintCollection.find({
        userKey,
        fingerprint: { $in: batch }
      }).select('fingerprint').lean();
      
      const batchFingerprints = batchData.map(doc => doc.fingerprint);
      pulledData.push(...batchFingerprints);
      
      console.log(`📥 拉取进度: ${Math.min(i + BATCH_SIZE, missingFingerprintArray.length)}/${missingFingerprintArray.length}`);
      
    } catch (error) {
      console.error(`❌ 拉取批次${i}-${i + BATCH_SIZE}失败:`, error.message);
      // 继续处理下一批
    }
  }
  
  console.log(`✅ 拉取完成: 成功获取${pulledData.length}个指纹`);
  return pulledData;
}
```

#### 服务端推送算法

```javascript
async function pushMissingData(userKey, missingFingerprintArray) {
  console.log(`📤 开始推送${missingFingerprintArray.length}个缺失的指纹到服务端`);
  
  const BATCH_SIZE = 1000;
  let totalPushed = 0;
  
  for (let i = 0; i < missingFingerprintArray.length; i += BATCH_SIZE) {
    const batch = missingFingerprintArray.slice(i, i + BATCH_SIZE);
    
    try {
      // 批量upsert操作
      const operations = batch.map(fp => ({
        updateOne: {
          filter: { userKey, fingerprint: fp },
          update: { 
            $setOnInsert: { 
              userKey, 
              fingerprint: fp, 
              createdAt: new Date() 
            }
          },
          upsert: true
        }
      }));
      
      const result = await UserFingerprintCollection.bulkWrite(operations, {
        ordered: false // 允许并发，提高性能
      });
      
      totalPushed += result.upsertedCount;
      
      console.log(`📤 推送进度: ${Math.min(i + BATCH_SIZE, missingFingerprintArray.length)}/${missingFingerprintArray.length} (新增${result.upsertedCount})`);
      
    } catch (error) {
      console.error(`❌ 推送批次${i}-${i + BATCH_SIZE}失败:`, error.message);
      // 继续处理下一批
    }
  }
  
  console.log(`✅ 推送完成: 成功新增${totalPushed}个指纹到服务端`);
  return totalPushed;
}
```

### 5. 完整同步实现

```javascript
async function completeBidirectionalSync(userKey, clientFingerprintArray) {
  const startTime = Date.now();
  console.log(`🚀 开始完整双向同步: userKey=${userKey}, 客户端指纹数量=${clientFingerprintArray.length}`);
  
  try {
    // 1. 预检查
    const preCheck = await preCheckSync(userKey, clientFingerprintArray);
    
    if (!preCheck.needSync) {
      console.log('✅ 数据已同步，无需处理');
      return {
        success: true,
        message: '数据已同步',
        finalFingerprintArray: clientFingerprintArray,
        stats: {
          pulled: 0,
          pushed: 0,
          syncTime: Date.now() - startTime
        }
      };
    }
    
    console.log(`📋 同步策略: ${preCheck.strategy}`);
    
    // 2. 根据策略执行同步
    let finalFingerprintArray = [...clientFingerprintArray];
    let pullCount = 0;
    let pushCount = 0;
    
    if (preCheck.strategy === 'first_upload') {
      // 首次上传：直接推送所有客户端数据
      pushCount = await pushMissingData(userKey, clientFingerprintArray);
      
    } else if (preCheck.strategy === 'pull_all') {
      // 全量拉取：客户端为空，拉取所有服务端数据
      const allServerData = await pullAllServerData(userKey);
      finalFingerprintArray = allServerData;
      pullCount = allServerData.length;
      
    } else {
      // 双向差异同步
      const diffResult = await bidirectionalDiffAlgorithm(userKey, clientFingerprintArray);
      
      // 3. 客户端拉取服务端独有的数据
      if (diffResult.missingOnClient.length > 0) {
        const pulledData = await pullMissingData(userKey, diffResult.missingOnClient);
        finalFingerprintArray.push(...pulledData);
        pullCount = pulledData.length;
      }
      
      // 4. 推送客户端独有的数据到服务端
      if (diffResult.missingOnServer.length > 0) {
        pushCount = await pushMissingData(userKey, diffResult.missingOnServer);
      }
    }
    
    // 5. 去重并排序
    finalFingerprintArray = [...new Set(finalFingerprintArray)];
    
    // 6. 更新用户集合元信息
    await updateUserCollectionMeta(userKey, finalFingerprintArray);
    
    const syncTime = Date.now() - startTime;
    
    console.log(`🎉 双向同步完成！`);
  console.log(`📊 最终统计: 指纹总数=${finalFingerprintArray.length}, 拉取=${pullCount}, 推送=${pushCount}`);
    console.log(`⏱️ 同步耗时: ${syncTime}ms`);
    
    return {
      success: true,
      message: '双向同步完成',
      finalFingerprintArray,
      stats: {
        finalCount: finalFingerprintArray.length,
        pulled: pullCount,
        pushed: pushCount,
        syncTime
      }
    };
    
  } catch (error) {
    console.error('❌ 双向同步失败:', error);
    throw error;
  }
}

// 更新用户集合元信息
async function updateUserCollectionMeta(userKey, fingerprintArray) {
  const collectionHash = calculateSetHash(fingerprintArray);
  
  await UserCollectionMeta.updateOne(
    { userKey },
    {
      userKey,
      totalCount: fingerprintArray.length,
      collectionHash,
      lastSyncAt: new Date(),
      updatedAt: new Date()
    },
    { upsert: true }
  );
}
```

## 智能增量算法

### 基于时间戳的增量同步

```javascript
async function incrementalSyncByTimestamp(userKey, lastSyncTime) {
  console.log(`⏰ 基于时间戳的增量同步: lastSyncTime=${lastSyncTime}`);
  
  // 获取指定时间后的新增数据
  const newServerData = await UserFingerprintCollection.find({
    userKey,
    createdAt: { $gt: new Date(lastSyncTime) }
  }).select('fingerprint createdAt').lean();
  
  const newFingerprints = newServerData.map(doc => doc.fingerprint);
  
  console.log(`📥 时间戳增量同步: 发现${newFingerprints.length}个新指纹`);
  
  return {
    newFingerprints,
    count: newFingerprints.length,
    syncStrategy: 'timestamp_incremental'
  };
}
```

### 基于版本号的增量同步

```javascript
// 为每条指纹记录添加版本号
const userFingerprintSchema = new mongoose.Schema({
  userKey: String,
  fingerprint: String,
  version: {
    type: Number,
    default: 1,
    index: true
  },
  createdAt: Date
});

async function incrementalSyncByVersion(userKey, clientVersion) {
  console.log(`🔢 基于版本号的增量同步: clientVersion=${clientVersion}`);
  
  // 获取版本号大于客户端版本的数据
  const newServerData = await UserFingerprintCollection.find({
    userKey,
    version: { $gt: clientVersion }
  }).select('fingerprint version').lean();
  
  const updates = newServerData.map(doc => ({
    fingerprint: doc.fingerprint,
    version: doc.version
  }));
  
  const maxVersion = Math.max(...newServerData.map(doc => doc.version), clientVersion);
  
  console.log(`📥 版本增量同步: 发现${updates.length}个更新，新版本=${maxVersion}`);
  
  return {
    updates,
    newVersion: maxVersion,
    count: updates.length,
    syncStrategy: 'version_incremental'
  };
}
```

## 性能优化算法

### 布隆过滤器优化算法

```javascript
class OptimizedDiffAlgorithm {
  constructor() {
    this.bloomFilters = new Map();
  }
  
  async optimizedBidirectionalDiff(userKey, clientFingerprintBatch) {
    const startTime = Date.now();
    
    // 1. 获取或创建布隆过滤器
    let bloomFilter = this.bloomFilters.get(userKey);
    
    if (!bloomFilter || this.needsRebuild(userKey)) {
      bloomFilter = await this.rebuildBloomFilter(userKey);
      this.bloomFilters.set(userKey, bloomFilter);
    }
    
    // 2. 布隆过滤器快速筛选
    const filterStartTime = Date.now();
    const possibleMissing = clientFingerprintBatch.filter(fp => !bloomFilter.has(fp));
    const filterTime = Date.now() - filterStartTime;
    
    console.log(`⚡ 布隆过滤器筛选: ${clientFingerprintBatch.length} → ${possibleMissing.length} (${filterTime}ms)`);
    
    // 3. 精确数据库查询
    const dbStartTime = Date.now();
    const actualMissing = [];
    
    if (possibleMissing.length > 0) {
      const existing = await UserFingerprintCollection.find({
        userKey,
        fingerprint: { $in: possibleMissing }
      }).select('fingerprint').lean();
      
      const existingSet = new Set(existing.map(doc => doc.fingerprint));
      actualMissing.push(...possibleMissing.filter(fp => !existingSet.has(fp)));
    }
    
    const dbTime = Date.now() - dbStartTime;
    const totalTime = Date.now() - startTime;
    
    console.log(`🗄️ 数据库查询: ${possibleMissing.length} → ${actualMissing.length} (${dbTime}ms)`);
    console.log(`📊 性能优化效果: 总耗时${totalTime}ms, 数据库查询减少${Math.round((1 - possibleMissing.length / clientFingerprintBatch.length) * 100)}%`);
    
    return {
      missingOnServer: actualMissing,
      performance: {
        totalTime,
        filterTime,
        dbTime,
        reductionRate: (1 - possibleMissing.length / clientFingerprintBatch.length) * 100
      }
    };
  }
  
  async rebuildBloomFilter(userKey) {
    console.log(`🔨 重建布隆过滤器: ${userKey}`);
    
    const allFps = await UserFingerprintCollection
      .find({ userKey })
      .select('fingerprint')
      .lean();
    
    const fingerprintArray = allFps.map(doc => doc.fingerprint);
    const bloomFilter = BloomFilter.create(Math.max(fingerprintArray.length, 1000), 0.01);
    
    fingerprintArray.forEach(fp => bloomFilter.add(fp));
    
    console.log(`✅ 布隆过滤器重建完成: ${fingerprintArray.length}个指纹`);
    return bloomFilter;
  }
  
  needsRebuild(userKey) {
    // 实现重建逻辑：时间超期或数据量增长
    return false; // 简化实现
  }
}
```

### 并发处理算法

```javascript
class ConcurrentSyncAlgorithm {
  constructor(maxConcurrency = 3) {
    this.maxConcurrency = maxConcurrency;
    this.runningTasks = new Map();
  }
  
  async processConcurrentBatches(userKey, fingerprintArray) {
    const BATCH_SIZE = 1000;
    const batches = [];
    
    // 1. 分割数据为批次
    for (let i = 0; i < fingerprintArray.length; i += BATCH_SIZE) {
      batches.push({
        index: Math.floor(i / BATCH_SIZE),
        data: fingerprintArray.slice(i, i + BATCH_SIZE),
        startIndex: i,
        endIndex: Math.min(i + BATCH_SIZE, fingerprintArray.length)
      });
    }
    
    console.log(`🔄 并发处理: ${batches.length}个批次，最大并发度=${this.maxConcurrency}`);
    
    // 2. 并发处理批次
    const results = [];
    const semaphore = new Semaphore(this.maxConcurrency);
    
    const promises = batches.map(async (batch) => {
      await semaphore.acquire();
      
      try {
        const result = await this.processBatch(userKey, batch);
        results[batch.index] = result;
        
        console.log(`✅ 批次${batch.index}完成: ${batch.data.length}个指纹`);
        return result;
        
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(promises);
    
    // 3. 合并结果
    const mergedResult = this.mergeResults(results);
    
    console.log(`🎉 并发处理完成: 总计${mergedResult.totalProcessed}个指纹`);
    
    return mergedResult;
  }
  
  async processBatch(userKey, batch) {
    // 处理单个批次的逻辑
    const missingOnServer = await findMissingInServer(userKey, batch.data);
    
    return {
      batchIndex: batch.index,
      processed: batch.data.length,
      missing: missingOnServer.length,
      missingFingerprints: missingOnServer
    };
  }
  
  mergeResults(results) {
    const allMissingFingerprints = [];
    let totalProcessed = 0;
    
    results.forEach(result => {
      if (result) {
        totalProcessed += result.processed;
        allMissingFingerprints.push(...result.missingFingerprints);
      }
    });
    
    return {
      totalProcessed,
      totalMissing: allMissingFingerprints.length,
      missingFingerprints: allMissingFingerprints
    };
  }
}

// 简单的信号量实现
class Semaphore {
  constructor(permits) {
    this.permits = permits;
    this.waiting = [];
  }
  
  async acquire() {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise(resolve => {
      this.waiting.push(resolve);
    });
  }
  
  release() {
    this.permits++;
    
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      this.permits--;
      resolve();
    }
  }
}
```

## 错误处理和重试算法

### 智能重试机制

```javascript
class RetryableSync {
  constructor() {
    this.maxRetries = 3;
    this.baseDelay = 1000; // 1秒
  }
  
  async syncWithRetry(userKey, clientFingerprintArray) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🔄 同步尝试 ${attempt}/${this.maxRetries}`);
        
        const result = await completeBidirectionalSync(userKey, clientFingerprintArray);
        
        console.log(`✅ 同步成功 (尝试${attempt}次)`);
        return result;
        
      } catch (error) {
        lastError = error;
        
        console.error(`❌ 同步尝试${attempt}失败:`, error.message);
        
        if (attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt);
          console.log(`⏳ ${delay}ms后重试...`);
          await this.sleep(delay);
        }
      }
    }
    
    console.error(`❌ 同步最终失败，已重试${this.maxRetries}次`);
    throw lastError;
  }
  
  calculateDelay(attempt) {
    // 指数退避算法
    return this.baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 断点续传算法

```javascript
class ResumableSync {
  constructor() {
    this.checkpoints = new Map();
  }
  
  async syncWithCheckpoints(userKey, clientFingerprintArray) {
    const sessionId = this.generateSessionId();
    console.log(`🔄 开始可恢复同步: sessionId=${sessionId}`);
    
    try {
      // 1. 检查是否有之前的检查点
      const lastCheckpoint = this.checkpoints.get(userKey);
      let startIndex = 0;
      
      if (lastCheckpoint && this.isValidCheckpoint(lastCheckpoint)) {
        startIndex = lastCheckpoint.processedCount;
        console.log(`📍 从检查点恢复: 已处理${startIndex}个指纹`);
      }
      
      // 2. 分批处理，定期保存检查点
      const BATCH_SIZE = 1000;
      const results = [];
      
      for (let i = startIndex; i < clientFingerprintArray.length; i += BATCH_SIZE) {
        const batch = clientFingerprintArray.slice(i, i + BATCH_SIZE);
        
        try {
          const batchResult = await this.processBatchWithCheckpoint(
            userKey, 
            batch, 
            i, 
            sessionId
          );
          
          results.push(batchResult);
          
          // 保存检查点
          this.saveCheckpoint(userKey, {
            sessionId,
            processedCount: i + batch.length,
            timestamp: Date.now(),
            totalCount: clientFingerprintArray.length
          });
          
        } catch (error) {
          console.error(`❌ 批次${i}-${i + BATCH_SIZE}处理失败:`, error.message);
          throw error; // 可以选择继续或中止
        }
      }
      
      // 3. 清理检查点
      this.clearCheckpoint(userKey);
      
      console.log(`✅ 可恢复同步完成: sessionId=${sessionId}`);
      return this.mergeResults(results);
      
    } catch (error) {
      console.error(`❌ 可恢复同步失败: sessionId=${sessionId}`, error);
      throw error;
    }
  }
  
  async processBatchWithCheckpoint(userKey, batch, startIndex, sessionId) {
    // 处理批次并返回结果
    const missingOnServer = await findMissingInServer(userKey, batch);
    
    if (missingOnServer.length > 0) {
      await pushMissingData(userKey, missingOnServer);
    }
    
    return {
      startIndex,
      batchSize: batch.length,
      pushed: missingOnServer.length,
      sessionId
    };
  }
  
  saveCheckpoint(userKey, checkpoint) {
    this.checkpoints.set(userKey, checkpoint);
    console.log(`💾 检查点已保存: 进度${checkpoint.processedCount}/${checkpoint.totalCount}`);
  }
  
  clearCheckpoint(userKey) {
    this.checkpoints.delete(userKey);
    console.log(`🗑️ 检查点已清理: ${userKey}`);
  }
  
  isValidCheckpoint(checkpoint) {
    const ageMs = Date.now() - checkpoint.timestamp;
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24小时
    
    return ageMs < maxAgeMs;
  }
  
  generateSessionId() {
    return `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

## 算法性能分析

### 时间复杂度分析

```javascript
/**
 * 算法复杂度分析
 * 
 * 设：
 * - n = 客户端指纹数量
 * - m = 服务端指纹数量
 * - k = 批次大小 (通常为1000)
 * 
 * 1. 朴素算法（无优化）:
 *    时间复杂度: O(n * m)
 *    空间复杂度: O(n + m)
 *    
 * 2. 哈希集合优化:
 *    时间复杂度: O(n + m)
 *    空间复杂度: O(n + m)
 *    
 * 3. 布隆过滤器优化:
 *    时间复杂度: O(n + m)
 *    空间复杂度: O(m + b) // b为布隆过滤器大小
 *    数据库查询次数: 约 n * 误报率 (通常减少90%+)
 *    
 * 4. 分批处理:
 *    时间复杂度: O(n + m)
 *    内存使用: O(k) // 恒定小内存
 *    
 * 5. 并发处理:
 *    时间复杂度: O((n + m) / 并发度)
 *    空间复杂度: O(并发度 * k)
 */

// 性能基准测试
class PerformanceBenchmark {
  async benchmarkSyncAlgorithms() {
    const testSizes = [1000, 5000, 10000, 50000];
    
    for (const size of testSizes) {
      console.log(`📊 性能测试: ${size}个指纹`);
      
      const clientFingerprints = this.generateTestFingerprints(size);
      const serverFingerprints = this.generateTestFingerprints(size * 0.8); // 80%重叠
      
      // 测试不同算法
      const results = await Promise.all([
        this.benchmarkNaiveAlgorithm(clientFingerprints, serverFingerprints),
        this.benchmarkOptimizedAlgorithm(clientFingerprints, serverFingerprints),
        this.benchmarkBloomFilterAlgorithm(clientFingerprints, serverFingerprints)
      ]);
      
      this.printBenchmarkResults(size, results);
    }
  }
  
  async benchmarkNaiveAlgorithm(clientFingerprints, serverFingerprints) {
    const startTime = Date.now();
    
    // 朴素O(n*m)算法
    const missing = [];
    for (const clientFp of clientFingerprints) {
      if (!serverFingerprints.includes(clientFp)) {
        missing.push(clientFp);
      }
    }
    
    return {
      algorithm: 'Naive O(n*m)',
      time: Date.now() - startTime,
      missing: missing.length
    };
  }
  
  async benchmarkOptimizedAlgorithm(clientFingerprints, serverFingerprints) {
    const startTime = Date.now();
    
    // 优化的O(n+m)算法
    const serverSet = new Set(serverFingerprints);
    const missing = clientFingerprints.filter(fp => !serverSet.has(fp));
    
    return {
      algorithm: 'Optimized O(n+m)',
      time: Date.now() - startTime,
      missing: missing.length
    };
  }
  
  async benchmarkBloomFilterAlgorithm(clientFingerprints, serverFingerprints) {
    const startTime = Date.now();
    
    // 布隆过滤器算法
    const bloomFilter = BloomFilter.create(serverFingerprints.length, 0.01);
    serverFingerprints.forEach(fp => bloomFilter.add(fp));
    
    const possibleMissing = clientFingerprints.filter(fp => !bloomFilter.has(fp));
    
    // 模拟数据库查询
    const serverSet = new Set(serverFingerprints);
    const actualMissing = possibleMissing.filter(fp => !serverSet.has(fp));
    
    return {
      algorithm: 'Bloom Filter',
      time: Date.now() - startTime,
      missing: actualMissing.length,
      dbQueries: possibleMissing.length,
      reduction: Math.round((1 - possibleMissing.length / clientFingerprints.length) * 100)
    };
  }
}
```