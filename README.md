# FRKB-API：MD5集合同步系统

## 项目简介

FRKB-API 是一个高性能的MD5集合同步系统，用于在Electron客户端和Node.js服务端之间同步大量MD5数据。

### 核心特性

- ✅ **双向同步**：客户端与服务端MD5集合完全一致
- ✅ **高性能**：支持4-5万MD5数据，10用户并发
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
NODE_ENV=development
API_SECRET_KEY=your-secure-api-key
SERVER_HOST=localhost
SERVER_PORT=3000

# 数据库配置
MONGODB_URI=mongodb://localhost:27017/frkb_db
MONGODB_USERNAME=your-db-user
MONGODB_PASSWORD=your-db-password

# 性能配置
RATE_LIMIT_MAX=100
BLOOM_FILTER_ENABLED=true
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

- 前缀：`/frkbapi/v1/md5-sync`
- 认证：请求头 `Authorization: Bearer <API_SECRET_KEY>`

常用端点：
- POST `/check`：预检查
- POST `/bidirectional-diff`：双向差异（分批）
- POST `/add`：批量新增
- POST `/analyze-diff`：生成差异会话
- POST `/pull-diff-page`：分页拉取缺失

最小示意：
```javascript
await fetch('/frkbapi/v1/md5-sync/check', {
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

- **数据量**：单用户4-5万MD5值
- **响应时间**：预检查 < 100ms，差异计算 < 1s
- **并发能力**：支持10用户同时同步
- **网络优化**：相比全量传输减少80%+流量
- **布隆过滤器**：89%性能提升，1%误报率

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

## 开发团队
- **技术选型**：Node.js生态系统
- **性能优化**：布隆过滤器 + 批处理算法

## 许可证

[MIT License](./LICENSE)