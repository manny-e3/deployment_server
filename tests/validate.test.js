require('./setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const errorHandler = require('../middlewares/errorHandler');
const { idParams, paginationQuery } = require('../utils/schemas');

const app = express();
app.use(express.json());
app.post(
  '/items/:id',
  validate({
    params: idParams,
    query: paginationQuery,
    body: z.object({ name: z.string().min(1) }),
  }),
  (req, res) => res.json({ params: req.params, query: req.query, body: req.body }),
);
app.use(errorHandler);

describe('validate middleware', () => {
  it('lists every bad field across params, query and body', async () => {
    const res = await request(app).post('/items/not-a-cuid?limit=500').send({}).expect(400);

    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    const fields = res.body.error.details.fields.map((f) => f.field);
    assert.deepEqual(fields, ['params.id', 'query.limit', 'body.name']);
  });

  it('passes parsed values, with coercion and defaults, to the handler', async () => {
    const res = await request(app)
      .post('/items/ckx9z0q8h0000abcd?limit=10')
      .send({ name: 'shop' })
      .expect(200);

    assert.deepEqual(res.body, {
      params: { id: 'ckx9z0q8h0000abcd' },
      query: { limit: 10 },
      body: { name: 'shop' },
    });
  });

  it('applies the default page size when limit is missing', async () => {
    const res = await request(app).post('/items/ckx9z0q8h0000abcd').send({ name: 'shop' });
    assert.deepEqual(res.body.query, { limit: 25 });
  });
});
