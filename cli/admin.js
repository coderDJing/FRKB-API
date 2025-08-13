#!/usr/bin/env node

const { program } = require('commander');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
require('dotenv').config();

// 导入模型和工具
const { connectDB, closeDB } = require('../src/config/database');
const AuthorizedUserKey = require('../src/models/AuthorizedUserKey');
const UserFingerprintCollection = require('../src/models/UserFingerprintCollection');
const UserCollectionMeta = require('../src/models/UserCollectionMeta');
const UserKeyUtils = require('../src/utils/userKeyUtils');
const HashUtils = require('../src/utils/hashUtils');
const logger = require('../src/utils/logger');

/**
 * FRKB-API 管理员CLI工具
 * 提供userKey管理、系统状态查询等功能
 */

// 配置程序信息
program
  .name('frkb-admin')
  .description('FRKB-API 管理员命令行工具')
  .version('1.0.0');

/**
 * 确保数据库连接
 */
async function ensureConnection() {
  if (mongoose.connection.readyState !== 1) {
    console.log('🔌 正在连接数据库...');
    await connectDB();
  }
}

/**
 * 优雅关闭
 */
async function gracefulExit() {
  try {
    await closeDB();
    process.exit(0);
  } catch (error) {
    console.error('❌ 关闭数据库连接失败:', error.message);
    process.exit(1);
  }
}

/**
 * 错误处理包装器
 */
function withErrorHandling(fn) {
  return async (...args) => {
    try {
      await ensureConnection();
      await fn(...args);
      await gracefulExit();
    } catch (error) {
      console.error('❌ 操作失败:', error.message);
      if (process.env.NODE_ENV === 'development') {
        console.error(error.stack);
      }
      await gracefulExit();
    }
  };
}

/**
 * 创建新的userKey
 */
async function createUserKey(options) {
  console.log('🔑 正在创建新的userKey...');
  
  const createOptions = {
    description: options.desc || options.description || '通过CLI创建',
    createdBy: options.by || process.env.USER || 'admin',
    notes: options.notes || ''
  };
  
  // 按业务约定：userKey 永不过期（不支持 --expires）
  
  const result = await AuthorizedUserKey.createUserKey(createOptions);
  
  if (result.success) {
    console.log('✅ userKey创建成功!');
    console.log('');
    console.log('📋 userKey信息:');
    console.log(`   UUID: ${result.userKey}`);
    console.log(`   描述: ${createOptions.description}`);
    console.log(`   创建者: ${createOptions.createdBy}`);
    
    console.log(`   过期时间: 永不过期`);
    
    if (createOptions.notes) {
      console.log(`   备注: ${createOptions.notes}`);
    }
    
    console.log('');
    console.log('⚠️  请妥善保管userKey，建议复制到客户端配置文件中');
    
    // 记录操作日志
    logger.admin('CLI创建userKey', {
      userKey: UserKeyUtils.toShortId(result.userKey),
      description: createOptions.description,
      operator: createOptions.createdBy
    });
    
  } else {
    throw new Error(result.message || '创建userKey失败');
  }
}

/**
 * 列出所有userKey
 */
async function listUserKeys(options) {
  console.log('📋 正在查询userKey列表...');
  
  const query = {};
  
  // 过滤条件
  if (options.active !== undefined) {
    query.isActive = options.active;
  }
  
  // 过期概念已移除，不支持 expired 过滤
  
  const userKeys = await AuthorizedUserKey.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50);
  
  if (userKeys.length === 0) {
    console.log('📝 未找到符合条件的userKey');
    return;
  }
  
  console.log(`\n📊 找到 ${userKeys.length} 个userKey:\n`);
  
  // 表格标题
  const keyColumnWidth = options.full ? 37 : 12; // 36位UUID，额外1位用于间距
  console.log('Key'.padEnd(keyColumnWidth) + 'Active'.padEnd(8) + 'Description'.padEnd(30) + 'Last Used'.padEnd(20) + 'Requests'.padEnd(10));
  console.log('-'.repeat(100));
  
  for (const userKey of userKeys) {
    const displayKey = options.full ? userKey.userKey : UserKeyUtils.toShortId(userKey.userKey);
    const isActive = userKey.isActive ? '✅' : '❌';
    const description = (userKey.description || 'N/A').substring(0, 28).padEnd(30);
    const lastUsed = userKey.lastUsedAt 
      ? userKey.lastUsedAt.toISOString().substring(0, 16).replace('T', ' ')
      : 'Never'.padEnd(16);
    const requests = userKey.usageStats.totalRequests.toString().padEnd(10);
    console.log(`${displayKey.padEnd(keyColumnWidth)}${isActive.padEnd(8)}${description}${lastUsed.padEnd(20)}${requests}`);
  }
  
  console.log('');
  
  // 统计信息
  const stats = {
    total: userKeys.length,
    active: userKeys.filter(k => k.isActive).length,
    totalRequests: userKeys.reduce((sum, k) => sum + k.usageStats.totalRequests, 0)
  };
  
  console.log('📈 统计信息:');
  console.log(`   总数: ${stats.total}`);
  console.log(`   活跃: ${stats.active}`);
  // 不再显示过期统计
  console.log(`   总请求数: ${stats.totalRequests}`);
}

