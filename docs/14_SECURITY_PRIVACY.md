# 安全、隐私与数据生命周期

## 1. 敏感资产

- AI Provider Key
- 数据库与对象存储 Secret
- 消费者聊天
- 订单、商品、物流
- 图片
- CustomerMemory
- 企业知识
- Audit / Trace

---

## 2. Secret

- Key 只在服务端
- 不进入前端 Bundle
- 不进入 URL
- 不进入 WebSocket payload
- 不进入普通日志
- `.env` 不提交
- 提供 `.env.example`

用户明确选择：公开 Demo V1 不做 Workspace Quota、Rate Limit 或超额 Fallback。该取舍有费用滥用风险，需在部署说明中标记。即便如此，Key 仍不得暴露到浏览器。

---

## 3. Workspace 与数据隔离

所有请求：

```text
workspaceId
tenantId
```

店铺数据：

```text
shopId
```

服务端不能信任前端传入实体归属，必须查询并验证。

Signed URL 也按 Workspace 所有权生成。

---

## 4. Context Sanitizer

进入 AI 前：

- 手机脱敏
- 不发送完整地址
- 不发送 Token / Cookie
- 不发送无关订单
- 只按 purpose 传必要字段

日志记录数据类别，不记录完整 Prompt。

---

## 5. Prompt Injection

- 用户输入、图片文本、商品详情、上传文档均视为 Untrusted
- System Rules 与 Trusted Facts 分区
- Tool Allowlist
- Action Policy 在模型外
- 模型不能赋予自己权限
- 用户要求泄露 Prompt 时不返回内部内容

---

## 6. 图片

允许：

- JPEG
- PNG
- WEBP

必须：

- MIME 校验
- 大小限制
- 解码校验
- 对象存储
- Signed URL
- 15 天生命周期

图片分析结果不自动进入知识。

---

## 7. Retention

默认：

| 数据 | 保留 |
|---|---|
| Conversation 原文 | 45 天 |
| 图片 | 15 天 |
| ConversationSummary | 90 天 |
| CustomerMemory | 人工管理 / expiresAt |
| 企业知识 | 版本 / 状态 / 有效期 |
| AuditLog | 最小化脱敏长期保留 |

---

## 8. Delete Customer Data

删除 / 匿名化：

- Conversation 原文
- Attachment
- CustomerMemory
- 关联 Candidate
- 可识别 Buyer 信息

保留：

- 匿名聚合统计
- 无法反推个人的 Audit 事实

删除后 AI 不得继续读取旧 Memory。

---

## 9. Audit

记录：

- requestId
- actor
- action
- 脱敏 entityId
- status
- duration
- time

不记录：

- 完整聊天
- 手机
- 地址
- Secret
- Cookie / Token
- 完整 Prompt
- 图片内容

---

## 10. 文件导入

- 文件大小限制
- 行数限制
- 不执行公式
- 防 CSV Injection
- 仅解析数据
- 错误明细脱敏
- 临时文件及时删除

---

## 11. 开发数据

- 全部合成
- 不使用真实消费者
- 不导入公司原数据
- 不使用参考产品账号信息
- 参考截图不进入最终 UI 资产

---

## 12. 非目标

V1 不实现：

- 企业级 SSO
- 复杂 RBAC
- 等保 / ISO
- WAF
- 高级 DLP
- 完整 PII 图像自动打码
- 公共 Demo 防刷

这些作为生产扩展方向记录。
