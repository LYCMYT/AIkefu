# AI Runtime、上下文与 Hybrid RAG

## 1. AI Runtime 目标

统一管理：

- Provider
- Model Routing
- Timeout
- Retry
- Fallback
- Structured Output
- Schema Validation
- Repair
- Circuit Breaker
- Streaming
- Abort
- Usage / Cost
- Trace

---

## 2. Purpose-based Model Routing

```text
INTENT_PLANNER
RISK_CLASSIFIER
SUMMARY
KNOWLEDGE_EXTRACT
→ Fast Model

REPLY_GENERATION
→ Quality Model

IMAGE_ANALYSIS
→ Multimodal Model

QUALITY_JUDGE
→ Judge Purpose
```

用户不配置具体模型。

---

## 3. 失败策略

默认：

- timeout：8s
- transient retry：1
- fallback：1
- schema repair：1
- empty output repair：1

仍失败：

| 模式 | 行为 |
|---|---|
| AUTO | 安全兜底 + 人工待处理 |
| ASSIST | 显示失败，人工继续 |
| MANUAL | 不影响人工 |

Provider 连续失败触发简单 Circuit Breaker。

---

## 4. Structured Output

决策型调用必须 JSON Schema：

- IntentPlan
- RiskResult
- ImageAnalysis
- KnowledgeCandidate
- QualityReview
- ActionProposal

解析失败不可猜关键字段。

流程：

```text
Model
→ Parse
→ Schema Validate
→ Repair once
→ Fail Closed
```

---

## 5. Streaming

- 内部可 Stream
- ASSIST 可显示 Draft Preview
- AUTO 用户不可见
- Finalize 后才进入发送
- STALE 时 Abort 或 discard

---

## 6. FactContext

模型不直接接收整个数据库 JSON。

```json
{
  "currentIntent": "LOGISTICS_QUERY",
  "authoritativeFacts": {
    "orderStatus": "SHIPPED",
    "carrier": "SF",
    "logisticsStatus": "IN_TRANSIT"
  },
  "policyFacts": {
    "remoteAreaPolicy": "以实际物流为准"
  },
  "customerFacts": {
    "currentQuestion": "什么时候能到"
  },
  "memoryFacts": [],
  "conflicts": []
}
```

---

## 7. Source of Truth

```text
实时订单 / 库存 / 物流 / 售后
>
当前有效知识
>
用户本轮明确表达
>
人工维护 CustomerMemory
>
Conversation Summary
>
LLM 通用知识
```

LLM 不得创造：

- 库存
- 价格
- 订单状态
- 退款规则
- 物流时效
- 店铺承诺

---

## 8. Context Sanitizer

流程：

```text
Context Resolver
→ FactContext
→ Context Sanitizer
→ AIContextPolicy(purpose)
→ Provider
```

默认不发送：

- 完整手机号
- 完整地址
- Token / Cookie
- 支付信息
- 无关订单
- 完整物流单号

按 purpose 白名单：

- classifyIntent：用户消息 + 少量上下文
- generateReply：UserTurn + relevant facts + evidence + tone
- qualityReview：脱敏会话 + evidence + rules
- knowledgeExtract：相关问题、人工答案、商品 ID

日志只记录 includedDataClasses / excludedPII，不保存完整 Prompt。

---

## 9. Context Builder 与 Token Budget

优先级：

```text
P0 当前 UserTurn / Task / System Rules
P1 实时业务事实 / Resolver 结果 / 高风险规则
P2 当前 Task 相关 Evidence
P3 Recent Messages
P4 Structured Facts / Open Questions
P5 Narrative Summary
P6 CustomerMemory
```

超预算从低优先级裁剪。

RAG Top K 默认 3。

---

## 10. Conversation Summary

### Narrative

自然语言概括。

### Structured Facts

- activeProductId
- activeSku
- activeOrderId
- resolvedFacts
- openQuestions
- deprecatedFacts

重要事实带 sourceMessageId。

摘要保存：

- summaryVersion
- basedOnThroughSequence

消息撤回影响摘要：

```text
DIRTY
→ rebuild
```

实时订单状态永远不从摘要读取。

---

## 11. Context Resolver

输入：

- UserTurn
- Recent Messages
- activeTopic
- cards
- products
- orders

输出：

```text
RESOLVED
AMBIGUOUS
NOT_FOUND
STALE
```

多候选进入 ClarificationRequest。

低 / 中风险最多 2 轮。

---

## 12. TaskBundle

Intent Planner 最多 4 Task。

示例：

```json
{
  "tasks": [
    {
      "intent": "INVENTORY_QUERY",
      "riskLevel": "LOW",
      "requiredContext": ["PRODUCT", "SKU"],
      "requiredTools": ["GET_INVENTORY"]
    },
    {
      "intent": "LOGISTICS_QUERY",
      "riskLevel": "LOW",
      "requiredContext": ["ORDER", "LOGISTICS"],
      "requiredTools": ["GET_LOGISTICS"]
    }
  ]
}
```

同一 Task 只允许一个 Workflow Owner。

---

## 13. Hybrid RAG

流程：

```text
Metadata Filter
→ Keyword / BM25
+
Vector
→ Fusion
→ Simple Rerank
→ Top1 / TopK Evidence
```

Metadata：

- workspaceId
- tenantId
- shopId
- productId?
- businessStatus
- indexStatus
- effectiveTime

### V1 简化

不做 score / margin 置信门禁。

硬规则后：

- 无候选：NO_EVIDENCE
- 显式冲突：CONFLICTED
- 合法候选：取 Top1
- 过期：排除

### Keyword / BM25

V1 数据量小，可在应用层对过滤候选计算 BM25，避免额外搜索服务。

### Vector

pgvector。

### Rerank

简单权重：

- vector
- keyword
- source priority
- scope priority

实际权重做配置，不声称为生产最优。

---

## 14. Reply Policy

输入：

- Task risks
- Context result
- Knowledge result
- ShopAIMode
- Conversation override
- humanActive
- connection state

输出：

```text
AUTO
ASSIST
MANUAL
```

任一 HIGH_RISK / Blocking Failure → 禁止 AUTO。

---

## 15. Reply Strategy

### Fast Path

单一明确事实、低风险。

### LLM Composer

多 Task、复杂上下文、品牌语气、售后解释、ASSIST。

最终消费者只收到一条统一 Reply。

---

## 16. Prompt Injection

所有以下内容为 Untrusted：

- 用户消息
- 图片 OCR / 视觉文本
- 商品详情
- 上传文件
- RAG 文档

模型只生成建议。

Action 执行始终经过：

```text
ActionProposal
→ Tool Allowlist
→ Action Policy
→ Permission
→ Context Revalidation
→ Human Approval
```

用户要求泄露 Prompt 或直接退款时：

- 不泄露 System
- 不获取工具权限
- 提取真实业务意图
- 高风险进入 MANUAL / Approval

---

## 17. AI 调用日志

记录：

- purpose
- provider
- model
- promptVersion
- ragStrategy
- fallbackUsed
- contextVersion
- evidenceIds
- duration
- tokenUsage
- status

V1 不做完整 AIConfigVersion 发布体系。
