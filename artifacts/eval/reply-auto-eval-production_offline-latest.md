# AIkefu Reply Eval Report

- Generated: 2026-08-30T17:36:22.117Z
- Mode: PRODUCTION_OFFLINE
- Provider / model: offline-structured-demo / offline-structured-v1
- Result: 10/10 passed; 0 failed
- Technical path: 10/10 passed
- Deterministic safety: 10/10 passed
- Human review required: 0
- Tokens: 0 input / 0 output
- Average latency: 26 ms
- Cost: not reported

| Case | Result | Technical | Safety | Human review | Mode | Tasks | Evidence | Failure |
|---|---|---|---|---|---|---|---|---|
| A001 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | SHIPPING_POLICY | 默认使用顺丰或中通，具体承运方以订单物流信息为准。, 是否支持指定快递需要人工确认，AI不做确定承诺。 |  |
| A002 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | SHIPPING_POLICY | 数码商品通常在48小时内发出；预售或定制商品以商品页说明为准。, 保修期限以商品说明和订单凭证为准。 |  |
| A003 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | PRODUCT_QUERY | 不建议使用烘干机。 |  |
| A004 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | PRODUCT_QUERY | 支持Windows和macOS。 |  |
| A005 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | INVENTORY_QUERY |  |  |
| A006 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | LOGISTICS_QUERY |  |  |
| A007 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | SHIPPING_POLICY | 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。, 普通现货商品通常在24小时内发出；预售商品以商品说明为准。 |  |
| A008 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | FAQ_QUERY |  |  |
| A009 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | SHIPPING_POLICY |  |  |
| A010 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | REFUND_REQUEST |  |  |
