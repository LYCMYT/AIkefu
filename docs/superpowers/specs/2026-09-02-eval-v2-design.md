# AIkefu 可执行评测 V2 设计

日期：2026-09-02

状态：已确认设计，待实施
输入数据：`RETRIEVAL_40_QUERIES.csv`、`TESTSET_72_CASES.csv`

## 1. 背景与目标

项目已有 36 条固定回复评测和 10 条 AUTO 评测，但用户提供的两份新数据目前只是表格：40 条检索查询用于验证知识召回，72 条产品案例覆盖知识、上下文、任务、安全和可靠性。直接把 CSV 文本塞入现有执行器会产生三类问题：中文别名无法稳定解析，多轮与故障场景不可执行，以及不支持的案例容易被错误计为通过。

本设计新增独立的 Eval V2 数据层、转换器、检索执行器和报告，不替换现有 36 + 10 基线。目标是：

1. 让 40 条检索查询全部可以确定性执行和评分。
2. 让 72 条产品案例逐条进入执行清单；能执行的真实运行，暂不支持的明确报告 `BLOCKED_UNSUPPORTED`。
3. 对 Workspace、店铺、商品、订单、Evidence、动态事实和外发状态进行可证明的隔离与追踪。
4. 同时支持离线确定性 Gate 与真实 PostgreSQL/pgvector/Redis/MinIO Gate。
5. 保留原 CSV 作为不可变来源，使转换结果可审计、可复现。

## 2. 非目标

- 不删除或改写 `seed/eval-cases.json` 的 36 条案例。
- 不删除或改写 `seed/auto-eval-cases.json` 的 10 条案例。
- 不用模型自动猜测 CSV 中的别名、任务或上下文。
- 不以文本相似度代替 Workspace、店铺、商品和知识版本的结构化校验。
- 不把跳过、环境缺失、执行器缺能力或 Provider 失败计为 PASS。
- 不为通过评测而降低现有安全策略、Evidence 门槛或发送守卫。

## 3. 来源与仓库布局

实施后新增以下文件：

```text
evals/
  source/
    retrieval-40.v1.csv
    product-testset-72.v1.csv
  canonical/
    retrieval-40.v2.json
    product-testset-72.v2.json
  mappings/
    eval-v2-aliases.json
    eval-v2-overrides.json
apps/api/src/eval-v2/
  eval-v2.types.ts
  eval-v2.loader.ts
  eval-v2.converter.ts
  retrieval-eval.executor.ts
  product-eval.executor.ts
  eval-v2.reporter.ts
  eval-v2.cli.ts
apps/api/test/
  eval-v2.converter.spec.ts
  retrieval-eval.executor.spec.ts
  product-eval.executor.spec.ts
  eval-v2.reporter.spec.ts
  eval-v2.real-infra.integration-spec.ts
artifacts/eval-v2/                 # 生成物，保持 Git ignore
```

`evals/source` 保存用户提供的原始内容，仅改成稳定文件名，不改列、不改行、不改编码语义。`evals/canonical` 必须由转换器生成并提交，代码审查可直接比较来源和规范化结果。`evals/mappings` 是人工审核过的显式映射；运行时禁止模糊猜测。

转换器输出必须包含来源文件 SHA256、转换器 schema 版本和每条源记录的原始 ID。任一源 ID 重复、列缺失、别名未映射或覆盖项引用不存在的 ID，转换失败且不产生部分 JSON。

## 4. 已确认的数据基线

### 4.1 Retrieval 40

- 40 行、10 列，ID `Q01`–`Q40` 唯一。
- 店铺：MIA 26 条、Pixel 14 条。
- Scope：STORE 11 条、PRODUCT 19 条、NONE 10 条。
- Positive：YES 30 条、NO 10 条。
- `Max_Rank`：3 有 27 条，1 有 3 条，0 有 10 条。
- `Q29/Q30` 是相同问题的跨店隔离对。
- `Q09/Q39` 是同一商品同一问题的基线与 Top1 严格门槛，不去重。
- `Q37` 是冲突知识检测，不按普通 TopK 命中评分。

### 4.2 Product Testset 72

- 72 行、13 列，ID 唯一。
- 九个领域：Store Knowledge 10、Product Knowledge 10、Inventory/SKU 8、Order/Logistics 8、Multi-turn/Context 8、Multi-intent/Task 8、Safety/Escalation 8、RAG Hard Cases 8、Reliability E2E 4。
- 期望模式：AUTO 15、ASSIST 40、MANUAL 17。
- `Hard_Blocker=YES` 32 条，`NO` 40 条。
- `I05/I06` 是同一问法的库存变化双向竞态，不去重。
- `K07/S05` 是同一问法在知识覆盖与安全拒答两个维度的独立验收，不去重。
- `User_Input` 中的 `/` 与 `→`、`Context_Setup` 中的中文描述都必须转换为结构化动作，运行时不解析自由文本控制指令。

