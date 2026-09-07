const app = require('./src/app');
const { connectDB, closeDB } = require('./src/config/database');
const { API_PREFIX } = require('./src/config/constants');

const PORT = process.env.PORT || 3000;

/**
 * 启动服务器
 */
const startServer = async () => {
  try {
    console.log('🚀 正在启动 Track Studio API 服务器...');
    
    // 1. 连接数据库
    console.log('📡 正在连接数据库...');
    await connectDB();
    
    // 2. 启动HTTP服务器
    const server = app.listen(PORT, () => {
      console.log('🎉 服务器启动成功!');
      console.log(`📍 本地地址: http://localhost:${PORT}`);
      console.log(`🌍 环境: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 健康检查: http://localhost:${PORT}/health`);
      console.log(`📚 API前缀: ${API_PREFIX}`);
      console.log('─'.repeat(50));
    });

    // 设置服务器超时
    server.timeout = 30000; // 30秒

    // 保存server实例用于优雅关闭
    global.server = server;
    
  } catch (error) {
    console.error('❌ 服务器启动失败:', error.message);
    process.exit(1);
  }
};

/**
 * 优雅关闭服务器
 */
const gracefulShutdown = async (signal) => {
  console.log(`\n🛑 接收到 ${signal} 信号，正在优雅关闭服务器...`);
  
  try {
    // 1. 停止接收新请求
    if (global.server) {
      console.log('⏹️ 正在关闭HTTP服务器...');
      global.server.close(() => {
        console.log('✅ HTTP服务器已关闭');
      });
    }
    
    // 2. 关闭数据库连接
    console.log('🔌 正在关闭数据库连接...');
    await closeDB();
    
    console.log('✨ 服务器已优雅关闭');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ 关闭服务器时出错:', error.message);
    process.exit(1);
  }
};

// 监听进程信号，实现优雅关闭
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 监听未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的Promise拒绝:', reason);
  console.error('Promise:', promise);
  gracefulShutdown('unhandledRejection');
});

// 启动服务器
startServer();