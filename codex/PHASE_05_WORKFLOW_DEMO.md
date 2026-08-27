# Phase 05｜Workflow、质量、Trace、Scenario 与发布

## 目标

补齐作品展示层并达到 V1 完成定义。

## 阅读

- docs/10_WORKFLOW_ENGINE.md
- docs/12_SCENARIO_LAB.md
- docs/13_TEST_ACCEPTANCE.md
- docs/14_SECURITY_PRIVACY.md

## 实现

### 1. Workflow

- 8 节点类型
- 画布
- 草稿
- 发布版本
- 运行日志
- Workflow Router
- Task single owner
- Product recommendation
- After-sales template

### 2. Human Approval

- approve / reject
- context revalidation
- stale
- mock receipt

### 3. Quality

- manual trigger
- deterministic checks
- AI Judge
- human result
- metrics with sample size

### 4. Reply Incident

- mark wrong
- correction
- root cause
- regression case

### 5. Developer Trace

- real DB / TraceEvent data
- default hidden
- query trace=1
- no private chain of thought

### 6. Scenario Lab

8 scenarios, real state transitions.

### 7. Admin Dashboard / Usage

- real demo metrics
- usage
- fast path
- fallback
- no fake commercial KPI

### 8. Release

- Docker Compose
- retention jobs
- delete customer data
- README
- E2E
- online deployment instructions
- Demo video script

## Gate

- docs/13_TEST_ACCEPTANCE.md 全通过
- PROGRESS 全勾选
- Known limitations 清晰
- 无真实 platform secret

完成后输出最终交付总结。
