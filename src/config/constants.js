/**
 * 系统常量配置
 */

module.exports = {
  // 批处理配置
  BATCH_CONFIG: {
    BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '2000'),  // 增加到2000提高效率
    MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT_BATCHES || '4'),  // 允许更多并发
    TIMEOUT_PER_BATCH: parseInt(process.env.TIMEOUT_PER_BATCH || '30000'),  // 增加超时时间
    RETRY_TIMES: parseInt(process.env.RETRY_TIMES || '3')
  },

  // 布隆过滤器配置
  BLOOM_FILTER: {
    ENABLED: process.env.BLOOM_FILTER_ENABLED === 'true',
    SIZE: parseInt(process.env.BLOOM_FILTER_SIZE || '1000000'),
    HASH_FUNCTIONS: parseInt(process.env.BLOOM_FILTER_HASH_FUNCTIONS || '10'),
    FALSE_POSITIVE_RATE: 0.01, // 1%误报率
    MIN_CAPACITY: parseInt(process.env.BLOOM_FILTER_MIN_CAPACITY || '50000'), // 最小容量5万
    GROWTH_MULTIPLIER: parseFloat(process.env.BLOOM_FILTER_GROWTH_MULTIPLIER || '5'), // 增长倍数
    BASE_MULTIPLIER: parseFloat(process.env.BLOOM_FILTER_BASE_MULTIPLIER || '1.2') // 基础倍数
  },

  // 缓存配置
  CACHE_CONFIG: {
    ENABLED: true,
    TTL: parseInt(process.env.CACHE_TTL || '3600'), // 1小时
    MAX_SIZE: parseInt(process.env.CACHE_MAX_SIZE || '10000')
  },

  // API响应状态码
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500
  },

  // API错误码
  ERROR_CODES: {
    INVALID_USER_KEY: 'INVALID_USER_KEY',
    USER_KEY_NOT_FOUND: 'USER_KEY_NOT_FOUND',
    INVALID_API_KEY: 'INVALID_API_KEY',
    INVALID_FINGERPRINT_FORMAT: 'INVALID_FINGERPRINT_FORMAT',
    BATCH_SIZE_EXCEEDED: 'BATCH_SIZE_EXCEEDED',
    SYNC_IN_PROGRESS: 'SYNC_IN_PROGRESS',
    DATABASE_ERROR: 'DATABASE_ERROR',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    FINGERPRINT_LIMIT_EXCEEDED: 'FINGERPRINT_LIMIT_EXCEEDED'
  },

  // 指纹格式验证（统一 64 位十六进制 SHA256）
  FINGERPRINT_REGEX: /^[a-f0-9]{64}$/i,

  // userKey格式验证 (UUID v4)
  USER_KEY_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  // 请求限制配置
  RATE_LIMIT: {
    MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1分钟
    HEADERS: true,
    MESSAGE: '请求过于频繁，请稍后再试'
  },

  // 数据库集合名称
  COLLECTIONS: {
    USER_FINGERPRINTS: 'user_fingerprint_collections',
    USER_META: 'user_collection_metas',
    AUTH_KEYS: 'authorized_user_keys',
    DIFF_SESSIONS: 'diff_sessions'
  },

  // 性能监控配置
  PERFORMANCE: {
    LOG_SLOW_QUERIES: true,
    SLOW_QUERY_THRESHOLD: 1000, // 1秒
    MEMORY_USAGE_WARNING: 100 * 1024 * 1024, // 100MB
    ENABLE_PROFILING: process.env.NODE_ENV === 'development'
  },

  // 同步算法配置
  SYNC_CONFIG: {
    HASH_ALGORITHM: 'sha256',
    DIFF_SESSION_TTL: 300, // 5分钟
    MAX_DIFF_PAGES: 100,
    DEFAULT_PAGE_SIZE: 1000
  },

  // 指纹总量上限（默认）
  LIMITS: {
    DEFAULT_MAX_FINGERPRINTS_PER_USER: parseInt(process.env.DEFAULT_MAX_FINGERPRINTS_PER_USER || '200000')
  }
};