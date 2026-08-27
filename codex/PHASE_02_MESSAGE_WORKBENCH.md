# Phase 02｜消息管线、Buyer Simulator 与 Workbench

## 目标

从 Buyer Simulator 真实发送消息，经 MockDouyinAdapter、数据库和队列，最终实时出现在 Workbench。

## 阅读

- docs/03_INFORMATION_ARCHITECTURE_UI.md
- docs/06_STATE_MACHINES.md
- docs/07_MESSAGE_PIPELINE_CONCURRENCY.md
- docs/11_API_WEBSOCKET_CONTRACTS.md
- specs/websocket-events.json

## 实现

### 1. MockDouyinAdapter

实现：

- message
- product card
- order card
- edit
- recall
- subscribe

### 2. Message Pipeline

- Normalize
- Deduplicate
- 1s Reorder Buffer
- Gap Detection
- Message + ProcessingOutbox 同事务
- Outbox Dispatcher
- BullMQ Consumer

### 3. Persistent TurnBuffer

- 2s idle
- 5s hard max
- generation
- delayed job
- recovery

### 4. Conversation

- 平台 ID / 30min idle
- contextVersion
- current product / order
- sync state

### 5. Buyer Simulator

- 选店
- 选买家
- 文本
- 商品卡
- 订单卡
- 编辑
- 撤回
- 图片 UI 可以先完成上传占位，真正分析 Phase 03

### 6. Workbench

- 店铺栏
- 会话列表
- 消息区
- 右侧基本商品 / 订单上下文
- WebSocket 实时更新
- 多标签状态由服务端统一

## 测试

- duplicate
- reorder
- gap
- late message
- turn 2s / 5s
- restart turn recovery
- two buyers
- two shops
- edit / recall
- WebSocket reconnect + REST snapshot

## Gate

Scenario S01 / S03 / S04 / S05 的消息层先通过。

完成后停止。
