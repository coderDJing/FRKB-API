const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middlewares/errorHandler');
const { HTTP_STATUS } = require('../config/constants');

// 确保错误上报目录存在
const baseLogDir = process.env.LOG_DIR || './logs';
const reportDir = process.env.ERROR_REPORT_DIR || path.join(baseLogDir, 'error-reports');
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir, { recursive: true });
}

class ErrorReportController {
  /**
   * 错误日志上报（纯文本）
   * POST /frkbapi/v1/error-report/upload
   * Content-Type: text/plain
   */
  static upload = asyncHandler(async (req, res) => {
    // 仅允许 Node 客户端（根据 User-Agent 判断）
    const userAgent = (req.headers['user-agent'] || '').toString();
    const isNodeUA = /^node(?:\b|\/|$)/i.test(userAgent);
    if (!isNodeUA) {
      logger.security('非法错误日志上报客户端', {
        ip: req.ip,
        ua: userAgent,
        url: req.originalUrl
      });
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'INVALID_CLIENT',
        message: '仅允许 Node 客户端上报错误日志'
      });
    }

    const textContent = typeof req.body === 'string' ? req.body : '';
    if (!textContent || textContent.trim().length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'INVALID_REPORT_PAYLOAD',
        message: '需要提供纯文本错误日志内容（text/plain）'
      });
    }

    const receivedAt = new Date();
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const safeIso = receivedAt.toISOString().replace(/[:.]/g, '-');
    const filename = `${safeIso}_${id}.log`;
    const filePath = path.join(reportDir, filename);

    // 写入原始文本文件，并在文件头加入少量元数据注释
    try {
      const header = `# error-report id=${id} receivedAt=${receivedAt.toISOString()} ip=${req.ip} ua=${userAgent.replace(/\n|\r/g,' ')}\n`;
      fs.writeFileSync(filePath, header + textContent, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      logger.error('写入错误上报文件失败', { error: err.message, path: filePath });
      return res.status(HTTP_STATUS.INTERNAL_ERROR).json({
        success: false,
        error: 'WRITE_REPORT_FAILED',
        message: '服务器保存错误日志失败'
      });
    }

    // 记录一条安全相关日志（不包含敏感内容）
    logger.warn('收到错误日志上报', {
      id,
      file: path.relative(process.cwd(), filePath),
      size: Buffer.byteLength(textContent, 'utf8')
    });

    return res.status(HTTP_STATUS.CREATED).json({
      success: true,
      id,
      message: '错误日志已保存',
      timestamp: new Date().toISOString()
    });
  });
}

module.exports = ErrorReportController;


