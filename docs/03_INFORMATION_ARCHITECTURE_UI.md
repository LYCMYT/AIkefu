# 信息架构与 UI 需求

## 1. 设计原则

- Web-first，但视觉上保持成熟桌面客服工作台的感觉。
- 不像素级复制参考产品。
- 使用全新品牌、Logo、配色、图标和组件。
- 正常模式强调业务效率；Developer Trace 默认隐藏。
- 所有页面都必须支持当前 Workspace 隔离。
- 关键状态必须可见：连接、AI 模式、会话模式、Draft、任务、错误和恢复。

---

## 2. 路由结构

```text
/
├── /workbench
├── /admin
│   ├── /overview
│   ├── /shops
│   ├── /products
│   ├── /knowledge
│   ├── /knowledge/candidates
│   ├── /knowledge/conflicts
│   ├── /workflows
│   ├── /quality
│   ├── /incidents
│   └── /usage
├── /buyer-simulator
└── /scenario-lab
```

首次访问 `/`：

```text
检查 demoWorkspaceToken
→ 无：创建匿名 Workspace
→ 有：验证并读取 Workspace
→ 跳转 /workbench
```

---

## 3. Workbench

### 3.1 总体布局

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 品牌 / Workspace / 当前店铺 / AI模式 / Trace开关 / Reset / 用户     │
├──────────┬─────────────────┬────────────────────────┬───────────────┤
│ 店铺与   │ 会话列表        │ 聊天与 AI Draft         │ 业务上下文     │
│ 功能导航 │                 │                          │ 商品 / 订单    │
│          │                 │                          │ 快捷短语       │
└──────────┴─────────────────┴────────────────────────┴───────────────┘
```

### 3.2 顶部栏

展示：

- 当前 Workspace 简称
- 当前店铺
- 店铺连接状态
- ShopAIMode
- 当前会话 effectiveMode
- Developer Trace 开关
- Reset Demo
- AI Usage 简要信息

### 3.3 店铺侧栏

- 值班中 / 未登录
- 店铺卡片
- AI 开关
- 当前会话数
- 右键菜单：
  - 基础设置
  - 导入知识
  - 商品学习
  - 店铺设置
  - 管理后台
  - 关闭 / 暂停

多平台添加页：

- 抖音 Demo：可用
- 其他平台：规划中 / disabled

### 3.4 会话列表

支持：

- 当前会话
- 最近联系
- 平台消息
- 昵称 / 订单号 / 聊天文本搜索
- 等待时间
- 未读数
- 会话模式标签
- AI Draft 状态
- DEGRADED / MANUAL 等风险状态

V1 搜索可使用服务端模糊搜索，不要求复杂全文搜索 UI。

### 3.5 聊天区

支持：

- BUYER / AI / HUMAN / SYSTEM
- TEXT / IMAGE / GOODS_CARD / ORDER_CARD
- 消息编辑 / 撤回状态展示
- AI Draft Streaming Preview
- 人工编辑 Draft
- 发送
- 接管 / 恢复 AI
- 重新生成
- 标记回答有误
- 保存为知识
- 保存为 CustomerMemory

### 3.6 ASSIST Draft

状态展示：

```text
GENERATING
WAITING_HUMAN
STALE
EXPIRED
FAILED
```

显示：

- 有效剩余时间
- 失效原因
- 重新生成按钮
- AI Draft 与 Human Final 差异入口

### 3.7 右侧业务上下文

Tabs：

- 智能助手 / 快捷短语
- 商品
- 订单
- 会话搜索
- 用户记忆

商品区：

- 当前商品
- SKU
- 价格
- 库存
- 商品状态
- 商品知识摘要

订单区：

- 订单列表
- 状态
- 当前绑定订单
- 歧义候选
- 静态物流快照

CustomerMemory：

- 查看
- 新增
- 编辑
- 停用
- 删除

### 3.8 Developer Trace

默认隐藏。

打开后显示：

- Raw Messages
- UserTurn
- TaskBundle
- Context Resolver
- FactContext
- ProductContext
- CustomerContext
- RAG Evidence
- Reply Policy
- Workflow / Tool
- SendGuard
- AI Runtime
- Reply Incident / Quality

不展示模型私有推理文本。

---

## 4. Admin

### 4.1 Overview

卡片：

- 在线店铺
- 今日进线
- AI 回复
- 人工接管
- Fast Path
- LLM Reply
- AI Usage
- 已质检通过率（显示样本量）

图表：

- 会话趋势
- 热门问题
- 知识命中
- 转人工原因
- AI 用量

数据使用当前 Workspace 的真实 Demo 数据。

### 4.2 Shops

- 店铺列表
- ShopAIMode
- 店铺设置
- 物流 / 发货 / 售后政策
- 欢迎语 / 结束语
- 转人工关键词
- 违禁词
- 商品同步 / 学习

### 4.3 Products

- 商品列表
- SKU、价格、库存、状态
- 同步状态
- 学习状态
- ProductKnowledge 数量
- 同步商品
- 重新学习
- 编辑 Mock 商品说明
- Scenario 允许修改库存

### 4.4 Knowledge

Tabs：

- 正式知识
- 候选知识
- 冲突知识
- 学习记录

正式知识：

- 名称 / Q / A
- STORE / PRODUCT
- 来源
- 业务状态
- 索引状态
- Active Version
- 编辑
- 停用
- Soft Delete
- 重新索引

导入：

- 上传 `.xlsx` / `.csv`
- 预览
- 正常 / 重复 / 冲突 / 错误统计
- 下载错误明细
- 确认导入

### 4.5 Workflows

布局：

- 左：Workflow 列表
- 中：画布
- 右：节点工具与节点配置

支持：

- 新增节点
- 删除节点
- 连线
- 拖动
- 保存草稿
- 发布
- 版本
- 运行日志

### 4.6 Quality

- 可质检会话列表
- 人工点击开始质检
- 规则结果
- AI Judge
- 人工结论
- PASS / FAIL / NEEDS_HUMAN
- 加入 Regression Eval

### 4.7 Reply Incidents

- 错误回复
- 严重程度
- 根因
- Correction Draft
- 修复状态
- Regression Case

### 4.8 Usage

- Purpose
- Provider / Model
- Calls
- Tokens
- Cost
- Fallback
- Failures
- Fast Path 数量
- 虚拟店铺额度展示（不作为公开 Demo 防滥用门禁）

---

## 5. Buyer Simulator

手机聊天外观，支持：

- 选择店铺
- 选择 Buyer
- 文本
- 图片
- 商品卡
- 订单卡
- 编辑
- 撤回
- 查看 AI / 人工回复

不得复制抖音 UI，只表达“模拟外部电商消费者端”。

---

## 6. Scenario Lab

每个 Scenario 卡片包含：

- 目的
- 前置数据
- 运行按钮
- 状态
- Expected Result
- Trace Link
- Reset Scenario

8 个场景见 `docs/12_SCENARIO_LAB.md`。

---

## 7. 响应式

主要面向桌面端：

- 推荐最小宽度 1280
- Buyer Simulator 可窄屏
- Workbench 在小屏只需基本可用，不要求完整移动端适配
