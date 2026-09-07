# Track Studio API 快速启动

安装、启动、API 地图与兼容性说明见 [README.md](./README.md)。本页只补充最短命令和常见问题。

## 最短路径

```bash
pnpm install
cp .env.example .env
pnpm dev
```

端口以 `.env` 的 `PORT` 为准（未配置时代码默认为 3000）。健康检查：

```bash
curl http://localhost:3000/health
```

## userKey

```bash
node cli/admin.js create-userkey --desc "我的客户端"
node cli/admin.js list-userkeys --full
node cli/admin.js show-userkey <userKey或前8位>
node cli/admin.js status
```

`pnpm admin <命令>` 与上面等价；`create` / `list` / `show` 是别名。

## 常见问题

### 数据库连接失败

1. 确认 MongoDB 已启动
2. 核对 `.env` 中的 `MONGODB_URI`、`MONGODB_DATABASE`（默认库名是 `frkb_database`，这是历史标识，不要只为改名而改）
3. 如需独立用户：

```javascript
use frkb_database
db.createUser({
  user: "your_username",
  pwd: "your-password",
  roles: [{ role: "readWrite", db: "frkb_database" }]
})
```

### API 密钥无效

请求头必须是 `Authorization: Bearer <API_SECRET_KEY>`，且与服务端 `.env` 一致。

### userKey 未找到或未授权

用 CLI 创建并确认未被停用、格式为 UUID v4。

## 下一步

完整接口与部署约定以 [README.md](./README.md) 和 [`docs/`](./docs/) 为准。
