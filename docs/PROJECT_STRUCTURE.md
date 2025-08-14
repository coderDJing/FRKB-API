# 项目结构（精简版）

## 目录
```
FRKB-API/
├── server.js                # 进程入口
├── src/
│   ├── app.js               # Express 应用与全局中间件
│   ├── config/              # 数据库与常量
│   ├── models/              # Mongoose 模型（UserFingerprintCollection / UserCollectionMeta / AuthorizedUserKey）
│   ├── routes/              # 路由（前缀：/frkbapi/v1）
│   ├── controllers/         # 控制器
│   ├── services/            # 业务服务（同步/缓存/布隆）
│   ├── middlewares/         # 认证/限流/校验/错误处理（简化限流架构：全局基础+敏感操作严格）
│   └── utils/               # 工具
├── cli/admin.js             # 本地管理工具
└── docs/                    # 文档（精简版）
```

## 关键约定
- API 前缀：`/frkbapi/v1`；同步路由基座：`/fingerprint-sync`
- 认证：`Authorization: Bearer <API_SECRET_KEY>` + `userKey` 白名单
- 幂等：批量新增使用唯一索引保证幂等

## 入口与启动
- 入口：`server.js`（连接数据库后启动 `src/app.js`）
- 环境变量：参考 `README.md` 与 `.env.example`

## 环境变量配置

### 核心配置
```bash
# 基础配置
PORT=3000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/frkb_db
API_SECRET_KEY=your_secret_key

# 性能关键：布隆过滤器
BLOOM_FILTER_ENABLED=true
BLOOM_FILTER_MIN_CAPACITY=150000    # 针对10万指纹
BLOOM_FILTER_GROWTH_MULTIPLIER=10   # 增长预估
BLOOM_FILTER_FALSE_POSITIVE_RATE=0.01

# 批处理优化
BATCH_SIZE=2000
MAX_CONCURRENT_BATCHES=4
```

### 配置文件
1. 复制 `.env.example` 为 `.env`
2. 根据部署环境调整参数
3. 重点关注布隆过滤器容量配置

### 限流配置
```bash
# 全局基础限流
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000      # 1分钟

# 严格限流（敏感操作）
# 代码中硬编码：10次/5分钟
```

**限流策略：**
- 全局基础限流：适用于所有API接口（100次/分钟）
- 严格限流：仅用于敏感操作（10次/5分钟）
  - 完整差异分析 `/analyze-diff`
  - 缓存清理 `/cache/:userKey`
  - 锁管理 `/lock/:userKey`
  - 系统诊断 `/health/diagnose`

更多细节以源码为准；本页不再包含实现级代码片段。

