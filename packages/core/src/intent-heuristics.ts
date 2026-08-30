export type ExplicitIntentTask = {
  intent: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  requiredContext: string[];
  requiredKnowledge?: Array<'STORE' | 'PRODUCT'>;
  requiredTools: string[];
};

/**
 * Conservative lexical supplementation for explicit customer-service asks.
 * It identifies the operation only; it never supplies an answer or business
 * fact. Resolver, Evidence, policy, and SendGuard remain authoritative.
 */
export function inferExplicitIntentTasks(input: string): ExplicitIntentTask[] {
  const text = input.normalize('NFKC').trim();
  const tasks: ExplicitIntentTask[] = [];
  const add = (task: ExplicitIntentTask) => {
    if (!tasks.some((entry) => entry.intent === task.intent)) tasks.push(task);
  };
  const imageDamage = /\[图片\s+PRODUCT_DAMAGE\]|疑似商品破损/iu.test(text);
  const imageShippingLabel = /\[图片\s+SHIPPING_LABEL\]|物流标签信息/iu.test(text);
  if (imageDamage) add(task('AFTER_SALES_QUERY', 'MEDIUM', [], [], []));
  if (imageShippingLabel) add(task('ORDER_QUERY', 'MEDIUM', ['ORDER'], [], ['GET_ORDER']));
  if (/(?:库存|有货|还有|还剩|现货|缺货|售罄|(?:黑色|白色|红色|蓝色|绿色|灰色|奶油色).{0,10}(?:有吗|有么|有货))/iu.test(text)) {
    add(task('INVENTORY_QUERY', 'LOW', ['PRODUCT', 'SKU'], [], ['GET_INVENTORY']));
  }
  if (/(?:尺码|尺寸|大小|合身|身高|体重|公斤|(?:^|[\s，,])(?:XXL|XL|XS|L|M|S)\s*(?:呢|多大|适合|怎么选|推荐|穿|吗|？|\?|$))/iu.test(text)) {
    add(task('SIZE_RECOMMENDATION', 'LOW', ['PRODUCT', 'SKU', 'CUSTOMER_MEMORY'], [], ['GET_PRODUCT']));
  }
  if (/(?:多久|几天|多长时间|什么时候).{0,4}发(?:货|出)?|发(?:货|出).{0,4}(?:多久|几天|多长时间)|发什么快递|支持指定快递|包邮|运费险|偏远地区|新疆|西藏/iu.test(text)) {
    add(task('SHIPPING_POLICY', 'LOW', [], ['STORE'], []));
  }
  if (!imageShippingLabel && /(?:物流|快递.{0,8}(?:没动|到哪|进度|信息)|订单.{0,8}到哪|到哪了|什么时候到)/iu.test(text)) {
    add(task('LOGISTICS_QUERY', 'LOW', ['ORDER'], [], ['GET_ORDER']));
  } else if (/(?:发货了吗|是否发货|订单状态|这单|改地址|修改地址)/iu.test(text)) {
    add(task('ORDER_QUERY', 'MEDIUM', ['ORDER'], [], ['GET_ORDER']));
  }
  if (/(?:预算.{0,12}(?:推荐|想要|键盘|商品)|推荐.{0,8}(?:商品|键盘|衣服)|喜欢.{0,12}(?:版型|键盘|商品)|想要.{0,12}(?:安静|静音|轻便|宽松).{0,8}(?:键盘|商品|衣服))/iu.test(text)) {
    add(task('PRODUCT_RECOMMENDATION', 'LOW', [], [], ['GET_PRODUCT']));
  } else if (/(?:烘干|水洗|材质|面料|支持\s*(?:mac|macos|windows|蓝牙)|连接方式|介绍一下|什么功能|参数)/iu.test(text)) {
    add(task('PRODUCT_QUERY', 'LOW', ['PRODUCT'], ['PRODUCT'], ['GET_PRODUCT']));
  }
  if (/(?:线下试穿|实体店|到店试|营业时间)/iu.test(text)) {
    add(task('FAQ_QUERY', 'LOW', [], ['STORE'], []));
  }
  if (/(?:收到|到货|衣服|商品).{0,10}(?:破了|破损|损坏|坏了)/iu.test(text)) {
    add(task('AFTER_SALES_QUERY', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  if (/(?:投诉|举报|差评)/iu.test(text)) {
    add(task('COMPLAINT', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  if (/(?:退款|退钱|退货|取消订单)/iu.test(text)) {
    add(task('REFUND_REQUEST', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  if (/(?:人工|真人客服|转客服)/iu.test(text)) {
    add(task('HUMAN_REQUEST', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  return tasks.slice(0, 4);
}

export function mergeExplicitIntentTasks(
  text: string,
  modelTasks: readonly ExplicitIntentTask[],
): ExplicitIntentTask[] {
  const explicitTasks = inferExplicitIntentTasks(text);
  const explicitRecommendation = explicitTasks.some((entry) => entry.intent === 'PRODUCT_RECOMMENDATION');
  const explicitProductQuery = explicitTasks.some((entry) => entry.intent === 'PRODUCT_QUERY');
  const explicitInventory = explicitTasks.some((entry) => entry.intent === 'INVENTORY_QUERY');
  const explicitShipping = explicitTasks.some((entry) => entry.intent === 'SHIPPING_POLICY');
  const explicitOrder = explicitTasks.some((entry) => intentFamily(entry.intent) === 'ORDER');
  const merged = modelTasks
    .filter((entry) => entry.intent !== 'UNKNOWN')
    // “喜欢宽松版型的键盘” is a catalogue recommendation request, not a
    // request to disambiguate one existing product.  A generic model
    // PRODUCT_QUERY would otherwise block the real recommendation Workflow
    // behind an unnecessary three-product clarification.
    .filter((entry) => !(entry.intent === 'PRODUCT_QUERY' && explicitRecommendation && !explicitProductQuery))
    // A product card plus “黑色 XL 还有吗” identifies the entity but does not
    // ask for a second generic product description. Keep the live inventory
    // task and drop a model-added PRODUCT_QUERY that would require unrelated
    // RAG evidence and unnecessarily downgrade AUTO to ASSIST.
    .filter((entry) => !(entry.intent === 'PRODUCT_QUERY' && explicitInventory && !explicitProductQuery))
    // “多久发货” asks for the Store shipping policy, not the buyer's order
    // logistics. A model-added order task would force an unrelated order
    // clarification and hide the grounded policy answer.
    .filter((entry) => !(intentFamily(entry.intent) === 'ORDER' && explicitShipping && !explicitOrder))
    .map(cloneTask);
  for (const explicit of explicitTasks) {
    const existing = merged.find((entry) => intentFamily(entry.intent) === intentFamily(explicit.intent));
    if (existing) {
      existing.intent = explicit.intent;
      existing.riskLevel = maxRisk(existing.riskLevel, explicit.riskLevel);
      // The model may name the right intent while omitting the live resolver
      // and tool requirements.  Lexical supplementation never supplies a
      // business fact, but its minimum constraints must remain authoritative
      // so inventory/order questions cannot fall back to an ungrounded model
      // answer merely because a structured field was left empty.
      existing.requiredContext = unique([...existing.requiredContext, ...explicit.requiredContext]);
      existing.requiredKnowledge = unique([...(existing.requiredKnowledge ?? []), ...(explicit.requiredKnowledge ?? [])]);
      existing.requiredTools = unique([...existing.requiredTools, ...explicit.requiredTools]);
      continue;
    }
    merged.push(explicit);
  }
  return (merged.length ? merged : modelTasks.map(cloneTask)).slice(0, 4);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function task(
  intent: string,
  riskLevel: ExplicitIntentTask['riskLevel'],
  requiredContext: string[],
  requiredKnowledge: Array<'STORE' | 'PRODUCT'>,
  requiredTools: string[],
): ExplicitIntentTask {
  return {
    intent,
    riskLevel,
    requiredContext,
    ...(requiredKnowledge.length ? { requiredKnowledge } : {}),
    requiredTools,
  };
}

function cloneTask(value: ExplicitIntentTask): ExplicitIntentTask {
  return {
    ...value,
    requiredContext: [...value.requiredContext],
    requiredKnowledge: [...(value.requiredKnowledge ?? [])],
    requiredTools: [...value.requiredTools],
  };
}

function maxRisk(left: ExplicitIntentTask['riskLevel'], right: ExplicitIntentTask['riskLevel']): ExplicitIntentTask['riskLevel'] {
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function intentFamily(intent: string): string {
  if (/(?:^|_)(?:INVENTORY|STOCK)(?:_|$)/i.test(intent) || /SKU_INVENTORY/i.test(intent)) return 'INVENTORY';
  if (/(?:ORDER|LOGISTICS|SHIPMENT)/i.test(intent)) return 'ORDER';
  if (/REFUND/i.test(intent)) return 'REFUND';
  if (/PRODUCT_(?:QUERY|DETAIL)|SPECIFICATION|MATERIAL|CARE/i.test(intent)) return 'PRODUCT_QUERY';
  return intent;
}
