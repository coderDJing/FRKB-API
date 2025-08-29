# CLI 工具（精简版）

本文仅保留可用命令与示例，更多细节参考 `cli/admin.js` 与模型实现。

## 可用命令

- 创建 userKey（支持描述、权限、请求上限；不再支持过期时间）
```bash
node cli/admin.js create-userkey --desc "张三的客户端"
```

- 列出 userKey（支持筛选与数量限制）
```bash
node cli/admin.js list-userkeys
node cli/admin.js list --active
node cli/admin.js list --limit 10
node cli/admin.js list --full        # 在列表中显示完整 userKey（谨慎在共享环境使用）
```

- 查看/管理单个 userKey
```bash
node cli/admin.js show-userkey <shortId|fullUUID>
node cli/admin.js deactivate <shortId|fullUUID> --reason "用户要求删除"
node cli/admin.js set-fplimit <shortId|fullUUID> <limitWan>   # 设置指纹上限，单位：万；例如 30 即 300000
```

- 危险操作（需要 --confirm 确认）
```bash
# 完全删除 userKey 及其所有数据（不可恢复）
node cli/admin.js delete-userkey <shortId|fullUUID> --confirm

# 重置 userKey 数据，保留 userKey 但清空所有使用记录
node cli/admin.js reset-userkey <shortId|fullUUID> --confirm --notes "重新开始"

# 使用 --force 跳过5秒等待期
node cli/admin.js delete <shortId|fullUUID> --confirm --force
```

- 系统维护
```bash
node cli/admin.js status
node cli/admin.js cleanup
```

说明：
- 命令实际以 `cli/admin.js` 为准；userKey 永不过期，如需停用请使用 deactivate
- **危险操作说明**：
  - `delete-userkey`: 完全删除 userKey 记录及所有相关数据，不可恢复
  - `reset-userkey`: 保留 userKey 但清空所有指纹数据和使用统计，恢复到刚创建状态
  - 两个命令都需要 `--confirm` 参数确认，默认有5秒等待期防止误操作

## 使用前置
- 需配置 `MONGODB_URI` 等数据库连接环境变量
- 工具默认本地执行，无额外网络暴露

## 输出
- 创建、列表、统计等命令均提供人类可读输出；可结合终端重定向保存记录

### 关于 show-userkey 输出
- 现在会额外显示一行指纹上限：
  - `📈 指纹上限: 200,000 条`
  - 若通过 `set-fplimit` 设置为 `30`，则显示 `300,000 条`

本页去除了实现级代码示例与长篇输出样例，以保持文档简洁。