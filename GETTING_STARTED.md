# 🚀 FRKB-API 快速启动指南

## 📋 前置要求

- **Node.js**: >= 16.0.0  
- **MongoDB**: >= 4.4 (本地或远程)
- **pnpm**: 推荐使用 pnpm 作为包管理器

## ⚡ 快速启动 (5分钟)

### 1. 安装依赖

```bash
# 使用 pnpm (推荐)
pnpm install

# 或使用 npm
npm install
```

### 2. 配置环境变量

复制环境配置模板：
```bash
cp .env.example .env
```

编辑 `.env` 文件，配置数据库连接：
```env
# 基础配置
NODE_ENV=development
API_SECRET_KEY=FRKB_API_SECRET_TOKEN_2024_CHANGE_THIS

# 数据库配置 (请根据实际情况修改)
MONGODB_URI=mongodb://localhost:27017/
MONGODB_DATABASE=frkb_db
MONGODB_USERNAME=frkb_user  
MONGODB_PASSWORD=your-password
```

### 3. 启动服务

```bash
# 开发模式 (推荐)
pnpm dev

# 或生产模式
pnpm start
```

### 4. 验证启动

访问健康检查接口：
```bash
curl http://localhost:3000/health
```

看到 `"status": "healthy"` 表示启动成功! 🎉

## 🔑 创建第一个 userKey

使用 CLI 工具创建管理 userKey：

```bash
# 创建新的 userKey
pnpm admin create --desc "我的客户端"

# 查看所有 userKey
pnpm admin list

# 查看详细信息  
pnpm admin show <userKey前8位>
```


## 📖 API 接口一览

访问 `http://localhost:3000/frkbapi/v1` 查看完整的API信息。

### 核心同步接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/frkbapi/v1/fingerprint-sync/check` | POST | 同步预检查 |
| `/frkbapi/v1/fingerprint-sync/bidirectional-diff` | POST | 双向差异检测 |
| `/frkbapi/v1/fingerprint-sync/add` | POST | 批量添加指纹 |
| `/frkbapi/v1/fingerprint-sync/pull-diff-page` | POST | 分页拉取差异 |

### 监控接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 基础健康检查 |
| `/frkbapi/v1/health/detailed` | GET | 详细系统状态 |
| `/frkbapi/v1/fingerprint-sync/status` | GET | 同步状态查询 |

## ⚙️ 常用管理命令

```bash
# CLI 管理工具
pnpm admin create --desc "新用户"          # 创建 userKey
pnpm admin list --active                   # 查看活跃用户
pnpm admin show <userKey>                  # 查看用户详情
pnpm admin status                          # 查看系统状态
pnpm admin cleanup                         # 清理无效数据（无主指纹/无主或空meta）

# 服务管理
pnpm start                                 # 生产模式启动
pnpm dev                                   # 开发模式启动  

pnpm logs                                  # 查看实时日志
```

## 🔧 常见问题解决

### 数据库连接失败

**错误**: `MongoDB connection failed`

**解决**:
1. 确保 MongoDB 服务正在运行
2. 检查 `.env` 中的数据库配置
3. 创建数据库用户和权限：

```javascript
// 在 MongoDB shell 中执行
use frkb_db
db.createUser({
  user: "frkb_user",
  pwd: "your-password",
  roles: [{ role: "readWrite", db: "frkb_db" }]
})
```

### API 密钥验证失败

**错误**: `API密钥无效`

**解决**:
1. 确保请求头包含正确的 Authorization: `Bearer YOUR_API_KEY`
2. 检查 `.env` 中的 `API_SECRET_KEY` 配置
3. 确保客户端和服务端使用相同的密钥

### userKey 不存在

**错误**: `userKey未找到或未授权`

**解决**:
1. 使用 CLI 工具创建 userKey: `pnpm admin create --desc "描述"`
2. 检查 userKey 是否已被禁用: `pnpm admin show <userKey>`
3. 确保 userKey 格式正确 (UUID v4)

## 🎯 下一步

1. **阅读文档**: 查看 `docs/` 目录下的详细文档
2. **客户端集成**: 参考 `README.md` 中的客户端配置示例
3. **性能调优**: 根据实际使用情况调整 `.env` 中的性能参数
4. **监控设置**: 配置日志监控和告警系统

## 📞 获取帮助

- 📚 **完整文档**: 查看 `docs/` 目录
- 🐛 **问题反馈**: 提交 issue 或查看日志文件
- 💬 **技术交流**: 查看项目 README 中的联系方式

---

🎉 **恭喜！** 您已成功启动 FRKB-API 系统，现在可以开始体验高效的指纹（SHA256）集合同步服务了！