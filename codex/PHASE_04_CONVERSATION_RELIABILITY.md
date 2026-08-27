# Phase 04｜Context Resolver、人机协同、SendGuard 与可靠性

## 目标

完成客服核心运行时和恢复。

## 阅读

- docs/06_STATE_MACHINES.md
- docs/07_MESSAGE_PIPELINE_CONCURRENCY.md
- docs/08_AI_RUNTIME_CONTEXT_RAG.md
- docs/13_TEST_ACCEPTANCE.md

## 实现

### 1. Intent / TaskBundle

- 最多 4 Task
- READ parallel
- Partial Result
- Blocking Failure
- Task lifecycle
- Task Coalescing

### 2. Context Resolver

- product / sku / order
- card priority
- RESOLVED / AMBIGUOUS / NOT_FOUND / STALE
- 2 clarification rounds
- ClarificationBundle

### 3. Reply Policy

- AUTO / ASSIST / MANUAL
- ShopAIMode ceiling
- Conversation override
- DEGRADED
- humanActive

### 4. Reply Strategy

- Fast Path
- LLM Composer
- single Reply
- forbidden term check

### 5. ASSIST / MANUAL

- stream preview
- Draft TTL 5min
- AI Draft + Human Final
- edit type
- takeover
- explicit resume
- manual CustomerMemory CRUD
- KnowledgeCandidate from human correction

### 6. SendGuard

- message
- sequence
- contextVersion
- humanActive
- idempotency

### 7. SendOutbox

- statuses
- receipt
- uncertain
- duplicate prevention

### 8. Recovery

- ReplyJob
- SendOutbox
- TurnBuffer
- Scheduled welcome / closing
- ProcessingOutbox
- order / inventory scenario events

## 测试

- new message stale
- inventory / order state stale
- human takeover
- draft expire
- duplicate send
- service restart
- uncertain
- coalescing
- clarification
- multi-intent partial result

## Gate

Case 04～10 全通过。

完成后停止。
