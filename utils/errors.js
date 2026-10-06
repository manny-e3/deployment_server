// Errors services throw on purpose. The error handler turns them into the standard body:
// { "error": { "code": "...", "message": "...", "details": { ... } } }

class AppError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class ValidationError extends AppError {
  constructor(fields) {
    super('VALIDATION_FAILED', 400, 'Some fields are missing or invalid', { fields });
  }
}

class BadRequest extends AppError {
  constructor(code = 'BAD_REQUEST', message = 'The request is not valid') {
    super(code, 400, message);
  }
}

class Unauthorized extends AppError {
  constructor(message = 'You need to log in', code = 'UNAUTHENTICATED') {
    super(code, 401, message);
  }
}

class Forbidden extends AppError {
  constructor(message = 'Your role does not allow this action', code = 'FORBIDDEN') {
    super(code, 403, message);
  }
}

class NotFound extends AppError {
  constructor(entity = 'Resource', code = 'NOT_FOUND') {
    super(code, 404, `${entity} not found`);
  }
}

class Conflict extends AppError {
  constructor(code = 'CONFLICT', message = 'This conflicts with the current state', details) {
    super(code, 409, message, details);
  }
}

class BusinessRuleError extends AppError {
  constructor(code, message, details) {
    super(code, 422, message, details);
  }
}

class TooManyRequests extends AppError {
  constructor(message = 'Too many requests, try again later') {
    super('RATE_LIMITED', 429, message);
  }
}

module.exports = {
  AppError,
  ValidationError,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  BusinessRuleError,
  TooManyRequests,
};