## 5. 规范数据模型

### 5.1 公共状态

```ts
type EvalCaseStatus =
  | 'PASS'
  | 'FAIL'
  | 'BLOCKED_UNSUPPORTED'
  | 'BLOCKED_ENVIRONMENT'
  | 'NOT_RUN';

type EvalProviderMode = 'OFFLINE_FIXTURE' | 'REAL_PROVIDER';

type EvalGateSeverity = 'STANDARD' | 'SAFETY_BLOCKER';
```

状态规则：

- `PASS`：该案例全部技术、安全和产品断言均通过。
- `FAIL`：案例已执行，但至少一项断言失败。
- `BLOCKED_UNSUPPORTED`：转换成功，但当前执行器缺少明确列出的能力。
- `BLOCKED_ENVIRONMENT`：真实依赖或 Provider 缺失，且该案例不能在当前模式运行。
- `NOT_RUN`：用户中止、前置转换失败或执行流程在到达该案例前终止。

报告不得将后三种状态并入 passed。最终发布 Gate 要求目标套件 `FAIL=0`、`BLOCKED_UNSUPPORTED=0`、`NOT_RUN=0`；真实基础设施未配置时只允许单独的真实套件报告 `BLOCKED_ENVIRONMENT`，不得用离线结果冒充。

### 5.2 检索案例

```ts
type RetrievalEvalCaseV2 = {
  id: string;
  sourceRow: number;
  shopKey: 'shop_mia_fashion' | 'shop_pixel_tech';
  productKey: string | null;
  query: string;
  expectation:
    | {
        kind: 'POSITIVE';
        expectedKnowledgeKeys: string[];
        expectedScope: 'STORE' | 'PRODUCT';
        maxRank: 1 | 3;
        forbiddenKnowledgeKeys: string[];
        forbiddenShopKeys: string[];
        forbiddenProductKeys: string[];
      }
    | {
        kind: 'NO_EVIDENCE';
        forbiddenKnowledgeKeys: string[];
        forbiddenShopKeys: string[];
        forbiddenProductKeys: string[];
      }
    | {
        kind: 'CONFLICT';
        conflictFixtureKey: 'conflict_001';
        expectedStatus: 'CONFLICTED';
      };
  notes: string[];
};
```

正例通过条件：`KnowledgeService.search` 返回 `EVIDENCE`；至少一个 `expectedKnowledgeKeys` 对应的冻结 `versionId` 出现在前 `maxRank`；所有 Evidence 都满足期望 Workspace、tenant、shop、scope 和 product；禁止集合零命中。

负例通过条件：返回 `NO_EVIDENCE`、`AMBIGUOUS` 或 `DYNAMIC_FACT_REQUIRED` 中该案例声明允许的状态，且 Evidence 数量为 0。不能仅凭答案里没有出现某个词判定通过。

冲突例通过条件：启用指定冲突 fixture 后返回 `CONFLICTED`、Evidence 为空、`conflictItemIds` 非空。任何静默 Top1 都失败。

### 5.3 产品案例

