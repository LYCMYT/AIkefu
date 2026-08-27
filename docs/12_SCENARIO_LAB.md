# Scenario Lab｜8 个核心异常场景

每个场景必须：

- 可一键运行
- 只影响当前 Workspace
- 可 Reset
- 显示步骤与预期状态
- 提供 Trace
- 有自动测试或集成测试支撑

---

## S01 连续消息聚合

### 输入

2 秒内发送：

```text
黑色有吗
XL呢
我165，55公斤
```

### 预期

- 3 Message
- 1 UserTurn
- 2 Task：库存 + 尺码建议
- 只创建 1 个有效 ReplyJob

---

## S02 生成中补消息

### 输入

```text
什么时候发货？
```

AI 开始生成后再发：

```text
我是新疆的
```

### 预期

- contextVersion + 1
- 旧 ReplyJob STALE
- Provider Abort 或逻辑取消
- needsReplan
- 新 Reply 基于新疆规则

---

## S03 两个买家同时咨询

### 输入

Buyer A / Buyer B 同店发送不同问题。

### 预期

- 两个 Conversation 并行
- 同 Conversation 串行
- Context / Task / Reply 不串

---

## S04 两家店同时收到消息

### 输入

MIA Fashion 与 Pixel Tech 同时收到“多久发货”。

### 预期

- MIA 使用 MIA StoreKnowledge
- Pixel 使用 Pixel StoreKnowledge
- 不跨店检索
- Trace 展示 shopId 过滤

---

## S05 重复 + 乱序

### 输入

发送 sequence：

```text
101
103
102
```

并重复 102。

### 预期

- 103 进入 Reorder Buffer
- 102 到达后按 102 / 103 Commit
- 重复 102 被唯一约束拦截
- 最终消息顺序正确

---

## S06 AI 超时 + Fallback

### 输入

主 Provider 模拟超时。

### 预期

- timeout
- retry once
- fallback
- 记录 fallbackUsed
- 若 Fallback 也失败：按 mode 降级
- 无无限重试

---

## S07 服务重启恢复

### 场景 A

ReplyJob GENERATING 时模拟重启。

预期：

- Recovery Worker
- RECOVERY_PENDING
- Context 有效则重新生成

### 场景 B

SendOutbox SENDING 时模拟重启。

预期：

- SENDING → UNCERTAIN
- 不自动重发

---

## S08 库存 / 订单状态变化

### 库存

AI 读取库存 8，生成中改为 0。

预期：

- ProductContext 更新
- contextVersion + 1
- 旧 Reply STALE
- 新 Reply 说售罄

### 订单

AI 读取 WAITING_SHIPMENT，生成中改为 SHIPPED。

预期：

- 旧 Reply STALE
- 新 Reply 使用 SHIPPED

---

## 不做独立按钮的场景

通过 Buyer Simulator / Workbench 演示：

- Prompt Injection
- 人工接管
- 多订单歧义
- 知识冲突
- 图片多模态
- 消息撤回 / 编辑
- Draft 过期
