# 阶段 UI-0：前端结构与 Design System

执行全局指令后，仅完成本阶段。

## 目标
在不改变功能的前提下，先解除大文件耦合并建立统一设计系统，为后续五个页面改造提供稳定基础。

## 工作项
1. 审查 `apps/web/src/App.tsx`、`api.ts`、`styles.css`，输出最小拆分计划后直接实施。
2. 建立建议结构：
   - `app/`：router、providers、AppShell
   - `features/`：workbench、knowledge、workflows、dashboard、scenario-lab、shops、quality
   - `components/ui/`、`components/layout/`、`components/feedback/`
   - `api/client.ts`、`api/schemas.ts`、`api/endpoints/`
   - `styles/tokens.css`、`styles/base.css`、`styles/layout.css`
3. AppShell：左侧导航、顶部店铺切换/AI模式/连接状态/Developer Trace/人工接管入口。
4. 建立 Button、Input、Select、Tabs、Badge、Card、Table、Dialog、Drawer、Tooltip、Skeleton、EmptyState、ErrorState 的统一组件或样式契约。
5. 保留全部现有路由和行为；页面内容暂时可复用旧组件，但不得破坏功能。

## 验收
- `App.tsx` 不再包含全部页面实现。
- 路由全部可访问，现有功能和 API 调用不回归。
- 设计 token 在后续页面可复用。
- typecheck、相关测试、build 通过。
- 截图：AppShell + 四个主要路由的基础状态。