```ts
type EvalMessageV2 =
  | { type: 'TEXT'; text: string; turn: number }
  | { type: 'GOODS_CARD'; productKey: string; turn: number }
  | { type: 'ORDER_CARD'; orderKey: string; turn: number }
  | { type: 'IMAGE'; fixture: string; turn: number }
  | { type: 'EDIT_PREVIOUS'; text: string; turn: number }
  | { type: 'RECALL_PREVIOUS'; turn: number };

type EvalSetupActionV2 =
  | { type: 'SET_SHOP_AI_MODE'; mode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY' }
  | { type: 'SELECT_PRODUCT'; productKey: string }
  | { type: 'SELECT_ORDER'; orderKey: string }
  | { type: 'SET_HUMAN_ACTIVE'; value: boolean }
  | { type: 'ACTIVATE_CONFLICT'; fixtureKey: string }
  | { type: 'CHANGE_INVENTORY_DURING_GENERATION'; externalSkuId: string; from: number; to: number }
  | { type: 'CHANGE_ORDER_DURING_GENERATION'; orderKey: string; toStatus: string }
  | { type: 'CHANGE_LOGISTICS_DURING_GENERATION'; orderKey: string; toNode: string }
  | { type: 'SET_PROVIDER_FAULT'; primary: string; fallback: string }
  | { type: 'RESTART_DURING'; phase: 'GENERATING' | 'SEND_OUTBOX_SENDING' }
  | { type: 'SEND_DUPLICATE_TRANSPORT_MESSAGE' }
  | { type: 'SEND_OUT_OF_ORDER_TRANSPORT_MESSAGES' };

type ProductEvalCaseV2 = {
  id: string;
  sourceRow: number;
  domain: string;
  shopKey: 'shop_mia_fashion' | 'shop_pixel_tech';
  buyerKey: string;
  messages: EvalMessageV2[];
  setup: EvalSetupActionV2[];
  expected: {
    tasks: string[];
    mode: 'AUTO' | 'ASSIST' | 'MANUAL';
    terminalStatuses: string[];
    outputSources: Array<'SENT_MESSAGE' | 'SEND_OUTBOX' | 'DRAFT' | 'TASK_RESULT' | 'NONE'>;
    evidence: {
      required: boolean;
      scopes: Array<'STORE' | 'PRODUCT'>;
      knowledgeKeys: string[];
      productKeys: string[];
    };
    tools: string[];
    requiredFacts: string[];
    forbiddenClaims: string[];
    maxClarificationQuestions: number | null;
    autoSend: boolean | null;
    oldReplyMustNotBeSent: boolean;
  };
  gateSeverity: EvalGateSeverity;
  execution: {
    kind: 'REPLY_RUNTIME' | 'RELIABILITY_HARNESS';
    requiredCapabilities: string[];
  };
  metricTags: string[];
  notes: string[];
};
```

`Hard_Blocker=YES` 映射为 `SAFETY_BLOCKER`，表示失败原因必须在摘要单独列出并令 CLI 非零退出；它不表示预期失败，也不允许降低其他案例的失败等级。

## 6. 显式映射规则

### 6.1 店铺和商品

```json
{
  "shops": {
    "MIA": "shop_mia_fashion",
    "MIA Fashion": "shop_mia_fashion",
    "Pixel": "shop_pixel_tech",
    "Pixel Tech": "shop_pixel_tech"
  },
  "products": {
    "fashion_hoodie": "fashion_hoodie",
    "silentkey84": "tech_silent_keyboard",
    "portable_monitor": "tech_monitor"
  }
}
```

映射目标必须存在于 `seed/seed-data.json`。不存在即转换失败，不允许回退到名称模糊匹配。

### 6.2 任务别名

转换器使用显式别名表，并把组合项拆成数组：

- `SHIPPING/POLICY`、`SHIPPING_QUERY` → `SHIPPING_POLICY`
- `AFTER_SALES/POLICY` → `AFTER_SALES_QUERY`
- `ORDER/ACTION_REQUEST`、`ORDER/LOGISTICS_QUERY` → `ORDER_QUERY` 或 `LOGISTICS_QUERY`，由案例 override 精确指定
- `INVOICE/POLICY` → `FAQ_QUERY`，并以 STORE Evidence 和发票事实约束，不创造不存在的 intent
- `PRODUCT/PRICE_QUERY` → `PRODUCT_QUERY`，同时强制动态 Product/SKU 结果断言
- `PRODUCT_QUERY/NO_EVIDENCE` → `PRODUCT_QUERY` + `evidence.required=false`
- `UNKNOWN/NO_EVIDENCE`、`UNKNOWN/SECURITY`、`UNKNOWN/PROVIDER_FAILURE` → `UNKNOWN`，并分别附加拒答、安全或 Provider 故障断言
- `产品/FAQ`、`产品/FAQ任意低风险`、`低风险/ASSIST`、`低风险AUTO`、`任意低风险Query` 必须由 per-ID override 解析，禁止全局模糊映射

目标任务必须属于 `packages/core/src/structured-output.ts` 的 canonical intent allowlist，否则转换失败。

### 6.3 多轮和控制动作

- 源文本中的 `/` 不一律代表消息分隔；只有 per-ID override 可以把它拆成多条消息。
- `→` 表示时序时，override 必须明确 turn 编号和中间 setup action。
- 商品卡、订单卡、图片、编辑、撤回必须转换为结构化 `EvalMessageV2`。
- `I05/I06`、`M03/M04/M07`、`E01`–`E04` 必须使用结构化 setup 或 reliability harness，不允许把描述作为普通文本发送。
- `P07` 明确标为语义错配案例：键盘上下文中的“宽松版型”不得被当作有依据的正常商品回答；期望为澄清或安全降级。

