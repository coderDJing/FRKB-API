const express = require('express');
const CuratedLibraryController = require('../controllers/curatedLibraryController');
const { syncAuth, queryAuth } = require('../middlewares/auth');
const { strictRateLimit } = require('../middlewares/rateLimit');
const { validateRequestSize } = require('../middlewares/validation');

const router = express.Router();

router.use((req, res, next) => {
  const pathName = String(req.path || '');
  if (pathName.startsWith('/blob') || pathName.startsWith('/events')) return next();
  return validateRequestSize(req, res, next);
});

router.post('/status', syncAuth, CuratedLibraryController.status);
router.post('/begin-first-snapshot', syncAuth, CuratedLibraryController.beginFirstSnapshot);
router.post('/commit-snapshot', syncAuth, CuratedLibraryController.commitSnapshot);
router.post('/pull', syncAuth, CuratedLibraryController.pull);
router.post('/push', syncAuth, CuratedLibraryController.push);
router.post('/blob/begin', syncAuth, CuratedLibraryController.beginBlob);
router.put('/blob/:sha256', queryAuth, CuratedLibraryController.uploadBlob);
router.get('/blob/:sha256', queryAuth, CuratedLibraryController.downloadBlob);
router.get('/events', queryAuth, CuratedLibraryController.events);
router.post('/reset', strictRateLimit, syncAuth, CuratedLibraryController.reset);

module.exports = router;
