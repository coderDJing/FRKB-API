# Fingerprint API 速览（64 位 SHA256，对接版）

本页面向客户端对接，所有字段与返回均与实现同步（以 `src/routes/` 与 `src/controllers/` 为准）。

## 全局信息
- 基础前缀：`/frkbapi/v1/fingerprint-sync`
- 鉴权：所有业务接口默认需要请求头 `Authorization: Bearer <API_SECRET_KEY>`，并携带 `userKey`
- 请求头：`Content-Type: application/json`
- 请求体大小：JSON 解析按环境变量 `REQUEST_SIZE_LIMIT`（默认 10MB），但额外校验当前限制为 10MB，超过将返回错误
- 速率限制：全局基础限流（100次/分钟），敏感操作额外严格限流（10次/5分钟）；响应包含标准限流头（`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`）
- 会话 TTL：差异会话有效期 5 分钟（`SYNC_CONFIG.DIFF_SESSION_TTL`）
- 指纹规范：64 位十六进制（SHA256），小写；数组必须去重，否则请求会因重复项被拒绝
- 批量大小：`BATCH_SIZE` 源自服务端配置（环境变量 `BATCH_SIZE`，默认 1000）

---

## 1) 同步预检查（指纹）
- 方法与路径：POST `/check`
- 认证：需要 API 密钥 + `userKey`（body）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| count | body | integer | 是 | >= 0 | 客户端指纹集合总数 |
| hash | body | string | 是 | 64 位十六进制（SHA256） | 客户端集合哈希 |

- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| needSync | boolean | 是否需要继续同步 |
| reason | string | 判定原因：`already_synced`/`count_mismatch`/`hash_mismatch`/`server_empty`/`client_empty`/`sync_in_progress` |
| message | string | 友好提示 |
| serverCount | number | 服务端指纹数量 |
| serverHash | string | 服务端集合哈希（SHA256）|
| clientCount | number | 回显客户端数量 |
| clientHash | string | 回显客户端哈希 |
| lastSyncAt | string | 上次同步时间 |
| performance | object | 性能指标（毫秒） |
| timestamp | string | 服务端时间戳 |

---

## 1a) 校验 userKey（只读）
- 方法与路径：POST `/validate-user-key`
- 认证：需要 API 密钥（无需 `userKey` 权限检查）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 需验证的用户标识 |

- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| data.userKey | string | 标准化后的 userKey |
| data.isActive | boolean | 是否激活 |
| data.permissions | object | 已移除（仅保留启用/禁用状态） |
| data.description | string | 描述信息 |
| data.lastUsedAt | string/null | 最近使用时间 |
| performance | object | `{ validateDuration }` |
| timestamp | string | 时间戳 |

说明：
- 该端点只做“格式 + 白名单可用性”只读校验，不写入统计。

---

## 2) 双向差异检测（分批，指纹）
- 方法与路径：POST `/bidirectional-diff`
- 认证：需要 API 密钥 + `userKey`（body）
- 速率限制：全局基础限流（100次/分钟）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| clientFingerprints | body | string[] | 是 | 1..`BATCH_SIZE`；每项 64 位十六进制；去重 | 当前批次指纹列表 |
| batchIndex | body | integer | 是 | >= 0 | 批次索引（从 0 开始） |
| batchSize | body | integer | 是 | 1..`BATCH_SIZE` | 每批大小 |

- 成功返回字段（命名以实现为准）：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| batchIndex | number | 批次索引 |
| batchSize | number | 批大小 |
| serverMissingFingerprints | string[] | 服务端缺失（客户端需“推送到服务端”）|
| serverExistingFingerprints | string[] | 服务端已存在 |
| counts | object | 统计信息：`{ clientBatch, serverMissing, serverExisting }` |
| sessionInfo | object/null | 仅在 `batchIndex=0` 且预估客户端缺失时返回，包含 `sessionId` 等信息，供后续分页拉取 |
| bloomFilterStats | object/null | 布隆过滤器统计（启用时）|
| performance | object | 性能指标 |
| timestamp | string | 时间戳 |

