# Phase 03｜商品学习、知识、Hybrid RAG 与 AI Runtime

## 目标

实现真实商品学习、知识导入、索引、RAG、AI Structured Output 与会话上下文。

## 阅读

- docs/08_AI_RUNTIME_CONTEXT_RAG.md
- docs/09_PRODUCT_LEARNING_KNOWLEDGE.md
- specs/structured-output-schemas.json
- seed/knowledge-import-template.csv
- seed/eval-cases.json

## 实现

### 1. Product Sync / Learning

- Product / SKU
- ProductContext
- contentHash
- ProductLearningJob
- AI 结构化抽取
- 高置信源事实 auto enabled
- FAQ / 低置信 candidate

### 2. Knowledge

- STORE / PRODUCT
- MANUAL / HUMAN_REVIEWED / AUTO_LEARNED
- businessStatus / indexStatus
- Version
- activeVersion
- reindex
- soft delete
- candidate / conflict

### 3. Excel / CSV

- xlsx / csv
- 三列
- 校验
- 预览
- 正常 / 重复 / 冲突 / 错误
- 正常项直接启用

### 4. Hybrid RAG

- Metadata Filter
- 应用层 BM25
- pgvector
- fusion / rerank
- Top K 3
- 硬规则后 Top1
- Evidence Snapshot

### 5. AI Runtime

- Provider interface
- purpose routing
- 8s timeout
- retry once
- fallback
- structured output
- schema repair once
- usage
- streaming infrastructure
- abort

### 6. Conversation Memory

- Recent Messages
- Narrative Summary
- Structured Facts
- summaryVersion
- basedOnThroughSequence
- DIRTY rebuild
- Token Budget

### 7. Image

- MinIO upload
- metadata
- Signed URL
- multimodal structured analysis
- 15d lifecycle

## 测试

- product vs store knowledge
- inventory not RAG
- index status
- version atomic switch
- hybrid retrieval
- cross-shop filter
- structured schema
- provider fallback
- image + text same turn
- Context Sanitizer

## Gate

Case 01 / 02 / 03 / 20 / 21 等相关 Eval 通过。

完成后停止。
