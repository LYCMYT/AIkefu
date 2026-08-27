# REST、WebSocket 与 Adapter 契约

## 1. 原则

- REST：Commands / Queries
- WebSocket：实时 Events
- PostgreSQL：Source of Truth
- 所有请求必须带 Workspace 身份
- 服务端再次校验 workspace / tenant / shop 所有权

详细草案见：

- `specs/openapi.yaml`
- `specs/websocket-events.json`

---

## 2. REST 模块

### Workspace

```text
POST /api/demo/workspaces
GET  /api/demo/workspaces/current
POST /api/demo/workspaces/current/reset
```

### Bootstrap

```text
GET /api/bootstrap
```

返回：

- workspace
- tenant
- shops
- current settings
- seed status
- feature flags

### Shops

```text
GET   /api/shops
POST  /api/shops
GET   /api/shops/:shopId
PATCH /api/shops/:shopId
PATCH /api/shops/:shopId/ai-mode
GET   /api/shops/:shopId/settings
PUT   /api/shops/:shopId/settings
```

### Products

```text
GET  /api/shops/:shopId/products
POST /api/shops/:shopId/products/sync
POST /api/products/:productId/learn
PATCH /api/products/:productId/mock-state
```

### Knowledge

```text
GET    /api/knowledge
POST   /api/knowledge
PATCH  /api/knowledge/:id
DELETE /api/knowledge/:id
POST   /api/knowledge/:id/reindex

POST /api/knowledge/imports
GET  /api/knowledge/imports/:jobId

GET  /api/knowledge/candidates
POST /api/knowledge/candidates/:id/approve
POST /api/knowledge/candidates/:id/reject

GET  /api/knowledge/conflicts
POST /api/knowledge/conflicts/:id/resolve
```

### Conversations

```text
GET  /api/conversations
GET  /api/conversations/:id
POST /api/conversations/:id/mode
POST /api/conversations/:id/reply/regenerate
POST /api/conversations/:id/messages
POST /api/conversations/:id/takeover
POST /api/conversations/:id/resume-ai
```

### CustomerMemory

```text
GET    /api/buyers/:buyerId/memories
POST   /api/buyers/:buyerId/memories
PATCH  /api/memories/:id
POST   /api/memories/:id/disable
DELETE /api/memories/:id
```

### Buyer Simulator

```text
POST  /api/buyer/messages
PATCH /api/buyer/messages/:messageId
POST  /api/buyer/messages/:messageId/recall
POST  /api/buyer/cards/product
POST  /api/buyer/cards/order
```

### Attachments

```text
POST /api/attachments
GET  /api/attachments/:id/signed-url
DELETE /api/attachments/:id
```

### Workflows

```text
GET  /api/workflows
POST /api/workflows
GET  /api/workflows/:id
PUT  /api/workflows/:id/draft
POST /api/workflows/:id/publish
POST /api/workflows/:id/enable
POST /api/workflows/:id/disable
POST /api/workflows/:id/test-run
GET  /api/workflow-runs
GET  /api/workflow-runs/:id
POST /api/action-proposals/:id/approve
POST /api/action-proposals/:id/reject
```

### Quality / Incident

```text
POST /api/quality/reviews
GET  /api/quality/reviews
GET  /api/quality/reviews/:id

POST /api/replies/:replyId/incidents
GET  /api/incidents
POST /api/incidents/:id/correction
POST /api/incidents/:id/resolve
POST /api/incidents/:id/add-regression
```

### Trace / Usage

```text
GET /api/replies/:replyId/trace
GET /api/conversations/:id/trace
GET /api/usage
```

### Scenario Lab

```text
GET  /api/scenarios
POST /api/scenarios/:scenarioKey/run
POST /api/scenarios/:scenarioKey/reset
```

---

## 3. WebSocket Events

事件最少包含：

```json
{
  "eventId": "evt_x",
  "eventType": "MESSAGE_RECEIVED",
  "workspaceId": "ws_x",
  "entityType": "MESSAGE",
  "entityId": "msg_x",
  "entityVersion": 1,
  "occurredAt": "2026-08-26T12:00:00Z",
  "payload": {}
}
```

事件：

```text
MESSAGE_RECEIVED
MESSAGE_EDITED
MESSAGE_RECALLED
CONVERSATION_UPDATED
TURN_BUFFER_UPDATED
USER_TURN_CREATED
REPLY_JOB_STARTED
REPLY_JOB_STREAM
REPLY_JOB_WAITING_HUMAN
REPLY_JOB_STALE
REPLY_SENT
WORKFLOW_RUN_UPDATED
WORKFLOW_NODE_UPDATED
ACTION_PROPOSAL_UPDATED
PRODUCT_UPDATED
ORDER_UPDATED
KNOWLEDGE_UPDATED
QUALITY_REVIEW_UPDATED
REPLY_INCIDENT_UPDATED
SHOP_CONNECTION_CHANGED
USAGE_UPDATED
SCENARIO_UPDATED
```

---

## 4. WebSocket 重连

```text
disconnect
→ exponential reconnect
→ connected
→ GET /api/bootstrap 或当前页面 snapshot
→ 继续订阅
```

客户端使用 eventId 去重。

---

## 5. MockDouyinAdapter

输入：

- Buyer Simulator Commands
- Scenario Business Events

输出 AdapterEvent：

- message
- edit
- recall
- product changed
- inventory changed
- order changed
- connection changed

所有 AdapterEvent 必须先 Normalize。

---

## 6. Error Envelope

REST 错误统一：

```json
{
  "error": {
    "code": "SEND_CONFLICT",
    "message": "Reply context is stale",
    "requestId": "req_x",
    "details": {}
  }
}
```

不得把 Stack、Token、Prompt 或敏感业务数据返回前端。