说明：此前文档中的 `missingOnClient`/`missingOnServer` 字段已更正为 `serverMissingFingerprints` 与 `serverExistingFingerprints`，请以此为准。

---

## 3) 批量新增（指纹）
- 方法与路径：POST `/add`
- 认证：需要 API 密钥 + `userKey`（body）
- 速率限制：全局基础限流（100次/分钟）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| addFingerprints | body | string[] | 是 | 1..`BATCH_SIZE`；每项 64 位十六进制；去重 | 待新增指纹列表 |

- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| addedCount | number | 新增条数 |
| duplicateCount | number | 已存在条数 |
| totalRequested | number | 请求条数 |
| batchResult | object | 简要统计 |
| performance | object | 性能指标 |
| timestamp | string | 时间戳 |

说明：
- 口径：`duplicateCount` 仅统计“服务器已存在”的重复；若请求体内存在重复指纹，服务端将以 400 校验错误直接拒绝（客户端需在提交前去重）。

---

## 4) 一次性差异分析（会话，指纹）
- 方法与路径：POST `/analyze-diff`
- 认证：需要 API 密钥 + `userKey`（body）
- 速率限制：严格限流（较重操作）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| clientFingerprints | body | string[] | 是 | 0..100000；64 位十六进制 | 客户端完整指纹集合（允许为空用于全量拉取）|

- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| diffSessionId | string | 差异会话 ID（用于分页拉取）|
| diffStats | object | `{ clientMissingCount, serverMissingCount, totalPages, pageSize }` |
| serverStats | object | `{ totalFingerprintCount, clientCurrentCount }` |
| recommendations | object | 同步建议 |
| performance | object | 性能指标 |
| timestamp | string | 时间戳 |

---

## 5) 分页拉取差异（指纹）
- 方法与路径：POST `/pull-diff-page`
- 认证：需要 API 密钥 + `userKey`（body）
- 速率限制：全局基础限流（100次/分钟）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 同步用户标识 |
| diffSessionId | body | string | 是 | `/^diff_[a-z0-9_]+$/i` | 会话 ID（来自 `/analyze-diff`）|
| pageIndex | body | integer | 是 | >= 0 | 从 0 开始 |

- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| sessionId | string | 会话 ID |
| missingFingerprints | string[] | 本页需要“拉取到客户端”的指纹 |
| pageInfo | object | `{ currentPage, pageSize, totalPages, hasMore, totalCount }` |
| performance | object | 性能指标 |
| timestamp | string | 时间戳 |

默认分页大小：`SYNC_CONFIG.DEFAULT_PAGE_SIZE = 1000`。

说明：
- 分页集合基于 `/analyze-diff` 的 `missingInClient` 结果；同一 `diffSessionId` 内分页顺序稳定；页内按 `fingerprint` 升序。
- 会话过期/不存在：返回 404，错误码 `DIFF_SESSION_NOT_FOUND`（响应体可包含 `retryAfter` 秒数提示需重新执行 `/analyze-diff`）。

---

## 6) 同步状态
- 方法与路径：GET `/status?userKey=...`
- 认证：需要 API 密钥 + `userKey`（query）
- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| userKey | string | 标准化后的 userKey |
| syncStatus | object/null | 当前同步锁信息（若有）|
| userMeta | object/null | 缓存的用户集合元数据 |
| bloomFilterStats | object/null | 布隆过滤器统计 |
| timestamp | string | 时间戳 |

---

## 7) 服务统计
- 方法与路径：GET `/service-stats`
- 认证：仅需要 API 密钥（无需 `userKey`）
- 成功返回（示意）：

