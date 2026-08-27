# Phase 01｜基础工程与 Workspace 隔离

## 目标

建立可运行 Monorepo、基础设施、匿名 Workspace、Seed、REST 与 WebSocket。

## 阅读

- docs/01_PRD_V2_FROZEN.md
- docs/04_SYSTEM_ARCHITECTURE.md
- docs/05_DOMAIN_MODEL_DATABASE.md
- specs/prisma.schema
- seed/seed-data.json

## 实现

### 1. Monorepo

```text
apps/web
apps/api
packages/contracts
packages/core
packages/mock-douyin
```

其余 packages 可先建空目录。

### 2. 基础设施

Docker Compose：

- PostgreSQL
- Redis
- MinIO

### 3. Prisma

先实现 Phase 01 必要表：

- Workspace
- Tenant
- Shop
- ShopSettings
- Buyer
- Product / SKU
- Order
- KnowledgeItem / KnowledgeVersion
- Conversation / Message
- AuditLog

后续 Phase 再补其他表也可，但命名需与草案一致。

### 4. Workspace

- 首次访问创建匿名 Workspace
- 返回 token
- token 只保存 hash
- 24h 无访问过期
- Reset 当前 Workspace
- 所有查询显式过滤 workspaceId

### 5. Seed

导入：

- 2 店
- 4 Buyer
- 10 Product
- Orders
- Knowledge
- Workflows

### 6. REST

实现：

- POST /api/demo/workspaces
- GET /api/demo/workspaces/current
- POST /api/demo/workspaces/current/reset
- GET /api/bootstrap
- GET /api/shops

### 7. WebSocket

建立连接、Workspace 鉴权和心跳。

## 测试

必须：

- Workspace A / B 数据隔离
- Reset A 不影响 B
- 无 token 不能访问
- 伪造 shopId 被拒绝
- Seed 可重复执行且幂等

## 完成输出

- 启动命令
- 测试命令与结果
- 项目树
- Migration 摘要
- 已知问题
- 更新 PROGRESS.md

完成后停止，不进入 Phase 02。
