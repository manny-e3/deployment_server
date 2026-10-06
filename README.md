# Deploy Portal (backend)

Plain Node.js + Express, in JavaScript. Deploys Git branches to servers over SSH, streams the
output live, keeps history and rolls back.

## Folders

| Folder / file  | What goes in it                                                 |
| -------------- | --------------------------------------------------------------- |
| `index.js`     | Starts the API                                                  |
| `worker.js`    | Starts the deploy worker (a second process)                     |
| `routes/`      | URL paths, mounted under `/api/v1`                              |
| `controllers/` | Read the request, call a service, send the response             |
| `services/`    | Business rules                                                  |
| `models/`      | Database access through Prisma                                  |
| `middlewares/` | Request id, logging, validation, error handling                 |
| `utils/`       | Config (`env.js`), logger, errors, Redis, queue, shared schemas |
| `prisma/`      | Database tables (`schema.prisma`), migrations and seed          |
| `logs/`        | `app.log`, written by the logger                                |
| `tests/`       | Tests, run with Node's built-in test runner                     |

A request flows: route → controller → service → model.

## Setup

Needs Node.js 22, Docker Desktop and Git.

1. Copy `.env.example` to `.env`. Fill in `JWT_SECRET` and `ENCRYPTION_KEY`
   (`openssl rand -hex 32` for each) and `SEED_ADMIN_PASSWORD` (at least 12 characters).
2. `docker compose up -d` starts MySQL 8.4 (port 3307), Redis 7 (6379) and a test SSH server (2222).
3. `npm install`
4. `npm run db:migrate`, then `npm run db:seed`
5. `npm run dev` for the API, and `npm run worker:dev` in a second terminal for the worker.

Check it: http://localhost:4000/api/v1/health should answer `"status": "ok"`.

MySQL runs on 3307 so it can sit beside XAMPP's MariaDB on 3306. The portal needs MySQL 8.

## Scripts

| Command              | Does                                       |
| -------------------- | ------------------------------------------ |
| `npm run dev`        | API with auto-restart on file changes      |
| `npm run worker:dev` | Worker with auto-restart                   |
| `npm start`          | API (production)                           |
| `npm run worker`     | Worker (production)                        |
| `npm test`           | Tests against `portal_test` and Redis db 1 |
| `npm run db:migrate` | Create and apply a migration (development) |
| `npm run db:deploy`  | Apply migrations (production)              |
| `npm run db:seed`    | Create the first admin user                |

## Endpoints so far

All under `/api/v1`.

| Method | Path                              | Who       | Notes                                                                          |
| ------ | --------------------------------- | --------- | ------------------------------------------------------------------------------ |
| GET    | `/health`                         | public    | MySQL, Redis and queue status                                                  |
| POST   | `/auth/login`                     | public    | `{ email, password }`; 5 tries per 15 min                                      |
| POST   | `/auth/refresh`                   | cookie    | New token pair; the old refresh token stops working                            |
| POST   | `/auth/logout`                    | cookie    | Revokes the refresh token, clears cookies                                      |
| GET    | `/auth/me`                        | any role  | The logged-in user                                                             |
| PATCH  | `/auth/password`                  | any role  | `{ currentPassword, newPassword }`; logs out others                            |
| GET    | `/users`                          | admin     | `?limit=&cursor=` → `{ items, nextCursor }`                                    |
| POST   | `/users`                          | admin     | `{ name, email, role }` → user + temporary password                            |
| GET    | `/users/:id`                      | admin     |                                                                                |
| PATCH  | `/users/:id`                      | admin     | `{ name?, role?, isActive? }`                                                  |
| DELETE | `/users/:id`                      | admin     | Deactivates (never deletes)                                                    |
| GET    | `/servers`                        | any role  | `?limit=&cursor=`; never includes secrets                                      |
| POST   | `/servers`                        | admin     | `{ name, host, port, username, authType, secret, passphrase? }`                |
| GET    | `/servers/:id`                    | any role  |                                                                                |
| PATCH  | `/servers/:id`                    | admin     | Any field; a new host or port forgets the host key                             |
| DELETE | `/servers/:id`                    | admin     | 409 while targets still use it                                                 |
| POST   | `/servers/:id/test`               | admin     | whoami, git version, free disk, host key fingerprint                           |
| POST   | `/servers/:id/reset-fingerprint`  | admin     | After a real host key change                                                   |
| GET    | `/projects`                       | any role  | With targets and each target's last deploy                                     |
| POST   | `/projects`                       | admin     | `{ name, repoUrl, defaultBranch?, autoDeploy? }` → + `webhookSecret` (once)    |
| GET    | `/projects/:id`                   | any role  | With targets, their commands and last deploy                                   |
| PATCH  | `/projects/:id`                   | admin     |                                                                                |
| DELETE | `/projects/:id`                   | admin     | Also deletes targets and history; 409 while a deploy runs                      |
| POST   | `/projects/:id/webhook-secret`    | admin     | New secret, returned once                                                      |
| POST   | `/projects/:id/targets`           | admin     | `{ name, serverId, path, branch?, preDeploy?, postDeploy?, healthCheckUrl? }`  |
| PATCH  | `/projects/:id/targets/:targetId` | admin     |                                                                                |
| DELETE | `/projects/:id/targets/:targetId` | admin     | 409 while a deploy runs                                                        |
| GET    | `/targets/:id/env`                | admin     | `{ keys: [...] }`, never values                                                |
| PUT    | `/targets/:id/env`                | admin     | `{ vars: { KEY: "value" } }` replaces the whole set                            |
| POST   | `/projects/:id/deploy`            | deployer  | `{ targetIds?, branch? }` → 202 `{ started, skipped }`; omit targetIds for all |
| GET    | `/deployments`                    | any role  | Filters: `projectId, targetId, status, trigger, from, to`                      |
| GET    | `/deployments/:id`                | any role  | Without logs                                                                   |
| GET    | `/deployments/:id/logs`           | any role  | `?afterSeq=&limit=` → `{ lines, lastSeq, finished }`                           |
| POST   | `/deployments/:id/cancel`         | deployer  | Queued: cancelled at once. Running: `CANCELLING`, stopped within ~1 s          |
| POST   | `/deployments/:id/rollback`       | deployer  | New deploy of that deploy's exact commit                                       |
| GET    | `/audit-logs`                     | admin     | Filters: `userId, action (e.g. deploy.*), entity, entityId, from, to`          |
| POST   | `/webhooks/github/:projectId`     | signature | GitHub push webhook (see below)                                                |
| POST   | `/webhooks/gitlab/:projectId`     | token     | GitLab push webhook                                                            |