```json
{
  "success": true,
  "stats": {
    "activeSessions": 0,
    "syncLocks": 0,
    "cacheStats": { "enabled": true, "size": 0, "hitRate": "0%" },
    "bloomFilterStats": { "enabled": true, "totalFilters": 0 }
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## 8) 清除用户缓存
- 方法与路径：DELETE `/cache/:userKey`
- 认证：需要 API 密钥 + 同步权限；调用方需携带“自身 `userKey`”（body 或 query 中）以通过认证，路径参数为“目标用户”
- 成功返回字段：`{ success, message, clearedItems: { cache, bloomFilter }, timestamp }`

---

## 9) 强制释放同步锁（管理员）
- 方法与路径：DELETE `/lock/:userKey`
- 认证：仅需 `adminToken`（query），匹配环境变量 `ADMIN_SECRET_TOKEN`；不需要 API 密钥
- 成功返回字段：`{ success, message, previousLock, timestamp }`

---

## 10) 重置用户数据（不重置使用统计）
- 方法与路径：POST `/reset`
- 认证：需要 API 密钥 + `userKey`（body）
- 速率限制：严格限流（敏感操作）
- 请求体字段：

| 字段 | 位置 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|---|
| userKey | body | string | 是 | UUID v4 | 目标用户标识 |
| notes | body | string | 否 | ≤500 字 | 重置备注（将写入 `AuthorizedUserKey.notes`）|

- 成功返回字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| success | boolean | 是否成功 |
| message | string | 固定为“userKey数据已重置” |
| userKey | string | 标准化后的 userKey |
| before.fingerprintCount | number | 重置前指纹条数 |
| before.metaCount | number | 重置前元数据记录条数 |
| before.usageStats.totalRequests | number | 使用统计（仅回显，不会被清零）|
| before.usageStats.totalSyncs | number | 使用统计（仅回显，不会被清零）|
| result.clearedFingerprints | number | 实际删除的指纹条数 |
| result.clearedMetas | number | 实际删除的元数据条数 |
| result.deletedSessions | number | 删除的差异会话数 |
| result.clearedCache | number | 清理的缓存项数 |
| timestamp | string | 时间戳 |

- 成功请求示例：

```bash
curl -X POST "$BASE_URL/frkbapi/v1/fingerprint-sync/reset" \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "userKey": "550e8400-e29b-41d4-a716-446655440000",
    "notes": "客户端发起重置"
  }'
