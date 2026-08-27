# 状态机设计

## 1. Conversation

```text
ACTIVE
├── AUTO
├── ASSIST
├── MANUAL
└── HOLD

ACTIVE
→ 30 分钟空闲
→ CLOSING
→ 等待未完成操作收敛
→ CLOSED
```

异常辅助状态：

```text
syncState:
CONNECTED
RECONNECTING
RECONCILING
DEGRADED
DISCONNECTED
```

规则：

- DEGRADED 禁止 AUTO
- MANUAL 只有人工显式恢复
- 新 Conversation 重新评估模式
- ACTIVE ONGOING_CASE 可使新会话保守处理

---

## 2. Message

```text
ACTIVE
→ EDITED
→ RECALLED
→ DELETED
```

编辑使用 MessageVersion。

撤回 / 编辑：

- contextVersion + 1
- Summary DIRTY
- ReplyJob / Workflow / Pending ActionProposal 重新校验
- ACTIVE 之外的消息不进入未来模型上下文

---

## 3. TurnBuffer

```text
BUFFERING
→ FLUSHING
→ FLUSHED
```

异常：

```text
CANCELLED
RECOVERY_PENDING
```

字段：

- generation
- idleDeadline
- hardDeadline

旧 delayed job generation 不匹配时无操作退出。

---

## 4. UserTurn

```text
OPEN
→ PLANNED
→ RESOLVED
```

辅助状态：

```text
SUPERSEDED
CANCELLED
FAILED
```

所有 UserTurn 永久保存，但 ReplyJob 只处理当前最新未解决状态。

---

## 5. Task

```text
OPEN
→ RUNNING
→ RESOLVED
```

异常：

```text
AMBIGUOUS
FAILED
SUPERSEDED
CANCELLED
```

TaskBundle 汇总：

```text
ALL_RESOLVED
PARTIAL_RESOLVED
NEEDS_CLARIFICATION
HIGH_RISK
FAILED
```

---

## 6. ReplyJob

```text
PENDING
→ GENERATING
→ WAITING_HUMAN
→ SENT
```

可替代路径：

```text
PENDING
→ FAST_PATH_READY
→ SENT
```

异常：

```text
CANCELLING
STALE
EXPIRED
CANCELLED
FAILED
RECOVERY_PENDING
```

触发 STALE：

- NEW_MESSAGE
- HUMAN_ACTIVE
- CONTEXT_CHANGED
- MESSAGE_RECALLED
- LATE_MESSAGE
- AI_MODE_DOWNGRADED
- NEEDS_REPLAN

知识后台变化不触发当前 ReplyJob STALE；Job 固定当时 Evidence Snapshot。

ASSIST Draft：

- 上下文变化立即 STALE
- 5 分钟后 EXPIRED
- 不自动发送

---

## 7. Conversation Coalescing

```text
Conversation.activeReplyJobId = one
Conversation.needsReplan = false
```

新 UserTurn 到来：

```text
contextVersion + 1
active ReplyJob → STALE
needsReplan = true
```

旧 Job 释放后：

```text
if needsReplan:
  基于 Open Tasks / Structured Facts
  创建一个新 ReplyJob
```

---

## 8. SendOutbox

```text
PENDING
→ SENDING
→ SENT
```

异常：

```text
FAILED
UNCERTAIN
CANCELLED
```

规则：

- SENDING 时服务崩溃 → UNCERTAIN
- UNCERTAIN 不自动重发
- 幂等键重复 → 返回已有结果
- 只有明确 Receipt 才能宣称动作成功

---

## 9. ProcessingOutbox

```text
PENDING
→ DISPATCHING
→ DISPATCHED
```

异常：

```text
FAILED
```

至少一次投递；消费者幂等。

---

## 10. Knowledge

业务状态：

```text
DRAFT
→ ENABLED
→ DISABLED
→ OUTDATED
→ DELETED
```

索引状态：

```text
PENDING
→ INDEXING
→ READY
```

异常：

```text
FAILED
```

新版本 READY 前旧 activeVersion 继续服务。

---

## 11. KnowledgeCandidate

```text
PENDING
→ APPROVED
→ PUBLISHED
```

其他：

```text
REJECTED
DUPLICATE
CONFLICTED
```

---

## 12. Workflow

定义状态：

```text
DRAFT
→ PUBLISHED
→ DISABLED
```

运行状态：

```text
RUNNING
→ WAITING_APPROVAL
→ SUCCEEDED
```

异常：

```text
FAILED
STALE
CANCELLED
RECOVERING
```

运行实例固定 WorkflowVersion。

---

## 13. ActionProposal

```text
PROPOSED
→ POLICY_CHECKED
→ WAITING_APPROVAL
→ APPROVED
→ REVALIDATING
→ EXECUTING
→ SUCCEEDED
```

异常：

```text
REJECTED
STALE
FAILED
UNCERTAIN
CANCELLED
```

执行前重新检查 Context。

---

## 14. ScheduledMessageJob

```text
SCHEDULED
→ REVALIDATING
→ SENDING
→ SENT
```

异常：

```text
CANCELLED_STALE
FAILED
UNCERTAIN
```

欢迎语每 Conversation 最多一次。

---

## 15. ProductLearningJob

```text
PENDING
→ RUNNING
→ SUCCEEDED
```

批量结果：

```text
PARTIAL_SUCCESS
FAILED
CANCELLED
```

单商品状态：

```text
PENDING
PROCESSING
SUCCEEDED
FAILED
OUTDATED
```

---

## 16. QualityReview

人工触发：

```text
PENDING
→ RUNNING
→ AUTO_REVIEWED
→ PASS / FAIL / NEEDS_HUMAN
```

人工可覆盖为最终结果。

---

## 17. ReplyIncident

```text
OPEN
→ CORRECTION_DRAFTED
→ CORRECTED
→ ROOT_CAUSE_FIXED
→ REGRESSION_ADDED
→ RESOLVED
```

---

## 18. Recovery 映射

启动扫描：

| 实体 | 中断状态 | 恢复 |
|---|---|---|
| ReplyJob | GENERATING | RECOVERY_PENDING；上下文有效则重生成，否则 STALE |
| SendOutbox | SENDING | UNCERTAIN |
| WorkflowRun | RUNNING | RECOVERING；继续或 STALE |
| ActionProposal | WAITING_APPROVAL | 保留，批准时重校验 |
| TurnBuffer | BUFFERING | 恢复 delayed job 或立即 flush |
| ScheduledMessageJob | SCHEDULED | 恢复剩余延迟 |
| ProcessingOutbox | PENDING / FAILED | 重新 Dispatch |
