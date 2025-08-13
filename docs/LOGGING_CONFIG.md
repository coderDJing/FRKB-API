# 日志系统配置文档

## 概述

FRKB-API 使用优化后的日志系统，提供精简的日志记录和灵活的轮转机制。日志系统专注于记录关键信息，避免过度记录和日志文件无限增长。

## 日志配置选项

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `LOG_DIR` | `./logs` | 日志文件存储目录 |
| `LOG_LEVEL` | `info` | 日志级别 (error, warn, info, debug) |
| `LOG_MAX_SIZE` | `5m` | 单个日志文件最大大小 |
| `LOG_APP_RETENTION` | `3d` | 应用日志保留时间 |
| `LOG_ERROR_RETENTION` | `7d` | 错误日志保留时间 |
| `LOG_MINIMAL` | `false` | 是否启用最小日志模式 |
| `LOG_SKIP_HEALTH` | `true` | 是否跳过健康检查日志 |
| `LOG_SKIP_AUTH_SUCCESS` | `true` | 是否跳过成功认证日志 |

### 日志级别说明

- **error**: 错误信息，系统异常
- **warn**: 警告信息，慢请求，安全事件
- **info**: 一般信息，重要操作记录
- **debug**: 调试信息（仅开发环境）

## 日志文件类型

### 1. 应用日志 (`app-YYYY-MM-DD.log`)
- 记录所有 info 级别以上的日志
- 保留时间：3天（可配置）
- 自动压缩存档

### 2. 错误日志 (`error-YYYY-MM-DD.log`)
- 仅记录 error 级别的日志
- 保留时间：7天（可配置）
- 自动压缩存档

### 3. 异常日志 (`exceptions-YYYY-MM-DD.log`)
- 记录未捕获的异常
- 保留时间：7天

### 4. Promise拒绝日志 (`rejections-YYYY-MM-DD.log`)
- 记录未处理的 Promise 拒绝
- 保留时间：7天

## 精简模式 (LOG_MINIMAL=true)

启用精简模式后：
- 成功的 API 请求不记录日志
- 元数据信息大幅减少
- 只记录错误、警告和关键操作

## 日志格式

### 标准格式
```
[2024-01-15 10:30:45] INFO: 请求成功 | {"method":"GET","url":"/api/data","status":200,"duration":"120ms","userKey":"user123"}
```

### 精简格式 (minimal=true)
```
[2024-01-15 10:30:45] ERROR: 服务器错误
```

## 性能优化

### 1. 日志轮转
- 按日期自动轮转
- 自动压缩历史文件
- 自动删除过期文件

### 2. 条件记录
- 健康检查请求默认不记录
- 成功认证请求可选择不记录
- 性能监控只记录慢操作（>3秒）

### 3. 内存优化
- 减少元数据字段
- 移除不必要的信息（IP、User-Agent等）
- 异步写入，不阻塞主线程

## 使用建议

### 生产环境推荐配置
```bash
NODE_ENV=production
LOG_LEVEL=warn
LOG_MINIMAL=true
LOG_APP_RETENTION=1d
LOG_ERROR_RETENTION=3d
```

### 开发环境推荐配置
```bash
NODE_ENV=development
LOG_LEVEL=debug
LOG_MINIMAL=false
LOG_SKIP_HEALTH=true
```

### 调试环境配置
```bash
LOG_LEVEL=debug
LOG_MINIMAL=false
LOG_SKIP_HEALTH=false
LOG_SKIP_AUTH_SUCCESS=false
```

## 监控建议

1. **错误率监控**: 关注 error 级别日志的频率
2. **性能监控**: 关注 warn 级别的慢操作日志
3. **磁盘空间**: 定期检查日志目录的磁盘使用
4. **日志轮转**: 确保日志轮转正常工作

## 故障排查

### 常见问题

1. **日志文件过大**
   - 减小 `LOG_MAX_SIZE` 值
   - 启用 `LOG_MINIMAL` 模式
   - 缩短日志保留时间

2. **日志信息不足**
   - 降低 `LOG_LEVEL` 等级
   - 关闭 `LOG_MINIMAL` 模式
   - 检查特定操作的跳过配置

3. **性能影响**
   - 启用精简模式
   - 提高日志级别到 warn 或 error
   - 增加日志轮转频率

## 快速配置

### 生产环境配置
```bash
# 高性能，低存储消耗
LOG_LEVEL=warn
LOG_MINIMAL=true
LOG_APP_RETENTION=1d
LOG_ERROR_RETENTION=3d
LOG_SKIP_HEALTH=true
LOG_SKIP_AUTH_SUCCESS=true
```

### 开发环境配置
```bash
# 详细调试信息
LOG_LEVEL=debug
LOG_MINIMAL=false
LOG_SKIP_HEALTH=true
LOG_SKIP_AUTH_SUCCESS=false
```

### 故障排查配置
```bash
# 最详细的日志记录
LOG_LEVEL=debug
LOG_MINIMAL=false
LOG_SKIP_HEALTH=false
LOG_SKIP_AUTH_SUCCESS=false
LOG_APP_RETENTION=7d
LOG_ERROR_RETENTION=14d
```

## 升级说明

从旧版本升级时，新的日志配置会：
- 自动启用优化的日志格式
- 缩短默认保留时间（从14天降至3天）
- 减少记录的详细信息（移除IP、User-Agent等）
- 提高生产环境控制台日志级别（从info提升至warn）

如需保持详细日志，请设置：
```bash
LOG_MINIMAL=false
LOG_APP_RETENTION=14d
LOG_ERROR_RETENTION=30d
```
