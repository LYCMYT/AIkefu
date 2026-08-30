# AIkefu Reply Eval Report

- Generated: 2026-08-30T04:24:57.695Z
- Mode: PRODUCTION_OFFLINE
- Provider / model: offline-structured-demo / offline-structured-v1
- Result: 31/36 passed; 5 failed
- Tokens: 0 input / 0 output
- Average latency: 0 ms
- Cost: not reported

| Case | Result | Mode | Tasks | Evidence | Failure |
|---|---|---|---|---|---|
| E001 | PASS | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。, 不同商品洗护要求不同，请发送商品卡或商品名称后查询。 |  |
| E002 | PASS | ASSIST | SHIPPING_POLICY | 数码商品通常在48小时内发出；预售或定制商品以商品页说明为准。, 保修期限以商品说明和订单凭证为准。, 请发送订单卡或选择具体订单，系统不会从多个订单中猜测。 |  |
| E003 | PASS | ASSIST | SHIPPING_POLICY | 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。, 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 不同商品洗护要求不同，请发送商品卡或商品名称后查询。 |  |
| E004 | PASS | ASSIST | PRODUCT_QUERY | 不建议使用烘干机。, 该商品为宽松版型。 |  |
| E005 | PASS | ASSIST | PRODUCT_QUERY | 支持Windows和macOS。, 支持蓝牙、2.4G和有线三模。, 采用静音线性轴，适合安静办公。 |  |
| E006 | PASS | ASSIST | INVENTORY_QUERY |  |  |
| E007 | PASS | ASSIST | INVENTORY_QUERY |  |  |
| E008 | PASS | ASSIST | INVENTORY_QUERY, SIZE_RECOMMENDATION | 适合春秋日常穿着。, 70%棉、30%聚酯纤维。, 不建议使用烘干机。 |  |
| E009 | PASS | ASSIST | INVENTORY_QUERY, SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 不同商品洗护要求不同，请发送商品卡或商品名称后查询。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E010 | PASS | ASSIST | INVENTORY_QUERY, LOGISTICS_QUERY |  |  |
| E011 | PASS | ASSIST | LOGISTICS_QUERY |  |  |
| E012 | PASS | ASSIST | LOGISTICS_QUERY |  |  |
| E013 | PASS | ASSIST | LOGISTICS_QUERY |  |  |
| E014 | PASS | MANUAL | HUMAN_REQUEST |  |  |
| E015 | PASS | MANUAL | COMPLAINT |  |  |
| E016 | PASS | MANUAL | REFUND_REQUEST |  |  |
| E017 | PASS | ASSIST | FAQ_QUERY | 支持7天无理由退货，但商品需保持完好，不影响二次销售。, 是否支持指定快递需要人工确认，AI不做确定承诺。, 普通地区是否包邮以商品页与下单页面显示为准，偏远地区可能产生附加运费。 |  |
| E018 | PASS | MANUAL | SHIPPING_POLICY |  |  |
| E019 | PASS | MANUAL | REFUND_REQUEST |  |  |
| E020 | PASS | ASSIST | AFTER_SALES_QUERY | 请上传破损位置的清晰图片，客服会根据订单和售后政策协助处理。, 普通地区是否包邮以商品页与下单页面显示为准，偏远地区可能产生附加运费。, 不同商品洗护要求不同，请发送商品卡或商品名称后查询。 |  |
| E021 | PASS | ASSIST | ORDER_QUERY |  |  |
| E022 | PASS | ASSIST | LOGISTICS_QUERY |  |  |
| E023 | PASS | ASSIST | INVENTORY_QUERY |  |  |
| E024 | PASS | ASSIST | INVENTORY_QUERY |  |  |
| E025 | PASS | ASSIST | ORDER_QUERY |  |  |
| E026 | FAIL | NOT_RUN |  |  | EXECUTOR_FAILED: EXECUTOR_UNSUPPORTED:primaryProvider,fallback |
| E027 | FAIL | NOT_RUN |  |  | EXECUTOR_FAILED: EXECUTOR_UNSUPPORTED:primaryProvider,fallback |
| E028 | PASS | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。, 不同商品洗护要求不同，请发送商品卡或商品名称后查询。 |  |
| E029 | PASS | ASSIST | PRODUCT_RECOMMENDATION |  |  |
| E030 | PASS | ASSIST | SHIPPING_POLICY | 默认使用顺丰或中通，具体承运方以订单物流信息为准。, 是否支持指定快递需要人工确认，AI不做确定承诺。, 请发送订单卡或进入订单详情，以避免关联错误记录。 |  |
| E031 | PASS | ASSIST | SHIPPING_POLICY | 普通现货商品通常在24小时内发出；预售商品以商品说明为准。, 不同商品洗护要求不同，请发送商品卡或商品名称后查询。, 新疆、西藏等偏远地区的履约时效以实际物流信息为准，不作固定时效承诺。 |  |
| E032 | PASS | ASSIST | PRODUCT_RECOMMENDATION |  |  |
| E033 | FAIL | NOT_RUN |  |  | EXECUTOR_FAILED: EXECUTOR_UNSUPPORTED:changeContextBeforeApproval |
| E034 | PASS | ASSIST | ORDER_QUERY |  |  |
| E035 | FAIL | NOT_RUN |  |  | EXECUTOR_FAILED: EXECUTOR_UNSUPPORTED:restartDuring |
| E036 | FAIL | NOT_RUN |  |  | EXECUTOR_FAILED: EXECUTOR_UNSUPPORTED:restartDuring |
