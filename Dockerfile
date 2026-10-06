# One image for both processes: the API (node index.js) and the worker (node worker.js).
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so code changes don't reinstall them. The schema is needed because
# `npm ci` runs `prisma generate` after installing.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p logs && chown -R node:node /app

USER node
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "index.js"]
