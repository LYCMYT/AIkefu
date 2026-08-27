# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

FROM base AS dependencies

# Copy manifests first so dependency installation remains cacheable when only
# application source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mock-douyin/package.json ./packages/mock-douyin/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . ./

# Generate the Prisma client from the checked-in schema, then let the API
# prebuild hook compile its workspace dependencies before compiling NestJS.
RUN pnpm --filter @ai-customer-service/api prisma:generate \
 && pnpm --filter @ai-customer-service/api build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV API_PORT=3000

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The Prisma CLI is deliberately retained because the container applies the
# checked-in migrations before accepting traffic. No .env file is copied.
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api ./apps/api
COPY --from=build --chown=node:node /app/packages/contracts ./packages/contracts
COPY --from=build --chown=node:node /app/packages/core ./packages/core
COPY --from=build --chown=node:node /app/packages/mock-douyin ./packages/mock-douyin
COPY --from=build --chown=node:node /app/seed ./seed

WORKDIR /app/apps/api
USER node

EXPOSE 3000

# A failed migration exits the container; Compose will not mark the API ready.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
