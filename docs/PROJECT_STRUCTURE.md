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
│   ├── middlewares/         # 认证/限流/校验/错误处理
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

更多细节以源码为准；本页不再包含实现级代码片段。

