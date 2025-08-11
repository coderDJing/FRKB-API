# CLI 工具（精简版）

本文仅保留可用命令与示例，更多细节参考 `cli/admin.js` 与模型实现。

## 可用命令

- 创建 userKey（支持描述、权限、请求上限；不再支持过期时间）
```bash
node cli/admin.js create-userkey --desc "张三的客户端"
node cli/admin.js create-userkey --desc "只读账号" --no-sync --daily-limit 100
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
```

- 系统维护
```bash
node cli/admin.js status
node cli/admin.js cleanup
```

说明：命令实际以 `cli/admin.js` 为准；userKey 永不过期，如需停用请使用 deactivate。

## 使用前置
- 需配置 `MONGODB_URI` 等数据库连接环境变量
- 工具默认本地执行，无额外网络暴露

## 输出
- 创建、列表、统计等命令均提供人类可读输出；可结合终端重定向保存记录

本页去除了实现级代码示例与长篇输出样例，以保持文档简洁。