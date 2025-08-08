# 安全（精简版）

本页仅保留必要的对接与配置信息，细节以 `src/middlewares/` 为准。

## 验证与权限
- API密钥：请求头 `Authorization: Bearer <API_SECRET_KEY>`，使用常量时间比较；必须配置 `API_SECRET_KEY`
- userKey：UUID v4；格式校验 + 白名单校验（模型 `AuthorizedUserKey`）
- 权限：按操作检查 `permissions.canSync`/`permissions.canQuery`
- 频率限制：按路由使用不同策略（宽松/严格/同步专用），已启用

## 配置
示例 `.env` 关键项：
```
API_SECRET_KEY=your-secure-api-key
RATE_LIMIT_MAX=100
MONGODB_URI=mongodb://localhost:27017/frkb_db
```

## 通信
- 默认使用 HTTP；是否启用 HTTPS 由部署环境决定
- 请求体大小与 JSON 解析限制已在服务端启用

## 日志与审计
- 认证失败、权限拒绝与安全相关事件会记录日志（查看 `src/utils/logger.js`）

以上为最小必要信息；其余实现级示例代码已移除以保证文档精简。