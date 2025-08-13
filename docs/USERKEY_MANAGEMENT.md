# userKey 管理（精简版）

## 规范
- 格式：UUID v4（大小写不敏感）
- 白名单：`AuthorizedUserKey` 模型维护，必须处于激活状态（仅启用/禁用，无细粒度权限与日配额）

## 生命周期（管理员）
- 创建：使用 CLI `create-userkey`，可设置描述（不支持过期时间）
- 查看：`list-userkeys`、`show-userkey <短ID或全ID>`
- 管理：`deactivate <短ID或全ID>`（示例以当前代码实现为准）

## 客户端配置要点
- 保存服务端下发的 `userKey` 到客户端配置
- 与 `API_SECRET_KEY` 一起作为请求凭据

## 错误码（常见）
- `INVALID_USER_KEY`、`USER_KEY_NOT_FOUND`、`FORBIDDEN`

本页移除了实现代码与长样例，保持与当前实现一致的最小说明。