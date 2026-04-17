const express = require('express');
const CuratedArtistSyncController = require('../controllers/curatedArtistSyncController');
const { syncAuth } = require('../middlewares/auth');
const { validateCuratedArtistSync, validateRequestSize } = require('../middlewares/validation');

const router = express.Router();

router.use(validateRequestSize);

// 精选艺人快照同步（轻量全量合并）
router.post('/sync', syncAuth, ...validateCuratedArtistSync(), CuratedArtistSyncController.syncSnapshot);

module.exports = router;