/**
 * 查看userKey详细信息
 */
async function showUserKey(userKeyOrShortId) {
  console.log('🔍 正在查询userKey详细信息...');
  
  let userKey;
  
  // 如果是短ID，需要查找完整的userKey
  if (userKeyOrShortId.length === 8) {
    const keys = await AuthorizedUserKey.find({
      userKey: new RegExp(`^${userKeyOrShortId}`, 'i')
    });
    
    if (keys.length === 0) {
      throw new Error('未找到匹配的userKey');
    } else if (keys.length > 1) {
      console.log('⚠️  找到多个匹配的userKey:');
      keys.forEach(k => {
        console.log(`   ${UserKeyUtils.toShortId(k.userKey)} - ${k.description}`);
      });
      throw new Error('请提供更完整的userKey');
    }
    
    userKey = keys[0];
  } else {
    userKey = await AuthorizedUserKey.findOne({ userKey: userKeyOrShortId });
    
    if (!userKey) {
      throw new Error('userKey不存在');
    }
  }
  
  // 获取使用统计
  const fpStats = await UserFingerprintCollection.aggregate([
    { $match: { userKey: userKey.userKey } },
    {
      $group: {
        _id: null,
        totalFingerprints: { $sum: 1 },
        oldest: { $min: '$createdAt' },
        newest: { $max: '$createdAt' }
      }
    }
  ]);
  
  const fpInfo = fpStats[0] || { totalFingerprints: 0, oldest: null, newest: null };
  
  // 显示详细信息
  console.log('\n📋 userKey详细信息:\n');
  console.log(`🔑 UUID: ${userKey.userKey}`);
  console.log(`📝 描述: ${userKey.description}`);
  console.log(`👤 创建者: ${userKey.createdBy}`);
  console.log(`📅 创建时间: ${userKey.createdAt.toISOString()}`);
  console.log(`🔄 更新时间: ${userKey.updatedAt.toISOString()}`);
  console.log(`✅ 状态: ${userKey.isActive ? '活跃' : '已禁用'}`);
  
  console.log(`⏰ 过期时间: 永不过期`);
  
  // 已移除细粒度权限配置显示
  
  console.log('\n📊 使用统计:');
  console.log(`   总请求数: ${userKey.usageStats.totalRequests}`);
  console.log(`   同步次数: ${userKey.usageStats.totalSyncs}`);
  console.log(`   最后使用: ${userKey.lastUsedAt ? userKey.lastUsedAt.toISOString() : '从未使用'}`);
  console.log(`   最后IP: ${userKey.usageStats.lastIpAddress || 'N/A'}`);
  
  console.log('\n📦 数据统计:');
  console.log(`   指纹数量: ${fpInfo.totalFingerprints}`);
  if (fpInfo.oldest) {
    console.log(`   最早数据: ${fpInfo.oldest.toISOString()}`);
  }
  if (fpInfo.newest) {
    console.log(`   最新数据: ${fpInfo.newest.toISOString()}`);
  }
  
  if (userKey.notes) {
    console.log(`\n📝 备注: ${userKey.notes}`);
  }
}

/**
 * 禁用userKey
 */
