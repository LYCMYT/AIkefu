# 阶段 UI-5：场景实验室

参考图：`docs/aikefu-frontend-codex-ui-pack-v1/references/05-scenario-lab.png`

## 目标
把 Scenario Lab 做成可靠性演示中心，用于运行现有 8 个核心异常场景，不虚构结果。

## 布局
- 左：场景搜索、分组、场景列表。
- 右顶部：场景标题、说明、参数、开始测试。
- 中部：本次运行真实指标与状态。
- 下部：运行记录表、查看详情。

## 必须呈现
- 未运行时不要显示伪造通过率和耗时。
- Running、Completed、Failed、Cancelled 状态。
- 测试步骤、事件时间线、关键 Trace 与失败原因。
- 与 Developer Trace/日志详情跳转联动。

## 验收
- 现有 8 个场景均可触发并展示真实运行结果。
- 失败场景不会被 UI 显示为成功。
- 页面可用于现场演示连续消息、并发、乱序、超时、重启和状态变化。
