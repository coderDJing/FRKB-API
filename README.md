# Track Studio API

Track Studio 桌面端的云同步后端：在 Node.js 服务与 Electron 客户端之间同步音频指纹（SHA256）、精选艺人快照，以及精选库（含音频文件）。

桌面端仓库目前仍叫 [`FRKB_Rapid-Audio-Organization-Tool`](https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool)（产品名已改为 Track Studio，仓库名尚未更名）。

## 兼容性说明

产品已从 FRKB 更名为 Track Studio，GitHub 仓库从 `FRKB-API` 改为 [`Track-Studio-API`](https://github.com/coderDJing/Track-Studio-API)。旧仓库 URL 会由 GitHub 重定向，但请尽快把 `origin` 改到新地址。

以下运行时标识是历史契约，**不要为了改名而修改**，否则已部署实例和现有客户端会断连：

- HTTP 前缀默认仍是 `/frkbapi/v1`（可用环境变量 `API_PREFIX` 覆盖，现有客户端按默认前缀调用）
- 环境变量名、Mongo 默认库名 `frkb_database`、Blob 默认目录 `data/frkb-blobs`
- CLI 命令名 `frkb-admin`（`node cli/admin.js` / `pnpm admin`）
- 鉴权方式：`Authorization: Bearer <API_SECRET_KEY>`，业务接口另带 `userKey`

## 它同步什么

- **指纹集合**：按 `userKey` 同步 SHA256 指纹，服务端只增不减，最终为并集
- **精选艺人**：轻量全量快照 `{ name, count, fingerprints[] }`
- **精选库**：revision diff + 音频 blob 分片上传 / 断点下载 + SSE 事件
- **错误上报**：客户端日志上传（需 API Key，严格限流）

## 快速开始

环境要求：Node.js >= 16、MongoDB >= 4.4、pnpm（或 npm）。

```bash
pnpm install
cp .env.example .env
```

编辑 `.env`：至少设置 `API_SECRET_KEY`、Mongo 连接，以及 `PORT`。未配置 `PORT` 时进程默认监听 **3000**；[`.env.example`](.env.example) 示例写的是 **3001**，以你本地 `.env` 为准。

```bash
# 开发
pnpm dev

# 生产
pnpm start
```

健康检查：`GET http://localhost:<PORT>/health`。

API 目录：`GET http://localhost:<PORT>/frkbapi/v1`。

### 创建 userKey

```bash
node cli/admin.js create-userkey --desc "张三的客户端"
node cli/admin.js list-userkeys --full
node cli/admin.js --help
```

`create` / `list` 等是上述命令的别名，`pnpm admin <命令>` 等价于 `node cli/admin.js <命令>`。

### 客户端配置

桌面端 `config/client.json` 示例：

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

`serverUrl` 不要带 API 前缀；请求路径仍使用 `/frkbapi/v1/...`。

## API 地图

默认前缀：`/frkbapi/v1`。除 `/health` 外，业务接口需要 `Authorization: Bearer <API_SECRET_KEY>`。字段级说明见 [`docs/API_DESIGN.md`](./docs/API_DESIGN.md)。

### 指纹同步 `/fingerprint-sync`

- `POST /check`：预检查
- `POST /validate-user-key`：只读校验 userKey
- `POST /bidirectional-diff`：双向差异（分批）
- `POST /analyze-diff`：生成差异会话
- `POST /pull-diff-page`：分页拉取缺失
- `POST /add`：批量新增
- `POST /reset`：清空该 userKey 的指纹数据（不重置使用统计）
- `GET /status`、`GET /service-stats`
- `DELETE /cache/:userKey`、`DELETE /lock/:userKey`

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

### 精选艺人 `/curated-artist-sync`

- `POST /sync`：提交全量轻量快照

### 精选库 `/curated-library-sync`

- `POST /status`：同步状态
- `POST /pull`：拉取 revision diff
- `POST /push`：推送变更
- `PUT/GET /blob/:sha256`：分片上传与断点下载
- `GET /events`：修订 SSE
- `POST /reset`：清空云端精选库快照与音频

### 健康、上报、迁移

- `GET /health`（根路径，无前缀）
- `GET /frkbapi/v1/health/detailed`、`/stats`、`/diagnose`（诊断需 `adminToken`，严格限流）
- `POST /frkbapi/v1/error-report/upload`
- `GET/POST /frkbapi/v1/admin/migration/*`：Mongo 导出导入与精选库音频拷贝（需 `adminToken`）

## 运维

- **日志**：`LOG_LEVEL`、`LOG_MINIMAL`、轮转见 [`docs/LOGGING_CONFIG.md`](./docs/LOGGING_CONFIG.md)
- **限流**：全局基础限流 + 敏感操作严格限流，见 [`docs/SECURITY.md`](./docs/SECURITY.md)
- **布隆过滤器**：指纹预检查优化，见 [`docs/BLOOM_FILTER_CONFIG.md`](./docs/BLOOM_FILTER_CONFIG.md)
- **整机迁移**：`node cli/admin.js migrate --target <url> --admin-token <token>`，音频 blob 必须一起拷，见 [`docs/CLI_TOOL.md`](./docs/CLI_TOOL.md)

生产环境建议：

```bash
LOG_LEVEL=warn
LOG_MINIMAL=true
LOG_APP_RETENTION=1d
```

## 文档

- [快速启动补充](./GETTING_STARTED.md) — 常见问题
- [需求分析](./docs/REQUIREMENTS.md)
- [API 设计](./docs/API_DESIGN.md)
- [数据库设计](./docs/DATABASE_DESIGN.md)
- [性能优化](./docs/PERFORMANCE.md)
- [安全认证](./docs/SECURITY.md)
- [userKey 管理](./docs/USERKEY_MANAGEMENT.md)
- [CLI 工具](./docs/CLI_TOOL.md)
- [项目结构](./docs/PROJECT_STRUCTURE.md)
- [同步算法](./docs/SYNC_ALGORITHM.md)
- [日志配置](./docs/LOGGING_CONFIG.md)
- [前端对接](./docs/FRONTEND_INTEGRATION.md)

## 许可证

[MIT License](./LICENSE)