async function deactivateUserKey(userKeyOrShortId, reason) {
  console.log('🔒 正在禁用userKey...');
  
  let targetUserKey = userKeyOrShortId;
  
  // 如果是短ID，找到完整的userKey
  if (userKeyOrShortId.length === 8) {
    const keys = await AuthorizedUserKey.find({
      userKey: new RegExp(`^${userKeyOrShortId}`, 'i')
    });
    
    if (keys.length === 0) {
      throw new Error('未找到匹配的userKey');
    } else if (keys.length > 1) {
      throw new Error('找到多个匹配的userKey，请提供完整的userKey');
    }
    
    targetUserKey = keys[0].userKey;
  }
  
  const result = await AuthorizedUserKey.deactivateUserKey(targetUserKey, reason || '通过CLI禁用');
  
  if (result.success) {
    console.log('✅ userKey已成功禁用');
    
    // 记录操作日志
    logger.admin('CLI禁用userKey', {
      userKey: UserKeyUtils.toShortId(targetUserKey),
      reason: reason || '通过CLI禁用',
      operator: process.env.USER || 'admin'
    });
  } else {
    throw new Error(result.message || '禁用userKey失败');
  }
}

/**
 * 获取系统状态
 */
async function getSystemStatus() {
  console.log('📊 正在查询系统状态...');
  
  // 并行查询各种统计信息
  const [
    userKeyStats,
    fpStats,
    metaStats
  ] = await Promise.all([
    AuthorizedUserKey.getUsageStats(),
    UserFingerprintCollection.aggregate([
      {
        $group: {
          _id: null,
          totalFingerprints: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userKey' }
        }
      }
    ]),
    UserCollectionMeta.aggregate([
      {
        $group: {
          _id: null,
          totalMetas: { $sum: 1 },
          totalFingerprintCount: { $sum: '$totalCount' },
          avgFingerprintCount: { $avg: '$totalCount' },
          lastSync: { $max: '$lastSyncAt' }
        }
      }
    ])
  ]);
  
  const aggInfo = fpStats[0] || { totalFingerprints: 0, uniqueUsers: [] };
  const metaInfo = metaStats[0] || { totalMetas: 0, totalFingerprintCount: 0, avgFingerprintCount: 0, lastSync: null };
  
  console.log('\n🏥 系统健康状态:\n');
  
  // 数据库连接状态
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? '✅ 已连接' : '❌ 未连接';
  console.log(`🔌 数据库: ${dbStatus}`);
  
  // userKey统计
  console.log('\n👥 用户密钥统计:');
  console.log(`   总用户数: ${userKeyStats.totalUsers}`);
  console.log(`   活跃用户: ${userKeyStats.activeUsers}`);
  console.log(`   总请求数: ${userKeyStats.totalRequests}`);
  console.log(`   总同步数: ${userKeyStats.totalSyncs}`);
  console.log(`   最后使用: ${userKeyStats.lastUsed ? userKeyStats.lastUsed.toISOString() : 'N/A'}`);
  
  // 指纹数据统计
  console.log('\n📦 数据统计:');
  console.log(`   总指纹数量: ${aggInfo.totalFingerprints.toLocaleString()}`);
  console.log(`   有数据用户: ${aggInfo.uniqueUsers.length}`);
  console.log(`   元数据记录: ${metaInfo.totalMetas}`);
  console.log(`   平均指纹数: ${Math.round(metaInfo.avgFingerprintCount).toLocaleString()}`);
  console.log(`   最后同步: ${metaInfo.lastSync ? metaInfo.lastSync.toISOString() : 'N/A'}`);
  
  // 系统资源
  const memUsage = process.memoryUsage();
  console.log('\n💾 系统资源:');
  console.log(`   内存使用: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
  console.log(`   运行时间: ${Math.round(process.uptime())}秒`);
  console.log(`   Node版本: ${process.version}`);
  console.log(`   平台: ${process.platform} ${process.arch}`);
}

/**
 * 清理过期数据（禁用已过期的 userKey）
 */
async function cleanupExpiredData(options) {
  console.log('🧹 正在清理过期数据...');
  
  let cleanedCount = 0;
  
  // 清理过期的userKey
  if (!options.skipUserKeys) {
    const expiredKeys = await AuthorizedUserKey.find({
      expiresAt: { $lte: new Date() },
      isActive: true
    });
    
    for (const key of expiredKeys) {
      await AuthorizedUserKey.updateOne(
        { _id: key._id },
        { isActive: false, notes: '自动禁用：已过期' }
      );
      cleanedCount++;
    }
    
    console.log(`✅ 已禁用 ${expiredKeys.length} 个过期的userKey`);
  }
  
  // 可以添加更多清理逻辑
  // 例如：清理长时间未使用的会话、临时数据等
  
  console.log(`🎉 清理完成，共处理 ${cleanedCount} 项数据`);
  
  // 记录操作日志
  logger.admin('CLI清理过期数据', {
    cleanedCount,
    operator: process.env.USER || 'admin'
  });
}

/**
 * 清理无效数据：无主指纹、无主/空的元数据
 * - 无主 指纹: 在 AuthorizedUserKey 中不存在的 userKey 对应的指纹数据
 * - 无主 meta: 在 AuthorizedUserKey 中不存在的 userKey 的 meta
 * - 空 meta: totalCount=0 且 lastSyncAt=null，且该 userKey 在指纹集合中数量为 0
 */
async function cleanupInvalidData(options) {
  const preview = !!options.preview;
  const emptyMetaDays = parseInt(options.emptyMetaDays || options.emptyMetaTtl || '7', 10);
  const cutoff = new Date(Date.now() - emptyMetaDays * 24 * 60 * 60 * 1000);

  console.log('🧽 正在清理无效数据...');

  // 1) 无主指纹（聚合找出无主的 userKey 列表）
  const orphanFingerprintUsers = await UserFingerprintCollection.aggregate([
    {
      $lookup: {
        from: AuthorizedUserKey.collection.name,
        localField: 'userKey',
        foreignField: 'userKey',
        as: 'auth'
      }
    },
    { $match: { $expr: { $eq: [{ $size: '$auth' }, 0] } } },
    { $group: { _id: '$userKey', count: { $sum: 1 } } }
  ]);

  let orphanFingerprintRemoved = 0;
  if (orphanFingerprintUsers.length > 0) {
    console.log(`🔎 发现 ${orphanFingerprintUsers.length} 个无主 userKey 的指纹数据`);
    if (!preview) {
      for (const u of orphanFingerprintUsers) {
        const res = await UserFingerprintCollection.deleteMany({ userKey: u._id });
        orphanFingerprintRemoved += res.deletedCount || 0;
      }
    } else {
      orphanFingerprintRemoved = orphanFingerprintUsers.reduce((s, u) => s + u.count, 0);
    }
  } else {
    console.log('✅ 未发现无主指纹数据');
  }

  // 2) 无主 meta
  const orphanMetas = await UserCollectionMeta.aggregate([
    {
      $lookup: {
        from: AuthorizedUserKey.collection.name,
        localField: 'userKey',
        foreignField: 'userKey',
        as: 'auth'
      }
    },
    { $match: { $expr: { $eq: [{ $size: '$auth' }, 0] } } },
    { $project: { _id: 0, userKey: '$userKey' } }
  ]);

  let orphanMetaRemoved = 0;
  if (orphanMetas.length > 0) {
    const orphanKeys = orphanMetas.map(m => m.userKey);
    console.log(`🔎 发现 ${orphanKeys.length} 个无主 meta`);
    if (!preview) {
      const res = await UserCollectionMeta.deleteMany({ userKey: { $in: orphanKeys } });
      orphanMetaRemoved = res.deletedCount || 0;
    } else {
      orphanMetaRemoved = orphanKeys.length;
    }
  } else {
    console.log('✅ 未发现无主 meta');
  }

  // 3) 空 meta（占位但长期未用）
  const emptyMetaCandidates = await UserCollectionMeta.find({
    totalCount: 0,
    lastSyncAt: null,
    createdAt: { $lt: cutoff }
  }).select('userKey createdAt');

  let emptyMetaRemoved = 0;
  if (emptyMetaCandidates.length > 0) {
    console.log(`🔎 发现 ${emptyMetaCandidates.length} 个疑似空 meta（> ${emptyMetaDays} 天）`);
    // 逐个确认该 userKey 在指纹集合中是否确实为 0
    for (const meta of emptyMetaCandidates) {
      const fingerprintCount = await UserFingerprintCollection.countDocuments({ userKey: meta.userKey });
      if (fingerprintCount === 0) {
        if (!preview) {
          const res = await UserCollectionMeta.deleteOne({ userKey: meta.userKey });
          emptyMetaRemoved += res.deletedCount || 0;
        } else {
          emptyMetaRemoved += 1;
        }
      }
    }
  } else {
    console.log('✅ 未发现需要清理的空 meta');
  }

  console.log('🧾 清理汇总:');
  console.log(`   无主 指纹 删除: ${orphanFingerprintRemoved}`);
  console.log(`   无主 meta 删除: ${orphanMetaRemoved}`);
  console.log(`   空 meta 删除: ${emptyMetaRemoved}`);

  logger.admin('CLI清理无效数据', {
    orphanFingerprintRemoved,
    orphanMetaRemoved,
    emptyMetaRemoved,
    preview,
    operator: process.env.USER || 'admin'
  });
}

// ============ 命令定义 ============

// 创建userKey命令
program
  .command('create-userkey')
  .alias('create')
  .description('创建新的userKey')
  .option('-d, --desc <description>', '用户描述')
  .option('--description <description>', '用户描述（完整参数名）')
  .option('-b, --by <creator>', '创建者')
  .option('-n, --notes <notes>', '备注信息')
  // 已移除细粒度权限与日配额相关选项
  .action(withErrorHandling(createUserKey));

// 列出userKey命令
program
  .command('list-userkeys')
  .alias('list')
  .description('列出所有userKey')
  .option('-a, --active', '只显示活跃的userKey')
  .option('--inactive', '只显示非活跃的userKey')
  .option('-l, --limit <number>', '限制显示数量', '50')
  .option('--full', '显示完整 userKey（谨慎在共享环境使用）')
  .action(withErrorHandling((options) => {
    // 处理互斥选项
    if (options.active) options.active = true;
    if (options.inactive) options.active = false;
    
    return listUserKeys(options);
  }));

// 查看userKey详情命令
program
  .command('show-userkey <userkey>')
  .alias('show')
  .description('显示userKey详细信息')
  .action(withErrorHandling(showUserKey));

// 禁用userKey命令
program
  .command('deactivate-userkey <userkey>')
  .alias('deactivate')
  .description('禁用userKey')
  .option('-r, --reason <reason>', '禁用原因')
  .action(withErrorHandling((userkey, options) => {
    return deactivateUserKey(userkey, options.reason);
  }));

// 系统状态命令
program
  .command('status')
  .description('显示系统状态')
  .action(withErrorHandling(getSystemStatus));

// 清理命令
program
  .command('cleanup')
  .description('清理过期与无效数据（过期userKey、无主指纹、无主/空meta）')
  .option('--skip-user-keys', '跳过过期 userKey 清理')
  .option('--empty-meta-days <number>', '空 meta 保留天数（默认 7）', '7')
  .option('--preview', '仅预览待清理数量，不执行删除')
  .action(withErrorHandling(async (options) => {
    await cleanupExpiredData(options);
    await cleanupInvalidData(options);
  }));

// 帮助信息
program
  .command('help-examples')
  .description('显示使用示例')
  .action(() => {
    console.log(`
📚 FRKB-API 管理工具使用示例:

🔑 创建userKey:
   node cli/admin.js create --desc "张三的客户端"

📋 查看userKey:
   node cli/admin.js list
   node cli/admin.js list --active
   node cli/admin.js show 550e8400
   node cli/admin.js show 550e8400-e29b-41d4-a716-446655440000

🔒 管理userKey:
   node cli/admin.js deactivate 550e8400 --reason "用户要求删除"

📊 系统管理:
   node cli/admin.js status
   node cli/admin.js cleanup

💡 提示:
   - userKey可以使用前8位短ID进行操作
   - 所有操作都会记录到系统日志中
   - 建议定期执行cleanup清理过期数据
    `);
  });

// 解析命令行参数
program.parse();

// 如果没有提供命令，显示帮助
if (!process.argv.slice(2).length) {
  program.outputHelp();
}