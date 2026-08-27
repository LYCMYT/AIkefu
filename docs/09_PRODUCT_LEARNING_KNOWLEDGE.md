# 商品学习与知识运营

## 1. 两条知识建设链路

### 1.1 商品自动学习

```text
店铺添加成功
→ MockDouyinAdapter 同步商品
→ Product / SKU 标准化
→ 稳定详情抽取
→ ProductKnowledge
→ Embedding / Index
```

### 1.2 商家问答导入

```text
Excel / CSV
→ 问题 + 答案 + 可选商品ID
→ 校验
→ 预览
→ ENABLED
```

两条链路目的不同：

- 商品学习：系统主动理解商品
- 知识导入：商家主动补充标准答案

---

## 2. ProductContext 与 ProductKnowledge

### ProductContext

动态：

- price
- inventory
- sku
- on/off shelf
- recommendable

每次咨询实时读取，不进入向量库。

### ProductKnowledge

相对稳定：

- material
- size guide
- care
- functions
- usage
- description
- product FAQ

进入 Hybrid RAG。

---

## 3. ProductLearningJob

批量 Job：

```text
PENDING
RUNNING
PARTIAL_SUCCESS
SUCCEEDED
FAILED
```

单商品：

```text
PENDING
PROCESSING
SUCCEEDED
FAILED
OUTDATED
```

页面显示：

- 总商品
- 已完成
- 处理中
- 失败
- 进度
- 重新学习失败项

---

## 4. 自动学习结果

### 自动启用

满足：

- 来源明确
- sourceText 可追溯
- 高置信
- 无内部冲突
- 属于稳定商品事实

### 进入审核

- AI 生成 FAQ
- 中低置信
- 推断性内容
- 来源不足
- 存在歧义

---

## 5. 内容更新

每商品保存：

- sourceVersion
- contentHash
- learnedAt

同步：

```text
hash 未变化
→ 跳过

hash 变化
→ 新 ProductKnowledge Version
→ INDEXING
→ READY
→ 切 active
→ 旧版 OUTDATED
```

---

## 6. 知识导入模板

V1：

| 商品ID（可选） | 问题 | 答案 |
|---|---|---|

系统判断：

```text
商品ID空 → STORE
商品ID有值 → PRODUCT
```

不做 SKU 级知识。

---

## 7. 导入校验

- 文件类型
- 表头
- 空值
- 长度
- 商品 ID
- 重复
- 冲突
- 编码
- 行数限制

结果：

```text
可导入
重复
冲突
错误
```

正常项直接启用。

V1 不做整批回滚。

---

## 8. 知识优先级

```text
MANUAL
>
HUMAN_REVIEWED
>
AUTO_LEARNED
```

Scope：

```text
当前商品 PRODUCT
>
STORE
```

但显式冲突进入治理，不让模型自己选。

---

## 9. KnowledgeCandidate

来源：

- AI_NO_ANSWER_HUMAN_REPLY
- MANUAL_SAVE
- AI_DRAFT_CORRECTION
- AUTO_FAQ

处理：

```text
去重
→ 冲突检测
→ 人工修改
→ 批准 / 拒绝
→ 发布
```

---

## 10. 索引一致性

业务与索引分离：

```text
businessStatus
indexStatus
```

只有：

```text
ENABLED + READY
```

进入 RAG。

修改采用新版本先索引后切换。

---

## 11. Reply Evidence

Reply 固定：

- itemId
- version
- source
- scope
- content snapshot
- retrieval score

知识后续变化不重写历史。

---

## 12. 删除

普通“删除”是 Soft Delete：

- 不再检索
- 历史 Trace 仍可查看
- Reply Incident 仍可归因

---

## 13. 人工修正学习

ASSIST：

```text
AI Draft
→ Human Final
→ 差异分析
```

- STYLE_EDIT：只记录
- FACTUAL_CORRECTION：质检问题 + Candidate
- KNOWLEDGE_ENRICHMENT：Candidate

Candidate 不自动发布。

---

## 14. CustomerMemory

与企业知识分离。

V1 只有人工主动创建，绝不由商品学习或聊天自动生成。
