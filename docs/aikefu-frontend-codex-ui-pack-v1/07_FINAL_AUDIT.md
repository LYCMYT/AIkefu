# 阶段 UI-6：最终前端审计

不新增业务功能，仅做前端收口。

## 检查
1. 所有路由的 Loading、Empty、Error、Disabled、Disconnected 状态。
2. 1440×900、1366×768、1920×1080；除 Workflow 画布外无横向溢出。
3. 键盘焦点、表单 Label、对比度、Tooltip、Dialog/Drawer 可关闭。
4. 不存在硬编码参考图数据；不暴露 Secret。
5. App.tsx、API 和 CSS 不再回退为超大单文件。
6. 运行 typecheck、unit、integration、frontend smoke/build。
7. 使用 Playwright 生成五张最终截图到 `artifacts/ui/final/`。
8. 更新 README 前端截图和 UI 说明。

## 最终报告
最多 12 行：改造模块、测试、截图位置、未解决问题。不要粘贴完整 diff。
