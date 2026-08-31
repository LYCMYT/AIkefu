# AIkefu 公网 Demo 上线检查表

本清单适用于 `v1.0.0-demo` 的 Mock-only 求职展示。它不会把 GitHub Pages 描述为全栈部署，也不会把本地验证冒充公网可用性。需要的最低资源是一台可以运行 Docker Compose 的 Linux 主机、一个域名和 HTTPS 证书。

## 1. 上线前必须决定

- [ ] 选择云主机和区域；建议只开放 `80/443`，SSH 仅允许受信任来源。
- [ ] 准备域名，例如 `demo.example.com`，并将 A/AAAA 记录指向主机。
- [ ] 选择 AI 模式：公开求职 Demo 建议使用离线 provider；若使用 DeepSeek，必须配置费用上限和访问限制。
- [ ] 决定访问策略：至少使用反向代理 Basic Auth、一次性邀请链接或可信 IP 白名单之一。
- [ ] 明确数据保留：本项目只允许合成数据，禁止访客输入真实客户隐私或真实订单。

## 2. 主机与 Secret

- [ ] 安装受支持的 Docker Engine 和 Compose v2。
- [ ] 创建独立的低权限部署账号和受限目录。
- [ ] 从 `.env.production.example` 生成 `.env.production`，替换全部 `CHANGE_ME_*`。
- [ ] 为 PostgreSQL、Redis、MinIO 分别生成 URL-safe 随机密码。
- [ ] 将 `WEB_ORIGIN` 设置为准确的 `https://demo.example.com`。
- [ ] DeepSeek Key 只写入服务器端 `AI_API_KEY_FILE`；不放进 Git、镜像、前端变量、URL 或日志。
- [ ] 如果 Key 曾在聊天、截图或临时文件中暴露，先在服务商后台轮换，再部署新 Key。

## 3. 部署

### 方式 A：服务器从源码构建

```bash
git clone https://github.com/LYCMYT/AIkefu.git
cd AIkefu
git checkout v1.0.0-demo
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build --wait
```

### 方式 B：使用 GitHub Container Registry 镜像

```bash
export AIKEFU_IMAGE_TAG=v1.0.0-demo
docker compose --env-file .env.production \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  pull
docker compose --env-file .env.production \
  -f docker-compose.prod.yml \
  -f docker-compose.ghcr.yml \
  up -d --wait
```

如果 GHCR 包暂时为 private，先使用只含 `read:packages` 的最小权限凭据执行 `docker login ghcr.io`；不要使用个人主密码。

## 4. TLS 与网络

- [ ] 在 Compose Web 容器前配置 Caddy、Traefik、云负载均衡或等价 HTTPS 终止层。
- [ ] 浏览器只访问 HTTPS；HTTP 自动跳转 HTTPS。
- [ ] 不向公网映射 API、PostgreSQL、Redis、MinIO 或 MinIO Console 端口。
- [ ] 验证 `/api` 和 `/ws` 仍为同源反向代理，没有跨域 Secret。
- [ ] 配置请求体、连接数和基础访问频率限制；若无法限制，保持离线 provider。

## 5. 上线验收

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 api web
curl -fsS https://demo.example.com/healthz
```

- [ ] `/showcase` 能创建隔离 Showcase Workspace 并运行四个场景。
- [ ] `/workbench`、`/buyer-simulator`、`/admin`、`/scenario-lab` 均可访问。
- [ ] 浏览器控制台无 error/warning，页面无 404 和全局横向滚动。
- [ ] WebSocket `/ws/` 成功连接，买家消息能实时出现在工作台。
- [ ] AI OFF 后没有新 ReplyJob、Draft、AI SendOutbox 或 Scheduled Message。
- [ ] 外部模型关闭或失败时系统安全降级，不泄露错误正文或 Key。

## 6. 备份、升级与回滚

- [ ] 首次开放前备份 `postgres_data`、`redis_data` 和 `minio_data` 命名卷。
- [ ] 每次升级前记录当前 Git tag 和镜像 digest。
- [ ] 先拉取新镜像，再执行 `up -d --wait`；API 会在监听前运行 migration。
- [ ] 迁移或健康检查失败时停止流量，查看日志，不要反复重启或使用 `down -v`。
- [ ] 回滚应用镜像前确认数据库 migration 是否向后兼容；数据库恢复必须使用已验证备份。

## 7. 求职展示边界

- [ ] 页面和 README 明确写出 MockDouyin、合成数据和可选 DeepSeek。
- [ ] 不展示真实手机号、客户数据、公司 Cookie、Token 或订单。
- [ ] 不宣称真实平台已接入、真实客户使用、生产 SLA、商业收入或未经验证的模型准确率。
- [ ] 公网 URL、视频 URL 和 GitHub tag 指向同一版本。
