# 安全（精简版）

本页仅保留必要的对接与配置信息，细节以 `src/middlewares/` 为准。

## 验证与权限
- API密钥：请求头 `Authorization: Bearer <API_SECRET_KEY>`，使用常量时间比较；必须配置 `API_SECRET_KEY`
- userKey：UUID v4；格式校验 + 白名单校验（模型 `AuthorizedUserKey`），仅启用/禁用
- 频率限制：全局基础限流（100次/分钟）+ 敏感操作严格限流（10次/5分钟），已启用

## 配置
示例 `.env` 关键项：
```
API_SECRET_KEY=your-secure-api-key
# 全局基础限流：100次/分钟
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
MONGODB_URI=mongodb://localhost:27017/frkb_db
```

## 通信
- 默认使用 HTTP；是否启用 HTTPS 由部署环境决定
- 请求体大小与 JSON 解析限制已在服务端启用

## 日志与审计
- 认证失败、权限拒绝与安全相关事件会记录日志（查看 `src/utils/logger.js`）

## CLI 工具安全
- 删除和重置操作需要 `--confirm` 参数确认
- 危险操作有5秒等待期，防止误操作（可用 `--force` 跳过）
- 所有管理操作记录详细日志，包括操作者和影响范围
- 建议在生产环境中限制对CLI工具的访问权限

以上为最小必要信息；其余实现级示例代码已移除以保证文档精简。