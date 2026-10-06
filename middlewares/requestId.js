const { randomUUID } = require('node:crypto');

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// Reuses a well-formed incoming X-Request-Id, otherwise makes one, and echoes it back.
module.exports = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
