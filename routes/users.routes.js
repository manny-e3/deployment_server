const { Router } = require('express');
const users = require('../controllers/users.controller');
const authenticate = require('../middlewares/authenticate');
const authorize = require('../middlewares/authorize');
const validate = require('../middlewares/validate');
const { createUserBody, idParams, paginationQuery, updateUserBody } = require('../utils/schemas');

const router = Router();

// Every users route is admin-only.
router.use(authenticate, authorize('users:manage'));

router.get('/', validate({ query: paginationQuery }), users.list);
router.post('/', validate({ body: createUserBody }), users.create);
router.get('/:id', validate({ params: idParams }), users.get);
router.patch('/:id', validate({ params: idParams, body: updateUserBody }), users.update);
router.delete('/:id', validate({ params: idParams }), users.remove);

module.exports = router;
