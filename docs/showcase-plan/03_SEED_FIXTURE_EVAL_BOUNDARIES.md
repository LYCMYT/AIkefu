# 03｜Seed / Fixture / Eval / System Rules Boundaries

## 1. 四类资产必须分离

### Runtime Seed

路径建议：

```text
seed/seed-data.json
```

用于创建真实 Demo Workspace：店铺、买家、商品、SKU、订单、正式知识、记忆、冲突和工作流。

### Showcase Catalog

路径建议：

```text
seed/showcase-scenarios.json
seed/no-answer-topics.json
```

只描述场景操作和预期证据，不直接作为 RAG 文档，不包含模型最终回答全文。

### Scenario Fixture

用于重复、乱序、超时、断线、重启、图片 marker 等故障注入。必须标记 `FIXTURE`，不得参与知识检索或真实质量统计。

### Eval Cases

路径：

```text
seed/eval-cases.json
```

只用于评测预期。Runtime RAG、Prompt Context 和 Showcase Seed 不得读取 expected facts、forbidden claims 或 judge 结果。

### System Rules

存在于 Prompt Registry、Policy、Guard 与权限层，不进入 RAG。

## 2. 禁止的数据泄漏路径

必须增加测试阻止：

```text
Eval expectedFacts → KnowledgeItem
Eval forbiddenClaims → Prompt Runtime Context
Scenario fixture marker → RAG document
Developer Trace internal code → consumer reply
No-answer expected fallback → hidden FAQ
```

## 3. Knowledge Leakage Test

至少实现：

1. Runtime Seed loader 不读取 `eval-cases.json` 的 expected 字段；
2. Knowledge 表中不包含 Eval ID（E001 等）；
3. Knowledge 文本与 Eval expectedFacts 的完全复制需人工白名单说明；
4. no-answer topics 不能在 ENABLED+READY Knowledge 中出现正向答案；
5. Scenario fixture marker `AICS_FIXTURE:*` 不得进入 Embedding/Document；
6. Reply Composer 不接收 Eval assertion。

## 4. 动态事实边界

以下词义应触发知识静态检查或人工复核：

```text
当前库存
还剩 X 件
今天价格
当前售价
已下架 / 当前上架
订单已发货
物流到达
退款已到账
当前可售颜色
```

商品材质、版型、功能和规格可以成为知识；“当前是否可售”必须走 Context。

## 5. Reset 语义

Showcase Reset 必须：

- 只重置 Showcase Workspace；
- 恢复当前 Seed 版本；
- 清除场景产生的会话、消息、ReplyJob、Outbox、Run、Incident 和 Metrics；
- 不修改 Eval 文件；
- 不修改 Operational/Scenario Workspace；
- 不删除对象存储中其他 Workspace 的附件。
