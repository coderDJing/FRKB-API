const express = require('express');
const { apiKeyAuth } = require('../middlewares/auth');
const { strictRateLimit, createCustomRateLimit } = require('../middlewares/rateLimit');
const ErrorReportController = require('../controllers/errorReportController');

const router = express.Router();

// 错误日志上报接口
// 要求：无需 userKey；需要 API Key；严格限流更严格（例如 5 次/5 分钟）
const ultraStrictRateLimit = createCustomRateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: '错误日志上报过于频繁，请稍后再试',
  keyPrefix: 'error-report'
});

// 仅接收 text/plain 文本日志，大小可通过 ERROR_REPORT_MAX_SIZE 配置，默认 50MB
const textParser = express.text({ type: 'text/plain', limit: process.env.ERROR_REPORT_MAX_SIZE || '50mb' });
router.post('/upload', ultraStrictRateLimit, apiKeyAuth, textParser, ErrorReportController.upload);

module.exports = router;