### 6.4 知识概念

`Expected_Knowledge_Concept` 只用于人读报告，不直接参与运行时匹配。`eval-v2-overrides.json` 必须为每个正例列出一个或多个稳定 `knowledge.key`。转换器加载 Seed 后验证这些 key 的 shop、scope、product 与案例一致。

Q37 单独映射到 `conflict_001`。Q09/Q39 保留相同知识 key，但使用不同 `maxRank`。Q29/Q30 必须分别声明本店知识 key，并把另一店对应 key 放进禁止集合。

## 7. 执行架构

### 7.1 转换阶段

`eval-v2.converter.ts` 执行以下原子流程：

1. 读取两个源 CSV，验证 BOM/UTF-8、固定列名、行数 40/72、ID 唯一和必填字段。
2. 读取 alias、override 和 Seed Catalog。
3. 生成内存 canonical 对象并进行全量 schema/引用验证。
4. 使用稳定 key 顺序序列化 JSON。
5. 仅在两套数据都成功时替换两个 canonical 文件。

转换结果不得包含数据库 ID，因为数据库 ID 会随 Workspace 重建变化；只保存 Seed key，执行时在隔离 Workspace 内解析成 scoped ID。

### 7.2 Retrieval Eval

`RetrievalEvalExecutor` 每次运行创建一个独立 SEEDED Workspace，通过正式 `KnowledgeService.search` 查询，而不是复制排序算法。每条调用均传入真实 `workspaceId + tenantId + shopId`，PRODUCT 案例还必须传 `productId`。

执行器记录：查询、状态、TopK 顺序、itemId、versionId、seed knowledge key、scope、productId、score、冲突 ID、耗时和全部断言。跨店校验不只检查返回文本，还检查每条 Evidence 的持久化归属。

离线模式使用确定性 embedding provider；真实模式使用实际 PostgreSQL/pgvector 和已配置 embedding provider。二者分别出报告，不互相覆盖。

### 7.3 Product Eval

`ProductEvalExecutor` 复用并扩展 `ProductionReplyEvalExecutor`，每条案例创建独立 SEEDED Workspace，执行真实 Message → Turn → Task → Context → Evidence → Policy → Draft/Outbox/Receipt 链路。

- 普通知识、上下文和多任务案例走 `REPLY_RUNTIME`。
- `E01`–`E04` 及必须控制竞态的案例走 `RELIABILITY_HARNESS`。
- 结果必须包含 UserTurn、Task、选择的实体、冻结 Evidence、Policy mode、Draft/SendOutbox、发送回执和关联 Trace ID。
- AUTO 的通过要求不仅是回答文本正确，还要求存在本 ReplyJob 的 SENT outbox 和投影消息。
- ASSIST 的通过要求 Draft 可见且没有未经人工确认的 AI SENT outbox。
- MANUAL 的通过要求无 AI 自动发送；高风险动作只能产生 handoff/proposal 等允许状态。
- `oldReplyMustNotBeSent` 必须按 ReplyJob/SendOutbox 持久关联验证，不能按文本猜测。

若 `requiredCapabilities` 中任一能力尚未实现，执行器返回 `BLOCKED_UNSUPPORTED` 和精确 capability 名称。它不能抛出后被统一记录为普通模型失败，也不能切换成假 fixture 取得 PASS。

## 8. 报告与评分

每次运行写入带时间戳的目录：

```text
artifacts/eval-v2/<run-id>/
  manifest.json
  retrieval-results.json
  retrieval-report.md
  product-results.json
  product-report.md
  coverage-matrix.csv
```

`manifest.json` 包含 Git commit、dirty 状态、Node/pnpm 版本、OS、Provider 模式、模型名、源 CSV SHA256、canonical JSON SHA256、开始/结束时间和各命令退出码；不写 API Key、Token、Cookie、数据库密码或完整连接串。

每个 case 结果必须保留：source ID、输入、结构化 setup、actual tasks/mode/context/evidence/tools/output、逐项断言、失败原因、耗时和状态。Markdown 汇总必须分开显示 PASS、FAIL、BLOCKED_UNSUPPORTED、BLOCKED_ENVIRONMENT、NOT_RUN，另列 safety blocker 失败。

`coverage-matrix.csv` 一行对应一个源 ID，至少包含 suite、domain、execution kind、provider mode、status、tasks、mode、evidence scope、capabilities、failure reason。它用于证明 40 + 72 没有漏项。

## 9. CLI 与持续集成

新增根脚本：

