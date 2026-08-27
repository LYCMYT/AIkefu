# 术语表

## Workspace

每个匿名访问者独立的 Demo Sandbox。

## Tenant

SaaS 企业租户。V1 每 Workspace 一个 Tenant。

## Shop

一个电商店铺。

## MockDouyinAdapter

模拟抖音平台的 Adapter，不接真实 API。

## Conversation

一次客服会话。平台 ID 优先，否则 30 分钟空闲切分。

## Message

原始消息事件。

## UserTurn

由 2 秒 / 5 秒规则聚合的一轮消费者输入。

## TurnBuffer

持久化的消息聚合状态。

## Reorder Buffer

处理网络乱序和迟到消息。

## TaskBundle

一轮 UserTurn 拆出的多个业务任务。

## Context Resolver

解析“这个商品”“那个订单”等业务对象。

## FactContext

业务层整理的可信事实集合。

## ProductContext

价格、SKU、库存、上下架等实时商品事实。

## CustomerContext

订单、物流、售后等当前消费者业务状态。

## ConversationMemory

当前 Conversation 的 Recent Messages、Summary 和 Structured Facts。

## CustomerMemory

人工创建的同店铺长期结构化记忆。

## StoreKnowledge

店铺级知识。

## ProductKnowledge

商品级稳定知识。

## KnowledgeCandidate

等待人工审核的候选知识。

## Knowledge Gate

V1 简化为硬过滤、冲突和无证据判断。

## Hybrid RAG

Metadata Filter + Keyword/BM25 + Vector + Simple Rerank。

## ReplyJob

一次回复规划与生成任务。

## ReplyDraft

AI Draft / Human Final。

## AUTO

AI 可自动发送。

## ASSIST

AI 生成 Draft，人工确认。

## MANUAL

人工接管，AI 不自动发送。

## SendGuard

发送前一致性校验。

## ProcessingOutbox

保证业务落库后最终触发异步处理。

## SendOutbox

保证平台写入幂等、可追踪和未知回执安全。

## ActionProposal

模型 / 工作流提出的业务动作建议。

## WorkflowRun

固定版本的工作流执行实例。

## ReplyIncident

已经发生的错误回复事件。

## Developer Trace

面向开发和面试展示的结构化决策追踪。

## Scenario Lab

异常场景实验室。
