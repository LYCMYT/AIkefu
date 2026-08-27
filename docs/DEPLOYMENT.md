# 单机部署（Mock-only Demo）

`docker-compose.prod.yml` 是这个仓库的单机、生产风格部署入口。它运行的是合成数据和 `MockDouyinAdapter`，不接入真实电商平台、私有接口、Cookie、Token 或平台账号。

它并不宣称生产 SLA、安全认证或大规模并发能力。公开 Demo 也没有 Workspace 级 Rate Limit、Quota 或超额 Fallback；如果配置外部 AI gateway，操作者必须自行承担并控制调用费用。

## 架构与边界

```text
browser -- HTTP(S) --> web (Nginx :80) -- /api, /ws --> api
                                          |
                                       backend (internal)
                              PostgreSQL/pgvector, Redis, MinIO
```

只有 `web` 映射宿主机端口（默认 `8080`）。API、PostgreSQL/pgvector、Redis、MinIO 及 MinIO Console 都没有 host port；它们只在 `backend` 内部网络可达。浏览器 bundle 固定使用同源 `/api` 和 `/ws`，没有 `VITE_*` Secret。

API 在开始监听前执行 `prisma migrate deploy`。若迁移失败，API 容器退出，Nginx 不会被 Compose 标记为可用。API 的健康检查验证已监听端口（Prisma 连接在监听前建立）；Nginx、PostgreSQL、Redis 和 MinIO 也都有健康检查。

## 首次部署

前提：Docker Engine / Docker Compose v2，以及可用的镜像拉取网络。建议把部署目录放在受限的磁盘和账号下。

PowerShell：

```powershell
Copy-Item .env.production.example .env.production
# 编辑 .env.production，替换所有 CHANGE_ME_* 值；不要提交该文件。
docker compose --env-file .env.production -f docker-compose.prod.yml config
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build --wait
```

首次构建会安装锁定的 pnpm 依赖、生成 Prisma Client，并构建 React 静态文件。浏览器访问 `http://localhost:8080`；若设置了其他 `WEB_PORT`，使用对应地址。`WEB_ORIGIN` 必须与浏览器实际访问的 scheme、host 和 port 完全一致，例如 `https://demo.example.com`。

生产站点应在 Nginx 前终止 TLS（或把 host 端口限制为受信任网络），并将 `WEB_ORIGIN` 改为 HTTPS 公共地址。不要把默认 HTTP 端口直接暴露到不受信任的公网。

连接字符串中的 `POSTGRES_PASSWORD`、`REDIS_PASSWORD` 和 `MINIO_ROOT_PASSWORD` 应使用 URL-safe/base64url 随机值（字母、数字、`-`、`_`）；避免未转义的 `@`、`:`、`/`、`?` 或 `#`。可为每个值单独生成一个：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## 验证与日常操作

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 api web
Invoke-WebRequest http://localhost:8080/healthz
```

在浏览器中验证四个入口：`/workbench`、`/buyer-simulator`、`/admin` 与 `/scenario-lab`。可用开发者工具确认 REST 请求走 `/api/...`，Socket.IO 走 `/ws/`；不要通过真实平台发送或真实电商凭据验证该 Demo。

停止服务但保留数据：

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

`postgres_data`、`redis_data` 和 `minio_data` 是命名持久卷。升级前先备份这些卷；不要用 `down -v`，除非明确要永久销毁合成 Demo 数据。数据删除后通常不可恢复。

## Secrets 与外部 AI

`.env.production` 仅供该主机的 Compose 使用，且被 `.gitignore` 忽略。数据库密码、Redis 密码、MinIO 密钥与可选 `AI_API_KEY` 只通过容器环境变量传给 API；它们不会传入 Web Docker build、前端 bundle、URL、WebSocket payload 或普通日志。

保持 `AI_BASE_URL` 与 `AI_API_KEY` 为空即可使用离线确定性 provider。若显式配置兼容的 AI gateway，只在服务端设置这些变量，审查其数据处理条款，并保持 `AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN=false`，除非已明确批准把原始图片发送到该外部运行时。

API 启动会校验环境变量并启用严格 Body DTO、`JSON_BODY_LIMIT`（默认 `1mb`）与 Helmet。对象存储使用 AWS SDK v3，`ATTACHMENT_STORAGE_TIMEOUT_MS`（默认 `8000`）是 PUT/DELETE/CreateBucket 的硬截止时间。配置错误会阻止 API 监听，而不是带着隐式默认值继续运行。

不要把真实电商 API key、Cookie、Token、平台账号或客户生产数据放入任何环境文件、Compose 文件或镜像中。

## 扩展限制

默认只有一个 API 副本。API 同时承载其 V1 worker；在没有为 WebSocket 粘性会话、worker 拆分、锁与容量策略做专项验证前，不要通过 `--scale api` 扩容。这个部署文件提供可复验的单机 Demo，不替代上线前的备份演练、TLS、监控告警、漏洞管理和容量测试。

当前 Web 尚未消费附件 signed URL；MinIO 也只暴露在 Compose 内部网络。未来若开放浏览器附件读取，应增加受控的公共对象入口或同源代理，并保证签名时的 Host/路径与浏览器实际访问地址一致。不要直接暴露 MinIO Console 或 root 凭据。
