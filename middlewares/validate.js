const { ValidationError } = require('../utils/errors');

/**
 * Checks params, query and body against Zod schemas: validate({ params, query, body }).
 * On success the parsed values (with defaults and coercion applied) replace the raw ones;
 * on failure every bad field is listed in error.details.fields.
 */
const validate = (schemas) => (req, _res, next) => {
  const fields = [];

  for (const location of ['params', 'query', 'body']) {
    const schema = schemas[location];
    if (!schema) continue;
    const result = schema.safeParse(req[location]);
    if (result.success) {
      // Express 5 exposes req.query as a getter, so shadow it on the request itself.
      Object.defineProperty(req, location, {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      for (const issue of result.error.issues) {
        fields.push({ field: [location, ...issue.path].join('.'), message: issue.message });
      }
    }
  }

  next(fields.length ? new ValidationError(fields) : undefined);
};

module.exports = validate;