```

- 说明：
- 该操作将删除该 `userKey` 的全部指纹数据与元数据，清理相关缓存与持久化差异会话；但不会重置 `AuthorizedUserKey.usageStats`。
- 调用方需携带有效 `API_SECRET_KEY`，并在 body 中提供有效 `userKey`。

- 可能的错误：
  - `401 INVALID_API_KEY`：缺少/格式错误/无效的 Authorization 头
  - `400 INVALID_USER_KEY`：`userKey` 缺失或格式不合法
  - `404 USER_KEY_NOT_FOUND`：白名单不存在该 `userKey`
  - `403 USER_KEY_INACTIVE`：该 `userKey` 已被禁用
  - `429 STRICT_RATE_LIMIT_EXCEEDED`：敏感操作触发严格限流（含 `retryAfter` 秒）
  - `400 REQUEST_TOO_LARGE`：请求体超过 10MB
  - `500 INTERNAL_ERROR` / `AUTH_ERROR`：服务端内部错误或认证异常

- 错误响应（示例）：

```json
{
  "success": false,
  "error": "STRICT_RATE_LIMIT_EXCEEDED",
  "message": "敏感操作请求过于频繁，请稍后再试",
  "details": { "windowMs": 300000, "maxRequests": 10, "retryAfter": 300 },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

## 错误响应（统一）

```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "错误描述",
  "details": { "...": "..." },
  "timestamp": "ISO8601"
}
```

常见错误码：
- `INVALID_API_KEY`、`INVALID_USER_KEY`
- `RATE_LIMIT_EXCEEDED`、`STRICT_RATE_LIMIT_EXCEEDED`
- `VALIDATION_ERROR`、`INVALID_FINGERPRINT_FORMAT`、`REQUEST_TOO_LARGE`
- `DIFF_SESSION_NOT_FOUND`（会话过期/不存在）、`INTERNAL_ERROR`

HTTP 状态：200/400/401/403/404/409/429/500（与实现中的错误处理中间件一致）。

---

## 对接建议
- 先调用 `/check` 决定是否继续
- 批量大小建议 1000；失败使用指数退避重试；支持断点续传
- 保证指纹数组去重与格式合法（64 位十六进制 SHA256），避免被后端拒绝
- 关注响应限流头与 `performance` 字段，适当调节并发与批大小

---

## 附：健康接口速览（无业务鉴权）
- 基础健康：GET `/health`（无需鉴权）。返回进程与数据库连通状态；非 200 视为不健康。
- 详细健康：GET `/frkbapi/v1/health/detailed`。返回组件健康、内存/CPU、耗时等。
- 系统统计：GET `/frkbapi/v1/health/stats`。返回数据库、运行时与服务统计。
- 诊断接口：GET `/frkbapi/v1/health/diagnose`（严格限流，需 `adminToken`）。返回诊断与建议。

---

## 快速开始（客户端最小示例）

以下以 `BASE_URL` 表示服务器地址（如 `http://localhost:3001`），统一前缀 `PREFIX=/frkbapi/v1/fingerprint-sync`。

- 必备请求头：

```http
Authorization: Bearer <API_SECRET_KEY>
Content-Type: application/json
```

- fetch 示例：

```javascript
const BASE_URL = 'http://localhost:3001';
const PREFIX = '/frkbapi/v1/fingerprint-sync';
const API_SECRET_KEY = '<your-api-secret-key>';

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${PREFIX}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// 1) 预检查
const check = await post('/check', { userKey, count, hash });
if (!check.success) throw new Error(check.message);

// 2) 若需要同步，按 1000 批次进行双向差异（示意）
const batchSize = 1000;
for (let i = 0; i < clientFingerprints.length; i += batchSize) {
  const batch = clientFingerprints.slice(i, i + batchSize);
  const diff = await post('/bidirectional-diff', {
    userKey,
    clientFingerprints: batch,
    batchIndex: Math.floor(i / batchSize),
    batchSize
  });
  // 将 diff.serverMissingFingerprints 聚合，稍后统一 /add 推送到服务端
}

// 3) 可选择一次性差异+分页拉取客户端缺失
const analysis = await post('/analyze-diff', { userKey, clientFingerprints });
for (let page = 0; page < analysis.diffStats.totalPages; page++) {
  const pageRes = await post('/pull-diff-page', {
    userKey,
    diffSessionId: analysis.diffSessionId,
    pageIndex: page
  });
  // 将 pageRes.missingFingerprints 合入本地集合
}

// 4) 推送服务端缺失
const toAdd = aggregateAllServerMissing();
for (let i = 0; i < toAdd.length; i += batchSize) {
  const addRes = await post('/add', { userKey, addFingerprints: toAdd.slice(i, i + batchSize) });
}
```

- axios 示例：

```javascript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3001/frkbapi/v1/fingerprint-sync',
  headers: { Authorization: `Bearer ${API_SECRET_KEY}` }
});

const { data: check } = await api.post('/check', { userKey, count, hash });
```

- curl 示例：

```bash
curl -X POST \
  "$BASE_URL/frkbapi/v1/fingerprint-sync/check" \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userKey":"...","count":12345,"hash":"<64hex>"}'
```

---

## 各端点最小调用示例

以下仅列出关键示例，参数定义仍以上方端点小节为准。

- POST `/check`（fetch）

```javascript
await post('/check', { userKey, count, hash });
```

- POST `/bidirectional-diff`（fetch）

```javascript
await post('/bidirectional-diff', { userKey, clientFingerprints: batch, batchIndex, batchSize });
```

- POST `/add`（fetch）

```javascript
await post('/add', { userKey, addFingerprints });
```

- POST `/analyze-diff` + `/pull-diff-page`（fetch）

```javascript
const a = await post('/analyze-diff', { userKey, clientFingerprints });
const p0 = await post('/pull-diff-page', { userKey, diffSessionId: a.diffSessionId, pageIndex: 0 });
```

- GET `/status`（fetch）

```javascript
const res = await fetch(`${BASE_URL}${PREFIX}/status?userKey=${encodeURIComponent(userKey)}`, {
  headers: { Authorization: `Bearer ${API_SECRET_KEY}` }
});
const data = await res.json();
```

---

## 重试与幂等策略（客户端建议）

- 幂等：
  - `/add` 对已存在的指纹不会重复创建（返回 `duplicateCount` 统计），可按批次安全重试。
  - 差异计算与分页拉取为读操作，重试安全。
- 重试建议：
  - 网络/5xx/429：指数退避（如 1s、2s、4s，上限 30s），最多 3-5 次。
  - 400/401/403：修正参数或鉴权后再发起，不要盲目重试。
- 批处理：
  - 建议 `batchSize=1000`，失败仅重试失败批次。

---

## 速率限制与响应头

- 服务端启用标准 RateLimit 响应头（如 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`）。
- 触发限流时，响应 JSON 会包含 `retryAfter` 秒数提示；也可能返回 `Retry-After` 头。
- 限流策略：
  - 常规接口（同步、查询、健康等）：全局基础限流（100次/分钟）
  - 敏感操作（`/analyze-diff`、缓存清理、锁管理、系统诊断）：额外严格限流（10次/5分钟）

---

## 常见错误码与处理建议

| 错误码 | HTTP | 说明 | 客户端处理 |
|---|---:|---|---|
| INVALID_API_KEY | 401 | API 密钥缺失/错误 | 校验并重新配置密钥 |
| INVALID_USER_KEY | 400/404 | userKey 格式无效或不存在 | 修正 userKey 或联系管理员发放 |
| RATE_LIMIT_EXCEEDED / STRICT_RATE_LIMIT_EXCEEDED | 429 | 触发限流 | 按 `retryAfter` 或指数退避重试，降低并发/批量 |
| INVALID_FINGERPRINT_FORMAT / VALIDATION_ERROR | 400 | 参数校验失败 | 修正参数；确保指纹去重且为 64 位十六进制（SHA256） |
| DIFF_SESSION_NOT_FOUND | 400/404 | 差异会话过期/不存在 | 重新执行 `analyze-diff` 并继续分页 |
| INTERNAL_ERROR | 500 | 服务器内部错误 | 记录请求，指数退避重试；若持续失败联系服务端 |

注：实际 HTTP 状态以响应为准；生产环境可能隐藏 `debug` 字段。

---

## 典型同步流程（伪代码）

```javascript
async function syncAll(userKey, clientFingerprints) {
  const hash = sha256OfSet(clientFingerprints);
  const check = await post('/check', { userKey, count: clientFingerprints.length, hash });
  if (!check.success || !check.needSync) return;

  // A. 服务端缺什么 → /bidirectional-diff 分批找出 → /add 推给服务端
  const batchSize = 1000;
  const serverMissing = [];
  for (let i = 0; i < clientFingerprints.length; i += batchSize) {
    const { serverMissingFingerprints } = await post('/bidirectional-diff', {
      userKey,
      clientFingerprints: clientFingerprints.slice(i, i + batchSize),
      batchIndex: Math.floor(i / batchSize),
      batchSize
    });
    serverMissing.push(...serverMissingFingerprints);
  }
  for (let i = 0; i < serverMissing.length; i += batchSize) {
    await post('/add', { userKey, addFingerprints: serverMissing.slice(i, i + batchSize) });
  }

  // B. 客户端缺什么 → /analyze-diff → /pull-diff-page 拉齐
  const analysis = await post('/analyze-diff', { userKey, clientFingerprints });
  for (let p = 0; p < analysis.diffStats.totalPages; p++) {
    const page = await post('/pull-diff-page', { userKey, diffSessionId: analysis.diffSessionId, pageIndex: p });
    clientFingerprints = union(clientFingerprints, page.missingFingerprints);
  }

  return clientFingerprints;
}
```

