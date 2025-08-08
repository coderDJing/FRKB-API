# API 速览（精简版）

本页仅保留对接所需信息；实现细节以源码为准（`src/routes/`、`src/controllers/`）。

## 基础
- 基础前缀：`/frkbapi/v1/md5-sync`
- 认证：请求头 `Authorization: Bearer <API_SECRET_KEY>`（必填）
- 用户标识：请求体传 `userKey`（UUID v4，需在白名单）

## 接口列表

1) 同步预检查
- 方法与路径：POST `/check`
- 请求体：`{ userKey, count, hash }`
- 返回：`{ success, needSync, reason, serverCount, serverHash, lastSyncAt }`

- 认证：需要 API 密钥（Authorization: Bearer ...）+ userKey（放在 body）

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| count | body | integer | 是 | >= 0 | 客户端 MD5 集合总数 |
| hash | body | string | 是 | 64 位十六进制（SHA256） | 客户端集合哈希 |

2) 双向差异检测（分批）
- 方法与路径：POST `/bidirectional-diff`
- 请求体：`{ userKey, clientMd5s, batchIndex, batchSize }`
- 返回：`{ success, missingOnClient, missingOnServer, batchIndex }`

- 认证：需要 API 密钥 + userKey（放在 body）

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| clientMd5s | body | string[] | 是 | 长度 1..`BATCH_SIZE`；每项 32 位十六进制；去重 | 当前批次的 MD5 列表 |
| batchIndex | body | integer | 是 | >= 0 | 批次索引（从 0 开始） |
| batchSize | body | integer | 是 | 1..`BATCH_SIZE` | 每批大小 |

3) 批量新增
- 方法与路径：POST `/add`
- 请求体：`{ userKey, addMd5s }`
- 返回：`{ success, addedCount, duplicateCount, totalRequested }`

- 认证：需要 API 密钥 + userKey（放在 body）

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| addMd5s | body | string[] | 是 | 长度 1..`BATCH_SIZE`；每项 32 位十六进制；去重 | 待新增的 MD5 列表 |

4) 一次性差异分析（会话）
- 方法与路径：POST `/analyze-diff`
- 请求体：`{ userKey, clientMd5s }`
- 返回：`{ success, diffSessionId, diffStats: { totalMissing, totalPages, pageSize } }`

- 认证：需要 API 密钥 + userKey（放在 body）

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| clientMd5s | body | string[] | 是 | 长度 1..100000；每项 32 位十六进制 | 客户端完整 MD5 集合 |

5) 分页拉取差异
- 方法与路径：POST `/pull-diff-page`
- 请求体：`{ userKey, diffSessionId, pageIndex }`
- 返回：`{ success, missingMd5s, pageInfo: { currentPage, pageSize, totalPages, hasMore } }`

- 认证：需要 API 密钥 + userKey（放在 body）

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| diffSessionId | body | string | 是 | 正则 `/^diff_[a-z0-9]+$/i` | 差异会话 ID（来自 `/analyze-diff`） |
| pageIndex | body | integer | 是 | >= 0 | 拉取页码（从 0 开始） |

6) 同步状态
- 方法与路径：GET `/status?userKey=...`

- 认证：需要 API 密钥 + userKey（放在 query）

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | query | string | 是 | UUID v4 | 同步用户标识 |

7) 服务统计
- 方法与路径：GET `/service-stats`

- 认证：需要 API 密钥（无需 userKey）
- 参数：无

8) 清除用户缓存
- 方法与路径：DELETE `/cache/:userKey`

- 认证：需要 API 密钥 + 同步权限；调用方需提供自身 `userKey`（放在 body 或 query）以通过认证

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| :userKey | path | string | 是 | UUID v4 | 目标用户（被清理缓存） |

- 备注：路径参数为目标用户；调用方的 `userKey` 仅用于认证。

9) 强制释放同步锁（管理员）
- 方法与路径：DELETE `/lock/:userKey`

- 认证：需要管理员令牌 `adminToken`（query，匹配环境变量 `ADMIN_SECRET_TOKEN`），不需要 API 密钥

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| :userKey | path | string | 是 | UUID v4 | 目标用户（被释放锁） |
| adminToken | query | string | 是 | 非空 | 管理员令牌 |

## 参数与校验
- `userKey`：UUID v4，大小写不敏感
- `md5`：32位十六进制字符串；数组建议批量1000条
- 请求体大小默认限制与频率限制已在服务端开启

## 错误响应（统一）
```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "错误描述"
}
```
常见错误码：`INVALID_API_KEY`、`INVALID_USER_KEY`、`BAD_REQUEST`、`RATE_LIMITED`、`DIFF_SESSION_NOT_FOUND`、`INTERNAL_ERROR`。

## 客户端建议
- 先调用 `/check` 决定是否继续
- 大数据分批（建议 `batchSize=1000`）
- 只提交有效MD5；网络失败由客户端自行重试/断点续传

