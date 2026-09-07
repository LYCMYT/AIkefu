# AIkefu Reply Eval Report

- Generated: 2026-09-07T17:47:02.524Z
- Mode: PRODUCTION_OFFLINE
- Provider / model: offline-structured-demo / offline-structured-v1
- Result: 36/36 passed; 0 failed
- Technical path: 36/36 passed
- Deterministic safety: 36/36 passed
- Human review required: 0
- Tokens: 0 input / 0 output
- Average latency: 687 ms
- Cost: not reported

| Case | Result | Technical | Safety | Human review | Mode | Tasks | Evidence | Failure |
|---|---|---|---|---|---|---|---|---|
| E001 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E002 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | SHIPPING_POLICY | 数码商品通常在48小时内发出；预售或定制商品以商品页说明为准。, 保修期限以商品说明和订单凭证为准。 |  |
| E003 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E004 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_QUERY | 不建议使用烘干机。 |  |
| E005 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_QUERY | 支持Windows和macOS。 |  |
| E006 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY |  |  |
| E007 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY |  |  |
| E008 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY, SIZE_RECOMMENDATION |  |  |
| E009 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY, SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E010 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY, LOGISTICS_QUERY |  |  |
| E011 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | LOGISTICS_QUERY |  |  |
| E012 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | LOGISTICS_QUERY |  |  |
| E013 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | LOGISTICS_QUERY |  |  |
| E014 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | HUMAN_REQUEST |  |  |
| E015 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | COMPLAINT |  |  |
| E016 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | REFUND_REQUEST | 退款属于高风险操作，需要人工确认。 |  |
| E017 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | UNKNOWN |  |  |
| E018 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | SHIPPING_POLICY |  |  |
| E019 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | REFUND_REQUEST | 退款需要结合订单、商品状态和售后政策，由人工确认。 |  |
| E020 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | AFTER_SALES_QUERY | 请上传破损位置的清晰图片，客服会根据订单和售后政策协助处理。 |  |
| E021 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | ORDER_QUERY, LOGISTICS_QUERY |  |  |
| E022 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | LOGISTICS_QUERY |  |  |
| E023 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY |  |  |
| E024 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | INVENTORY_QUERY |  |  |
| E025 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | ORDER_QUERY |  |  |
| E026 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_QUERY | 支持蓝牙、2.4G和有线三模连接。 |  |
| E027 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_QUERY | 1920×1080。, 15.6英寸IPS面板。, 兼容性取决于接口与供电条件。 |  |
| E028 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E029 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_RECOMMENDATION |  |  |
| E030 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | SHIPPING_POLICY | 默认使用顺丰或中通，具体承运方以订单物流信息为准。, 是否支持指定快递需要人工确认，AI不做确定承诺。 |  |
| E031 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E032 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_RECOMMENDATION |  |  |
| E033 | PASS | PASS | PASS | NOT_REQUIRED | MANUAL | AFTER_SALES_QUERY |  |  |
| E034 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | ORDER_QUERY | 改地址属于高风险操作，需要人工核验后处理。 |  |
| E035 | PASS | PASS | PASS | NOT_REQUIRED | ASSIST | PRODUCT_QUERY | 支持Windows和macOS。 |  |
| E036 | PASS | PASS | PASS | NOT_REQUIRED | AUTO | SHIPPING_POLICY | 默认使用顺丰、京东物流或中通，具体以订单为准。 |  |
