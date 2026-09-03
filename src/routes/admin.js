const express = require('express');
const { adminAuth } = require('../middlewares/auth');
const migrationController = require('../controllers/migrationController');

const router = express.Router();

/**
 * 管理员路由
 * 所有接口都需要 adminToken 认证
 */

// 迁移状态查看
router.get('/migration/status', adminAuth, migrationController.getMigrationStatus);

// 导出所有数据（Mongo 文档；精选库音频不在 JSON 内）
router.get('/migration/export', adminAuth, migrationController.exportAll);

// 导出单个集合
router.get('/migration/export/:collection', adminAuth, migrationController.exportCollection);

// 导入数据
router.post('/migration/import', adminAuth, migrationController.importData);

// 从源服务器拉取并导入
router.post('/migration/pull', adminAuth, migrationController.pullFromSource);

router.get('/migration/blob/:sha256', adminAuth, migrationController.getBlob);
router.put('/migration/blob/:sha256', adminAuth, migrationController.putBlob);

module.exports = router;
