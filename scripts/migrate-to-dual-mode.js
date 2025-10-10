#!/usr/bin/env node

/**
 * 双指纹模式迁移脚本
 * 
 * 功能：
 * 1. 清空 user_fingerprints 集合的所有文档
 * 2. 清空 user_collection_meta 集合的所有文档
 * 3. 清空 diff_sessions 集合的所有文档
 * 4. 保留 authorized_user_keys 集合
 * 5. 清空所有缓存（内存缓存和布隆过滤器）
 * 6. 输出迁移报告
 * 
 * 使用方法:
 *   node scripts/migrate-to-dual-mode.js
 * 
 * 注意：此脚本会删除所有指纹数据，请谨慎使用！
 */

const mongoose = require('mongoose');
const { MONGODB_URI } = require('../src/config/database');

// 彩色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSection(title) {
  log(`\n${'='.repeat(60)}`, colors.cyan);
  log(`  ${title}`, colors.bright + colors.cyan);
  log(`${'='.repeat(60)}`, colors.cyan);
}

function logSuccess(message) {
  log(`✓ ${message}`, colors.green);
}

function logWarning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function logError(message) {
  log(`✗ ${message}`, colors.red);
}

function logInfo(message) {
  log(`ℹ ${message}`, colors.blue);
}

async function migrate() {
  logSection('云同步双指纹模式迁移脚本');
  
  log('\n此脚本将执行以下操作：', colors.bright);
  log('  1. 清空所有指纹数据 (user_fingerprints)');
  log('  2. 清空所有元数据 (user_collection_meta)');
  log('  3. 清空所有会话数据 (diff_sessions)');
  log('  4. 保留所有 userKey 记录 (authorized_user_keys)');
  log('  5. 输出迁移报告\n');
  
  logWarning('警告：此操作将删除所有指纹数据，无法恢复！');
  log('\n如果您确定要继续，请在 10 秒内按 Ctrl+C 取消...\n', colors.yellow);
  
  // 倒计时
  for (let i = 10; i > 0; i--) {
    process.stdout.write(`\r${colors.yellow}倒计时: ${i} 秒...${colors.reset}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('\n');

  try {
    // 连接数据库
    logSection('连接数据库');
    logInfo(`连接 MongoDB: ${MONGODB_URI.replace(/:[^:@]+@/, ':***@')}`);
    
    await mongoose.connect(MONGODB_URI);
    logSuccess('数据库连接成功');

    const db = mongoose.connection.db;
    
    // 统计迁移前的数据
    logSection('迁移前数据统计');
    
    const collections = {
      fingerprints: 'user_fingerprints',
      metas: 'user_collection_meta',
      sessions: 'diff_sessions',
      userKeys: 'authorized_user_keys'
    };

    const beforeStats = {};
    
    for (const [key, collectionName] of Object.entries(collections)) {
      try {
        const count = await db.collection(collectionName).countDocuments();
        beforeStats[key] = count;
        logInfo(`${collectionName}: ${count} 条记录`);
      } catch (error) {
        beforeStats[key] = 0;
        logWarning(`${collectionName}: 集合不存在`);
      }
    }

    // 执行迁移
    logSection('执行数据迁移');
    
    const migrationResults = {};
    
    // 1. 清空指纹数据
    log('\n[1/3] 清空指纹数据 (user_fingerprints)...');
    try {
      const fpResult = await db.collection(collections.fingerprints).deleteMany({});
      migrationResults.fingerprints = fpResult.deletedCount;
      logSuccess(`已删除 ${fpResult.deletedCount} 条指纹记录`);
    } catch (error) {
      migrationResults.fingerprints = 0;
      logWarning(`指纹集合清理失败: ${error.message}`);
    }

    // 2. 清空元数据
    log('\n[2/3] 清空元数据 (user_collection_meta)...');
    try {
      const metaResult = await db.collection(collections.metas).deleteMany({});
      migrationResults.metas = metaResult.deletedCount;
      logSuccess(`已删除 ${metaResult.deletedCount} 条元数据记录`);
    } catch (error) {
      migrationResults.metas = 0;
      logWarning(`元数据集合清理失败: ${error.message}`);
    }

    // 3. 清空会话数据
    log('\n[3/3] 清空会话数据 (diff_sessions)...');
    try {
      const sessionResult = await db.collection(collections.sessions).deleteMany({});
      migrationResults.sessions = sessionResult.deletedCount;
      logSuccess(`已删除 ${sessionResult.deletedCount} 条会话记录`);
    } catch (error) {
      migrationResults.sessions = 0;
      logWarning(`会话集合清理失败: ${error.message}`);
    }

    // 验证 userKey 记录是否保留
    logSection('验证 userKey 记录');
    const userKeyCount = await db.collection(collections.userKeys).countDocuments();
    logSuccess(`保留的 userKey 记录: ${userKeyCount} 个`);

    // 列出所有保留的 userKey
    if (userKeyCount > 0) {
      const userKeys = await db.collection(collections.userKeys)
        .find({}, { projection: { userKey: 1, description: 1, isActive: 1, _id: 0 } })
        .toArray();
      
      log('\n保留的 userKey 列表:', colors.bright);
      userKeys.forEach((key, index) => {
        const status = key.isActive ? colors.green + '✓ 活跃' : colors.red + '✗ 禁用';
        const shortKey = key.userKey.substring(0, 8) + '***' + key.userKey.substring(key.userKey.length - 4);
        log(`  ${index + 1}. ${shortKey} - ${key.description || '(无描述)'} [${status}${colors.reset}]`);
      });
    }

    // 迁移报告
    logSection('迁移报告');
    
    const reportTable = [
      ['集合名称', '迁移前', '已删除', '迁移后'],
      ['─'.repeat(30), '─'.repeat(10), '─'.repeat(10), '─'.repeat(10)],
      ['user_fingerprints', beforeStats.fingerprints, migrationResults.fingerprints, 0],
      ['user_collection_meta', beforeStats.metas, migrationResults.metas, 0],
      ['diff_sessions', beforeStats.sessions, migrationResults.sessions, 0],
      ['authorized_user_keys', beforeStats.userKeys, 0, beforeStats.userKeys]
    ];

    console.log();
    reportTable.forEach((row, index) => {
      if (index === 0) {
        log(`  ${row[0].padEnd(30)} ${row[1].padEnd(10)} ${row[2].padEnd(10)} ${row[3]}`, colors.bright);
      } else if (index === 1) {
        log(`  ${row[0]} ${row[1]} ${row[2]} ${row[3]}`, colors.cyan);
      } else {
        const color = row[0] === 'authorized_user_keys' ? colors.green : colors.reset;
        log(`  ${String(row[0]).padEnd(30)} ${String(row[1]).padEnd(10)} ${String(row[2]).padEnd(10)} ${String(row[3])}`, color);
      }
    });

    // 迁移后的提示
    logSection('后续操作');
    
    log('\n迁移已完成！现在需要执行以下操作：\n', colors.bright);
    log('1. 重启应用服务器以清除内存缓存和布隆过滤器', colors.yellow);
    log('2. 确保客户端已更新为双指纹模式版本', colors.yellow);
    log('3. 客户端在同步时需要携带 mode 参数 (pcm 或 file)', colors.yellow);
    log('4. 每个 userKey 可以同时使用两种模式，数据完全隔离', colors.yellow);
    log('5. 配额按全局计算（pcm + file 总量）\n', colors.yellow);

    logSuccess('迁移完成！');
    
  } catch (error) {
    logError(`迁移失败: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    // 关闭数据库连接
    await mongoose.connection.close();
    logInfo('数据库连接已关闭');
  }
}

// 执行迁移
migrate().catch(error => {
  logError(`未捕获的错误: ${error.message}`);
  console.error(error);
  process.exit(1);
});

