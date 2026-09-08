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
  const promptAttack = /(?:忽略.{0,12}(?:规则|规定|指令)|系统提示词|developer\s*(?:message|prompt)|system\s*prompt|越狱|绕过.{0,8}(?:规则|限制))/iu.test(text);
  const unsupportedStoreQuestion = /(?:线下试穿|实体店|到店试)|(?:企业采购|一次买)\s*\d+\s*件.{0,8}(?:折扣|打几折)/iu.test(text);
  const afterSalesPolicy = /(?:支持|可以|能否|能不能|是否).{0,6}(?:7\s*天无理由|退货)|7\s*天无理由.{0,6}(?:吗|么|政策|条件)/iu.test(text);
  const orderCancellationStatus = /(?:订单|这单).{0,6}(?:取消了吗|是否取消|取消成功了吗|取消状态)/iu.test(text);
  const addressChange = /(?:改|修改|更换).{0,6}(?:收货)?地址|(?:收货)?地址.{0,6}(?:改|修改|更换)/iu.test(text);
  const shippingConflict = /发货问题.{0,12}冲突知识/iu.test(text);

  if (imageDamage) add(task('AFTER_SALES_QUERY', 'MEDIUM', ['ORDER'], [], ['GET_ORDER', 'GET_AFTER_SALES']));
  // A sanitized shipping label proves only that an order artifact is present.
  // Keep the conservative order-review path for the PII-bearing artifact and
  // also expose the logistics read implied by the sanitized label. Both remain
  // ASSIST-only because the image cannot uniquely bind an order by itself.
  if (imageShippingLabel) {
    add(task('ORDER_QUERY', 'MEDIUM', ['ORDER'], [], ['GET_ORDER', 'TRANSFER_HUMAN']));
    add(task('LOGISTICS_QUERY', 'MEDIUM', ['ORDER'], [], ['GET_ORDER', 'GET_LOGISTICS']));
  }
  if (/(?:库存|有货|还有|还剩|现货|缺货|售罄|(?:黑色|白色|红色|蓝色|绿色|灰色|紫色|奶油色).{0,10}(?:有吗|有么|有货|呢(?:[\s，。！？?!,.]*$)))/iu.test(text)) {
    add(task('INVENTORY_QUERY', 'LOW', ['PRODUCT', 'SKU'], [], ['GET_INVENTORY']));
  }
  if (/(?:尺码|尺寸|大小|合身|身高|体重|公斤|kg|(?:^|[\s，,])(?:XXL|XL|XS|L|M|S)\s*(?:呢|多大|适合|怎么选|推荐|穿|吗|？|\?|$))/iu.test(text)) {
    add(task('SIZE_RECOMMENDATION', 'LOW', ['PRODUCT', 'SKU', 'CUSTOMER_MEMORY'], ['STORE', 'PRODUCT'], ['GET_PRODUCT']));
  }
  const shippingPolicy = /(?:多久|几天|多长时间|什么时候).{0,4}发(?:货|出)?|发(?:货|出).{0,4}(?:多久|几天|多长时间)|发什么快递|支持指定快递|包邮|运费险|偏远地区|新疆|西藏/iu.test(text)
    || /(?:保证|确保|能否).{0,10}(?:周[一二三四五六日天]|今天|明天|后天|\d+[号日]).{0,6}(?:送到|到货)/iu.test(text)
    || shippingConflict;
  if (shippingPolicy) {
    add(task('SHIPPING_POLICY', shippingConflict ? 'HIGH' : 'LOW', [], ['STORE'], shippingConflict ? ['TRANSFER_HUMAN'] : []));
  }
  if (!imageShippingLabel && /(?:物流|快递.{0,8}(?:没动|到哪|进度|信息)|订单.{0,8}(?:到哪|怎么还没到)|(?:昨天|之前).{0,4}(?:那|这)?单(?:呢|怎么样|到哪)|到哪了|什么时候到)/iu.test(text)) {
    add(task('LOGISTICS_QUERY', 'LOW', ['ORDER'], [], ['GET_ORDER', 'GET_LOGISTICS']));
  } else if (addressChange) {
    add(task('ORDER_QUERY', 'MEDIUM', ['ORDER'], ['STORE'], ['GET_ORDER', 'TRANSFER_HUMAN']));
  } else if (/(?:发货了吗|是否发货|订单状态|这单|订单取消了吗|是否取消|(?:再)?看(?:看)?我?(?:昨天|之前)?的?订单)/iu.test(text) || orderCancellationStatus) {
    add(task('ORDER_QUERY', 'LOW', ['ORDER'], [], ['GET_ORDER']));
  }
  if (/(?:预算.{0,12}(?:推荐|想要|键盘|商品)|推荐.{0,8}(?:商品|键盘|衣服)|喜欢.{0,12}(?:版型|键盘|商品)|想要.{0,12}(?:安静|静音|轻便|宽松).{0,8}(?:键盘|商品|衣服))/iu.test(text)) {
    add(task('PRODUCT_RECOMMENDATION', 'LOW', [], [], ['GET_PRODUCT']));
  } else if (/(?:烘干|水洗|怎么洗|洗涤|材质|面料|版型|偏大|偏小|防水|支持\s*(?:(?:什么|哪些).{0,4}系统|mac|macos|windows|蓝牙)|适合.{0,4}(?:冬天|夏天|春秋)|还能买吗|可以买吗|多少钱|价格|商品.{0,6}(?:特点|介绍|功能)|连接方式|介绍一下|什么功能|参数|(?:这?两个|哪个).{0,8}(?:更轻|更重|区别|差异|对比|比较))/iu.test(text)) {
    add(task('PRODUCT_QUERY', 'LOW', ['PRODUCT'], ['PRODUCT'], ['GET_PRODUCT']));
  }
  if (afterSalesPolicy) {
    add(task('AFTER_SALES_QUERY', 'LOW', [], ['STORE'], []));
  }
  if (/(?:开发票|发票|营业时间)/iu.test(text)) {
    add(task('FAQ_QUERY', 'LOW', [], ['STORE'], []));
  }
  if (unsupportedStoreQuestion) {
    add(task('UNKNOWN', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  if (/(?:收到|到货|衣服|商品).{0,10}(?:破了|破损|损坏|坏了)/iu.test(text)) {
    add(task('AFTER_SALES_QUERY', 'HIGH', ['ORDER'], [], ['TRANSFER_HUMAN']));
  }
  if (/(?:投诉|举报|差评)/iu.test(text)) {
    add(task('COMPLAINT', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  const transactionalRequest = /(?:退款|退钱|退货|取消订单)/iu.test(text) && !afterSalesPolicy && !orderCancellationStatus;
  if (transactionalRequest) {
    add(task('REFUND_REQUEST', 'HIGH', ['ORDER'], ['STORE'], ['GET_ORDER', 'TRANSFER_HUMAN']));
  }
  if (/(?:人工|真人客服|转客服)/iu.test(text)) {
    add(task('HUMAN_REQUEST', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  if (promptAttack && !transactionalRequest) {
    add(task('UNKNOWN', 'HIGH', [], [], ['TRANSFER_HUMAN']));
  }
  return limitTasksWithSafetyPriority(tasks);
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
  const explicitOrderIntents = new Set(explicitTasks
    .filter((entry) => intentFamily(entry.intent) === 'ORDER')
    .map((entry) => entry.intent));
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
    // ORDER_QUERY and LOGISTICS_QUERY share context but represent different
    // reads. When deterministic inference names one or both explicitly, remove
    // only conflicting model guesses instead of collapsing the two tasks.
    .filter((entry) => intentFamily(entry.intent) !== 'ORDER' || explicitOrderIntents.size === 0 || explicitOrderIntents.has(entry.intent))
    .map(cloneTask);
  for (const explicit of explicitTasks) {
    const family = intentFamily(explicit.intent);
    const existing = merged.find((entry) => entry.intent === explicit.intent
      || (family !== 'ORDER' && intentFamily(entry.intent) === family));
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
  return limitTasksWithSafetyPriority(merged.length ? merged : modelTasks.map(cloneTask));
}

/**
 * The bounded task bundle must never discard an explicit safety escalation.
 * Keep the original conversational order among retained tasks, but reserve
 * capacity for HIGH-risk or human-transfer tasks before filling remaining
 * slots with lower-risk reads.
 */
function limitTasksWithSafetyPriority(tasks: readonly ExplicitIntentTask[]): ExplicitIntentTask[] {
  const limit = 4;
  if (tasks.length <= limit) return [...tasks];
  const safetyIndexes = tasks
    .map((entry, index) => ({ index, priority: safetyTaskPriority(entry) }))
    .filter((entry) => entry.priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map((entry) => entry.index);
  const selected = new Set(safetyIndexes.slice(0, limit));
  for (let index = 0; index < tasks.length && selected.size < limit; index += 1) selected.add(index);
  return [...selected].sort((left, right) => left - right).map((index) => tasks[index]!);
}

function safetyTaskPriority(task: ExplicitIntentTask): number {
  if (task.intent === 'COMPLAINT') return 300;
  if (task.intent === 'HUMAN_REQUEST') return 250;
  if (task.intent === 'REFUND_REQUEST') return 200;
  if (task.riskLevel === 'HIGH') return 100;
  if (task.requiredTools.includes('TRANSFER_HUMAN')) return 50;
  return 0;
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
