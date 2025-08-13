# FRKB-API：指纹（SHA256）集合同步系统

## 项目简介

FRKB-API 是一个高性能的指纹（SHA256）集合同步系统，用于在 Electron 客户端和 Node.js 服务端之间同步大量指纹数据。本后端服务用于为 Electron 前端项目 FRKB Rapid Audio Organization Tool 提供接口支持（仓库：[`FRKB_Rapid-Audio-Organization-Tool`](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool)）。

### 核心特性

- ✅ **双向同步**：客户端与服务端指纹集合完全一致
- ✅ **高性能**：支持 4-5 万指纹数据，10 用户并发
- ✅ **安全认证**：API密钥 + userKey白名单三重验证
- ✅ **批处理**：智能分批传输，减少网络开销
- ✅ **只增不减**：服务端数据永远合并，保证完整性
- ✅ **本地管理**：命令行工具管理userKey，无网络风险

### 技术栈

- **后端**：Node.js + Express + MongoDB + Mongoose
- **优化**：布隆过滤器、批处理、缓存策略
- **安全**：API密钥认证、userKey白名单、请求限制
- **管理**：本地CLI工具，直连数据库

## 快速开始

### 环境要求

- Node.js >= 16.0.0
- MongoDB >= 4.4
- pnpm 或 npm

### 安装依赖

```bash
pnpm install
```

### 环境配置

复制环境配置文件：
```bash
cp .env.example .env
```

配置 `.env` 文件：
```env
# =================================
# FRKB API 环境变量配置示例
# =================================
# 将此文件复制为 .env 并填入实际配置值

# =================================
# 🚀 服务器基础配置
# =================================
# 服务器运行端口
PORT=3001
SERVER_PORT=3001

# 运行环境 (development/production)
NODE_ENV=development

# API路由前缀
API_PREFIX=/frkbapi/v1

# =================================
# 🔐 安全认证配置 (必需)
# =================================
# API访问密钥 (必须修改！)
API_SECRET_KEY=FRKB_API_SECRET_TOKEN_2024_CHANGE_THIS

# 管理员访问令牌 (可选)
ADMIN_SECRET_TOKEN=your_admin_secret_token

# =================================
# 🗄️ MongoDB 数据库配置 (必需)
# =================================
# MongoDB连接地址 (不包含数据库名)
MONGODB_URI=mongodb://localhost:27017/

# 数据库用户名
MONGODB_USERNAME=your_username

# 数据库密码  
MONGODB_PASSWORD=your_password

# 认证数据库名称
MONGODB_DATABASE=frkb_database

# =================================
# ⚡ 性能优化配置
# =================================
# 启用布隆过滤器 (true/false) - 建议启用
BLOOM_FILTER_ENABLED=true
BLOOM_FILTER_SIZE=1000000
BLOOM_FILTER_HASH_FUNCTIONS=10

# 启用内存缓存 (true/false) - 建议启用  
CACHE_ENABLED=true
CACHE_TTL=3600
CACHE_MAX_SIZE=10000

# =================================
# 🚦 请求限制配置
# =================================
# 每个时间窗口最大请求数
RATE_LIMIT_MAX=200

# 时间窗口长度 (毫秒) - 15分钟
RATE_LIMIT_WINDOW_MS=900000

# =================================
# 📦 批处理配置
# =================================
# 批处理大小
BATCH_SIZE=2000

# 最大并发批次数
MAX_CONCURRENT_BATCHES=2

# 每批超时时间 (毫秒)
TIMEOUT_PER_BATCH=30000

# 重试次数
RETRY_TIMES=3

# =================================
# 📋 日志配置
# =================================
# 日志级别 (debug/info/warn/error)
LOG_LEVEL=info

# 日志目录
LOG_DIR=./logs

# 单个日志文件最大大小
LOG_MAX_SIZE=10m

# 日志文件保留时间
LOG_MAX_FILES=14d

# =================================
# 🌐 HTTP配置
# =================================
# 是否启用响应压缩
ENABLE_COMPRESSION=true

# 请求体大小限制
REQUEST_SIZE_LIMIT=100mb
```

### 启动服务

```bash
# 开发模式
pnpm dev

# 生产模式
pnpm start
```

### 管理员操作

创建用户的userKey：
```bash
# 创建新userKey
node cli/admin.js create-userkey --desc "张三的客户端"

# 查看所有userKey
node cli/admin.js list-userkeys --full

# 查看帮助
node cli/admin.js --help
```

### 客户端配置

在Electron客户端配置文件 `config/client.json`：
```json
{
  "userKey": "550e8400-e29b-41d4-a716-446655440000",
  "serverUrl": "http://localhost:3000",
  "apiSecretKey": "your-secure-api-key",
  "syncOptions": {
    "batchSize": 1000,
    "retryTimes": 3,
    "timeout": 30000
  }
}
```

## API使用示例（精简）

- 前缀：`/frkbapi/v1/fingerprint-sync`
- 认证：请求头 `Authorization: Bearer <API_SECRET_KEY>`

常用端点：
- POST `/check`：预检查
- POST `/bidirectional-diff`：双向差异（分批）
- POST `/add`：批量新增
- POST `/analyze-diff`：生成差异会话
- POST `/pull-diff-page`：分页拉取缺失

最小示意：
```javascript
await fetch('/frkbapi/v1/fingerprint-sync/check', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <API_SECRET_KEY>',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ userKey, count, hash })
});
```

更多请见：[`docs/API_DESIGN.md`](./docs/API_DESIGN.md)

## 性能指标

- **数据量**：单用户 4-5 万指纹
- **响应时间**：预检查 < 100ms，差异计算 < 1s
- **并发能力**：支持10用户同时同步
- **网络优化**：相比全量传输减少80%+流量
- **布隆过滤器**：89%性能提升，1%误报率

## 日志系统优化

系统已优化日志记录，提供精简高效的日志管理：

### 快速配置
```bash
# 生产环境（推荐）
LOG_LEVEL=warn
LOG_MINIMAL=true
LOG_APP_RETENTION=1d

# 开发调试
LOG_LEVEL=debug
LOG_MINIMAL=false
```

### 主要改进
- ✅ 精简日志格式，减少存储占用
- ✅ 智能日志轮转，自动清理过期文件  
- ✅ 条件记录，跳过健康检查等冗余日志
- ✅ 性能监控，只记录慢操作（>3秒）

详细配置参见：[日志配置文档](./docs/LOGGING_CONFIG.md)

## 文档结构

- [需求分析](./docs/REQUIREMENTS.md) - 业务需求和技术挑战
- [API设计](./docs/API_DESIGN.md) - 接口设计和使用方法
- [数据库设计](./docs/DATABASE_DESIGN.md) - 数据模型和索引策略
- [性能优化](./docs/PERFORMANCE.md) - 批处理、布隆过滤器等优化方案
- [安全认证](./docs/SECURITY.md) - 认证机制和安全策略
- [userKey管理](./docs/USERKEY_MANAGEMENT.md) - 用户标识管理方案
- [CLI工具](./docs/CLI_TOOL.md) - 命令行管理工具
- [项目结构](./docs/PROJECT_STRUCTURE.md) - 目录结构和开发计划
- [同步算法](./docs/SYNC_ALGORITHM.md) - 同步流程与要点
- [日志配置](./docs/LOGGING_CONFIG.md) - 日志系统配置和优化

## 开发团队
- **技术选型**：Node.js生态系统
- **性能优化**：布隆过滤器 + 批处理算法

## 许可证

[MIT License](./LICENSE)