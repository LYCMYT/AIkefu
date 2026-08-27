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

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mock-douyin/package.json ./packages/mock-douyin/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . ./

# The browser bundle has no service credentials and always talks to Nginx on
# its own origin. VITE_* values are compile-time public configuration only.
ENV VITE_API_BASE_URL=/api
ENV VITE_WS_BASE_URL=
ENV VITE_WS_PATH=/ws

RUN pnpm --filter @ai-customer-service/web build

FROM nginx:1.27-alpine AS runtime

# The stock entrypoint otherwise tries to rewrite this unused default file at
# startup, which conflicts with the read-only runtime filesystem in Compose.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
