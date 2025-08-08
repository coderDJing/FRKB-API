const mongoose = require('mongoose');

/**
 * 连接MongoDB数据库
 * @returns {Promise<void>}
 */
const connectDB = async () => {
  try {
    // 验证必需的环境变量
    const requiredEnvVars = [
      'MONGODB_URI',
      'MONGODB_USERNAME',
      'MONGODB_PASSWORD',
      'MONGODB_DATABASE'
    ];
    
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      throw new Error(`缺少必需的环境变量: ${missingVars.join(', ')}`);
    }

    // MongoDB连接选项配置
    const options = {
      maxPoolSize: 10, // 连接池最大连接数
      serverSelectionTimeoutMS: 5000, // 服务器选择超时时间
      socketTimeoutMS: 45000, // Socket超时时间
      family: 4, // 使用IPv4
      // 必需的认证配置
      auth: {
        username: process.env.MONGODB_USERNAME,
        password: process.env.MONGODB_PASSWORD
      },
      authSource: process.env.MONGODB_DATABASE // 认证数据库
    };

    console.log(`🔐 使用认证模式连接数据库: ${process.env.MONGODB_DATABASE}`);
    console.log(`👤 用户名: ${process.env.MONGODB_USERNAME}`);

    // 连接MongoDB
    const conn = await mongoose.connect(process.env.MONGODB_URI+process.env.MONGODB_DATABASE, options);
    
    console.log(`✅ MongoDB 连接成功: ${conn.connection.host}:${conn.connection.port}`);
    console.log(`📂 数据库名称: ${conn.connection.name}`);
    
    // 监听连接事件
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB 连接错误:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('⚠️ MongoDB 连接断开');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB 重新连接成功');
    });

    // 启用Mongoose调试模式（开发环境）
    if (process.env.NODE_ENV === 'development') {
      mongoose.set('debug', true);
    }

  } catch (error) {
    console.error('❌ MongoDB 连接失败:', error.message);
    
    // 如果是环境变量缺失错误
    if (error.message.includes('缺少必需的环境变量')) {
      console.error('💡 请在.env文件中配置以下环境变量:');
      console.error('   - MONGODB_URI: MongoDB连接地址');
      console.error('   - MONGODB_USERNAME: 数据库用户名');
      console.error('   - MONGODB_PASSWORD: 数据库密码');
      console.error('   - MONGODB_DATABASE: 认证数据库名称');
    }
    
    // 如果是认证错误，提供帮助信息
    if (error.message.includes('Authentication failed')) {
      console.error('🔐 认证失败，请检查以下项目:');
      console.error(`💡 用户名 "${process.env.MONGODB_USERNAME}" 是否存在`);
      console.error('💡 密码是否正确');
      console.error(`💡 用户是否在 "${process.env.MONGODB_DATABASE}" 数据库中创建`);
      console.error('💡 用户是否具有正确的数据库权限');
      console.error('\n🛠️ 创建用户示例命令:');
      console.error(`   use ${process.env.MONGODB_DATABASE}`);
      console.error(`   db.createUser({`);
      console.error(`     user: "${process.env.MONGODB_USERNAME}",`);
      console.error(`     pwd: "${process.env.MONGODB_PASSWORD}",`);
      console.error(`     roles: [{ role: "readWrite", db: "${process.env.MONGODB_DATABASE}" }]`);
      console.error(`   })`);
    }
    
    // 如果是连接拒绝错误，提供帮助信息
    if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 请确保MongoDB服务正在运行');
      console.error('💡 请检查连接地址和端口是否正确');
    }
    
    // 退出进程
    process.exit(1);
  }
};

/**
 * 关闭数据库连接
 * @returns {Promise<void>}
 */
const closeDB = async () => {
  try {
    await mongoose.connection.close();
    console.log('🛑 MongoDB 连接已关闭');
  } catch (error) {
    console.error('❌ 关闭MongoDB连接时出错:', error.message);
  }
};

/**
 * 检查数据库连接状态
 * @returns {Object} 连接状态信息
 */
const getDBStatus = () => {
  const state = mongoose.connection.readyState;
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  
  return {
    status: states[state] || 'unknown',
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name
  };
};

module.exports = {
  connectDB,
  closeDB,
  getDBStatus
};