# 数据库设计（精简版）

仅保留与当前模型实现一致的关键字段与索引；其余实现方案从文档中移除。

## 集合与模型

1) 用户指纹集合：`UserFingerprintCollection`（`src/models/UserFingerprintCollection.js`）
- 字段：`userKey`（UUID v4）、`fingerprint`（64位十六进制 SHA256）、`createdAt`、`updatedAt`
- 索引：`{ userKey: 1, fingerprint: 1 }` 唯一；`{ userKey: 1, createdAt: -1 }`

2) 用户集合元数据：`UserCollectionMeta`（`src/models/UserCollectionMeta.js`）
- 字段：`userKey`（唯一）、`totalCount`、`collectionHash`、`lastSyncAt`、`createdAt`、`updatedAt`
- 额外：可选 `bloomFilter` 缓存字段；`syncStats` 统计
- 索引：`userKey` 唯一；`{ lastSyncAt: -1 }`、`{ totalCount: 1 }`

3) 授权密钥白名单：`AuthorizedUserKey`（`src/models/AuthorizedUserKey.js`）
- 字段：`userKey`（UUID v4，唯一）、`description`、`isActive`、`createdBy`、`lastUsedAt`、`usageStats`、`notes`
- 索引：`userKey` 唯一；`isActive`、`lastUsedAt`、`createdAt`

## 约束与校验
- `userKey` 必须满足 UUID v4 正则；`fingerprint` 必须为 64 位十六进制（SHA256）
- 所有模型均开启 `timestamps`，并关闭 `versionKey`

## 建议
- 大批量写入使用 `bulkWrite(upsert)`；查询使用 `select + lean()`
- 按 `userKey` 组织数据，索引命中以保证常见查询路径

备注：更详细的数据库操作与优化请参考源码中的服务层与模型方法。