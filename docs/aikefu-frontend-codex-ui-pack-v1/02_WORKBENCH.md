# 阶段 UI-1：客服工作台

参考图：`docs/aikefu-frontend-codex-ui-pack-v1/references/01-workbench.png`

## 目标
将 `/workbench` 改造成简洁、高级、信息密度适中的四区客服工作台；保留所有现有消息、AI、人机协同与实时状态逻辑。

## 布局
- 左侧全局侧栏由 AppShell 提供。
- 工作台内容：会话列表约 320px；聊天主体自适应；右侧业务上下文约 320px。
- 顶部：店铺、AI模式、连接状态、Developer Trace、人工接管。

## 必须呈现
1. 会话列表：搜索、筛选、进行中/已结束、未读、最后消息、时间、当前 AI/人工状态。
2. 聊天主体：文本、图片、商品卡、订单卡、系统消息；时间分隔；生成中、STALE、EXPIRED、失败状态。
3. AI Draft：ASSIST 流式预览、编辑、发送、人工接管；AUTO/MANUAL 状态明确。
4. 输入区：快捷动作、附件、发送；禁用和错误态清晰。
5. 右侧上下文：客户、相关订单、当前商品、快捷操作；无数据时简洁空状态。
6. Developer Trace 默认隐藏，开启后以 Drawer/侧栏展示结构化 Trace，不挤压普通使用体验。

## 禁止
- 不使用参考图里的假用户、金额和库存。
- 不将已有后端状态改为前端模拟。
- 不移除 Context Resolver、SendGuard、AI Draft、Manual takeover 等入口。

## 验收
- Buyer Simulator 发消息后实时进入 Workbench。
- 店铺切换、会话切换、AI模式和人工接管正常。
- 1440×900 可作为作品集截图。
- Loading/Empty/Error/Disconnected 状态均可见且可测试。
