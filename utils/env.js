const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

// Values already set in the real environment win over the .env file.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const hex64 = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (openssl rand -hex 32)');
const duration = z.string().regex(/^\d+[smhd]$/, 'must look like 30s, 15m, 12h or 7d');
const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // API
  PORT: positiveInt.default(4000),
  APP_URL: z.url(),
  JWT_SECRET: hex64,
  ACCESS_TOKEN_TTL: duration.default('15m'),
  REFRESH_TOKEN_TTL: duration.default('7d'),

  // API and worker
  DATABASE_URL: z.string().regex(/^mysql:\/\//, 'must be a mysql:// URL'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL'),
  ENCRYPTION_KEY: hex64,
  SSH_READY_TIMEOUT_MS: positiveInt.default(20000),
  SENTRY_DSN: z.url().optional(),

  // Worker
  WORKER_CONCURRENCY: positiveInt.default(5),
  DEPLOY_TIMEOUT_MIN: positiveInt.default(30),
  // How many targets of one project deploy at once ("Deploy to all" rolls out in waves).
  PROJECT_DEPLOY_CONCURRENCY: positiveInt.default(3),
  LOG_RETENTION_DAYS: positiveInt.default(90),
});

/** Checks env vars, treating empty strings as unset. Throws one message listing every bad key. */
function parseEnv(source) {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

function load() {
  try {
    return parseEnv(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { env: load(), parseEnv };
