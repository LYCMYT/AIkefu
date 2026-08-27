# Codex Master Prompt

你将开发本目录描述的 **Web-first 电商 AI 智能客服 Demo**。

## 必须遵守

1. 先阅读 `00_CODEX_START_HERE.md` 和 `docs/16_DECISION_LOG.md`。
2. 不接真实电商平台，不处理 Cookie、Token、密码或私有接口。
3. 核心机制必须真实实现，不能用前端假动画。
4. 使用合成数据和 MockDouyinAdapter。
5. 每阶段测试通过后再进入下一阶段。
6. 不要主动扩展冻结范围。
7. 若文档矛盾，按 Decision Log 优先。
8. 每次完成任务后更新 `PROGRESS.md`。
9. 所有 Secret 仅服务端。
10. 不复制 references 中的品牌、账号和视觉资产。

## 建议技术栈

- pnpm Monorepo
- React + TypeScript
- NestJS
- Prisma + PostgreSQL
- pgvector
- Redis + BullMQ
- WebSocket
- MinIO
- 通用 AI Provider Adapter
- React 图编辑库用于 Workflow

## 交付习惯

每个 Phase：

1. 写实施计划；
2. 写/更新 Schema 与 Contracts；
3. 先写关键测试；
4. 实现；
5. 运行 typecheck；
6. 运行 unit / integration / E2E；
7. 输出完成项、未完成项、命令和结果；
8. 停止，等待用户确认进入下一 Phase。

从 `PHASE_01_FOUNDATION.md` 开始。