```json
{
  "eval:v2:convert": "...",
  "eval:v2:offline": "...",
  "eval:v2:real": "...",
  "eval:v2:all": "..."
}
```

具体语义：

- `eval:v2:convert`：验证来源并重建 canonical JSON；若工作树生成 diff，CI 失败，提示提交转换结果。
- `eval:v2:offline`：运行 40 条离线检索和 72 条离线可执行产品案例；任一 FAIL、BLOCKED_UNSUPPORTED 或 NOT_RUN 非零退出。
- `eval:v2:real`：在真实 PostgreSQL/pgvector/Redis/MinIO 下运行全部 Retrieval 40 和 Product 72；Provider 案例按配置执行。环境缺失则整体明确 `BLOCKED_ENVIRONMENT` 并非零退出。
- `eval:v2:all`：依次执行 convert、offline、real，不吞掉任何退出码。

单元 CI 运行 schema、转换一致性、映射完备性和离线执行。现有 real-infrastructure job 运行真实套件。现有 36 + 10 命令继续运行，直到 V2 连续稳定通过后再单独决定是否合并入口；本设计不自动替换它们。

## 10. 测试策略

实施严格采用 tests-first：

1. 转换器红测：错误列、错误行数、重复 ID、未映射别名、无效 Seed key、非法任务、缺 override、部分写入。
2. Retrieval 红测：Top1/Top3、NO_EVIDENCE、跨店、跨商品、无商品上下文、冲突、动态事实不进入静态 Evidence。
3. Product 红测：多轮结构化、任务组合、Evidence/动态事实、AUTO/ASSIST/MANUAL、人工接管、编辑/撤回、库存与订单变化、Provider 故障、重启和重复/乱序消息。
4. 报告红测：112 个源 ID 全出现一次；五种状态互斥；blocked 不计 pass；秘密字段被清除；Markdown 与 JSON 汇总一致。
5. 真实集成：隔离 Workspace、真实 PG/pgvector/Redis/MinIO、持久 outbox/receipt、重启恢复和跨店零泄漏。

关键 Gate：

- canonical 中恰好 40 + 72 条，且源 ID 一一对应。
- 原有 36 + 10 评测不回归。
- 所有 scope 查询包含 workspaceId、tenantId、shopId，适用时包含 productId/buyerId/conversationId。
- 所有回答事实可追溯到冻结 Evidence 或动态 Tool/Task result。
- 缺证据、冲突、高风险和故障场景不得自动发送。
- 真实与离线报告分开，不用一个模式覆盖另一个模式的失败。

## 11. 安全、隐私与可复现性

- 每个案例使用独立 Workspace，结束后按精确 workspaceId 清理。
- 报告只保存合成数据和必要的 opaque ID；不保存凭据或真实用户数据。
- Provider 凭据只从现有环境/文件注入，不进入 manifest、JSON、Markdown 或日志。
- Evidence 评分使用执行时冻结的 `itemId/versionId/scope/productId/contentSnapshot`，不依赖后来可能变化的 active knowledge 投影。
- 动态库存、价格、订单、物流不得伪装成 Knowledge Evidence；必须来自 scoped Tool/Task result。
- 任何跨 Workspace、跨店或跨商品 Evidence 都是 safety blocker failure。

## 12. 兼容与迁移

V2 是增量新增：旧的 `ReplyEvalCase`、CLI、报告和 Seed 文件保持可用。V2 canonical 数据不写入 Prisma Seed 表，也不改变应用运行时数据模型。执行时仍通过现有 Seed Catalog 建立隔离 Workspace。

首轮实现允许某些 72 案例报告 `BLOCKED_UNSUPPORTED`，但每个 blocked 项必须有稳定 capability code；随后逐项实现直到为零。在达到零之前，文档只能表述“已导入并形成完整执行清单”，不能表述“72/72 全部通过”。

## 13. 完成定义

本任务只有同时满足以下条件才算完成：

1. 两份原 CSV、两份 canonical JSON、alias 和 override 文件均在仓库中并通过 secret scan。
2. 40 条 Retrieval 全部真实执行，报告无漏项。
3. 72 条 Product 全部进入执行结果，且发布 Gate 中 `BLOCKED_UNSUPPORTED=0`。
4. 离线和真实基础设施报告各自完整，状态诚实。
5. 原有 36 + 10 套件、全仓 typecheck、unit、integration 和 build 均通过。
6. 报告能逐 Case 展示输入、Task、Mode、Context、Evidence/Tool、输出和评分原因。
7. README/评测文档只引用实际生成的结果，不写未经运行的通过数字。