**Webhooks.** In GitHub, add a webhook with payload URL
`https://<APP_URL host>/api/v1/webhooks/github/<projectId>`, content type `application/json`,
the project's webhook secret, and the "push" event. For GitLab use `/webhooks/gitlab/<projectId>`
with the secret as the token. A push deploys every target whose branch matches, when the
project's `autoDeploy` is on. A resent delivery is recognised and never deploys twice; every
delivery and the reason it was ignored are stored in the `WebhookDelivery` table.

**Limits.** 300 API requests per minute per user, 5 login attempts per 15 minutes per IP and
email, 60 webhook deliveries per minute per project, 1 MB request bodies, and at most
`PROJECT_DEPLOY_CONCURRENCY` (default 3) deploys running at once per project.

**Log retention.** The worker deletes deploy log lines older than `LOG_RETENTION_DAYS`
(default 90) every night at 03:00 UTC. Deployment records and the audit log are kept forever.

**Deploys** run in the worker (`npm run worker`), never in the API. At most one deploy runs per
target; a second request for a busy target is listed under `skipped`. Deploys stop after
`DEPLOY_TIMEOUT_MIN` minutes. If the worker dies, it marks whatever was running as `FAILED`
(`WORKER_RESTARTED`) when it starts again. Run only one worker process for now.

**Live logs** come over Socket.IO on the same port, using the login cookie. Emit
`deployment:join { id }` (or `project:join { id }`), then listen for `deployment:logs`,
`deployment:status` and `project:status`. Every line has a `seq`: load the history with
`GET /deployments/:id/logs` first, ignore lines you already have, and after a reconnect fetch
`?afterSeq=<last seq>` to fill the gap.

`npm run db:seed:scale` adds data at v1 scale (100 projects, 50 servers, 200 targets, 10,000
deploys, all named "Scale test …") to try the project list with realistic volumes.

**Secrets** (SSH keys and passwords) are encrypted with AES-256-GCM using `ENCRYPTION_KEY`
before they are stored, and are never returned by the API. Back up `ENCRYPTION_KEY`: without it
every saved secret is lost.

**Host keys:** the first successful test connection saves the server's host key fingerprint.
After that, a server showing a different key is refused (`409 HOST_KEY_CHANGED`) until an admin
resets the fingerprint.

**Sessions** live in cookies: `access_token` (15 min) and `refresh_token` (7 days) are
httpOnly; `csrf_token` is readable. Every POST, PATCH, PUT and DELETE except login must send
the `csrf_token` value back in an `X-CSRF-Token` header. When a request gets 401, call
`/auth/refresh` and retry.

**Roles** are set in `utils/permissions.js`.

## API conventions

- Errors always look like `{ "error": { "code": "…", "message": "…", "details": { … } } }`.
- Every response carries `X-Request-Id`; send your own to trace a request through the logs.
- Secrets are never logged or returned.

## Production

One Linux server (2 vCPU, 4 GB RAM is plenty for v1) with Node.js 22, MySQL 8.4, Redis 7,
Nginx and PM2 (`npm install -g pm2`). Run everything as a non-root user.

1. Create a MySQL user with rights only on the `portal` database. Run MySQL in UTC.
2. Copy `.env.example` to `.env` with production values and `NODE_ENV=production`, then
   `chmod 600 .env`. Store `ENCRYPTION_KEY` in your password manager as well.
3. Install and start:

   ```
   npm ci --omit=dev
   npm run release        # applies migrations, then starts or reloads both PM2 processes
   pm2 save && pm2 startup
   pm2 install pm2-logrotate
   ```

4. Nginx in front, with HTTPS. Socket.IO needs the WebSocket upgrade headers:

   ```nginx
   location /api/ {
       proxy_pass http://127.0.0.1:4000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   location /socket.io/ {
       proxy_pass http://127.0.0.1:4000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
   }
   ```

5. Back up nightly: `mysqldump --single-transaction --routines portal`, kept off the server.
6. Point an uptime monitor at `https://<host>/api/v1/health`.

To update: `git pull && npm ci --omit=dev && npm run release`. A deploy running in the worker
during a reload is marked `FAILED` (`WORKER_RESTARTED`); reload when nothing is deploying.
