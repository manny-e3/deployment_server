const { Router } = require('express');
const health = require('../controllers/health.controller');

const router = Router();

router.get('/', health.show);

module.exports = router;
