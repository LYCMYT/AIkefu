import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { loadEvalV2Sources } from './eval-v2.loader';
import type {
  CompileEvalV2Input,
  EvalMessageV2,
  EvalSetupActionV2,
  EvalV2Aliases,
  EvalV2CanonicalBundle,
  EvalV2Overrides,
  EvalV2SeedCatalog,
  ProductCsvRow,
  ProductEvalCaseV2,
  ProductOverrideV2,
  RetrievalCsvRow,
  RetrievalEvalCaseV2,
} from './eval-v2.types';

const CANONICAL_INTENTS = new Set([
  'FAQ_QUERY', 'PRODUCT_QUERY', 'INVENTORY_QUERY', 'SIZE_RECOMMENDATION', 'SHIPPING_POLICY',
  'ORDER_QUERY', 'LOGISTICS_QUERY', 'AFTER_SALES_QUERY', 'REFUND_REQUEST', 'EXCHANGE_REQUEST',
  'PRODUCT_RECOMMENDATION', 'HUMAN_REQUEST', 'COMPLAINT', 'UNKNOWN',
]);

export function loadEvalV2RepositoryInput(repoRoot: string): CompileEvalV2Input {
  const source = loadEvalV2Sources(repoRoot);
  const aliasesPath = resolve(repoRoot, 'evals/mappings/eval-v2-aliases.json');
  const overridesPath = resolve(repoRoot, 'evals/mappings/eval-v2-overrides.json');
  const seedPath = resolve(repoRoot, 'seed/seed-data.json');
  return {
    source,
    aliases: readJson<EvalV2Aliases>(aliasesPath),
    overrides: readJson<EvalV2Overrides>(overridesPath),
    seed: readJson<EvalV2SeedCatalog>(seedPath),
    sourceHashes: {
      retrieval: sha256(readFileSync(source.paths.retrieval)),
      product: sha256(readFileSync(source.paths.product)),
    },
  };
}

export function compileEvalV2FromRepo(repoRoot: string): EvalV2CanonicalBundle {
  return compileEvalV2(loadEvalV2RepositoryInput(repoRoot));
}

export function compileEvalV2(input: CompileEvalV2Input): EvalV2CanonicalBundle {
  assertOverrideIds(input.overrides.retrieval, input.source.retrieval, 'retrieval');
  assertOverrideIds(input.overrides.product, input.source.product, 'product');
  validateAliasTargets(input);

  const retrievalCases = input.source.retrieval.map((row, index) => compileRetrievalRow(row, index + 2, input));
  const productCases = input.source.product.map((row, index) => compileProductRow(row, index + 2, input));
  assertIds(retrievalCases.map(({ id }) => id), Array.from({ length: 40 }, (_, index) => `Q${String(index + 1).padStart(2, '0')}`), 'RETRIEVAL');
  assertIds(productCases.map(({ id }) => id), input.source.product.map(({ ID }) => ID), 'PRODUCT');
  const allIds = [...retrievalCases, ...productCases].map(({ id }) => id);
  if (new Set(allIds).size !== allIds.length) throw new Error('EVAL_SOURCE_ID_COLLISION');

  return {
    schemaVersion: '2.0',
    retrieval: {
      schemaVersion: '2.0',
      source: { path: normalizePath(input.source.paths.retrieval), sha256: input.sourceHashes.retrieval, caseCount: retrievalCases.length },
      cases: retrievalCases,
    },
    product: {
      schemaVersion: '2.0',
      source: { path: normalizePath(input.source.paths.product), sha256: input.sourceHashes.product, caseCount: productCases.length },
      cases: productCases,
    },
  };
}

function compileRetrievalRow(row: RetrievalCsvRow, sourceRow: number, input: CompileEvalV2Input): RetrievalEvalCaseV2 {
  const id = row.ID.trim();
  const shopKey = requireAlias(input.aliases.shops, row.Shop.trim(), `SHOP_ALIAS_UNMAPPED:${id}`);
  const productAlias = row.Product_Context.trim();
  const productKey = productAlias === '-' ? null : requireAlias(input.aliases.products, productAlias, `PRODUCT_ALIAS_UNMAPPED:${id}`);
  const positive = row.Positive.trim();
  const maxRank = Number(row.Max_Rank);
  const expectedScope = row.Expected_Scope.trim();
  const override = input.overrides.retrieval[id] ?? {};
  validateForbiddenScopeKeys(id, override.forbiddenShopKeys ?? [], override.forbiddenProductKeys ?? [], input.seed);

  if (!['YES', 'NO'].includes(positive)) throw new Error(`RETRIEVAL_POSITIVE_INVALID:${id}:${positive}`);
  if (positive === 'YES' && ![1, 3].includes(maxRank)) throw new Error(`RETRIEVAL_MAX_RANK_INVALID:${id}:${maxRank}`);
  if (positive === 'NO' && maxRank !== 0) throw new Error(`RETRIEVAL_NEGATIVE_RANK_NONZERO:${id}:${maxRank}`);
  if (positive === 'NO' && expectedScope !== 'NONE') throw new Error(`RETRIEVAL_NEGATIVE_SCOPE_INVALID:${id}:${expectedScope}`);
  if (positive === 'YES' && !['STORE', 'PRODUCT'].includes(expectedScope)) throw new Error(`RETRIEVAL_SCOPE_INVALID:${id}:${expectedScope}`);
  if (expectedScope === 'PRODUCT' && !productKey) throw new Error(`RETRIEVAL_PRODUCT_REQUIRED:${id}`);

  const common = {
    id,
    sourceRow,
    shopKey,
    productKey,
    query: row.Query,
    concept: row.Expected_Knowledge_Concept,
    notes: compact([row.Notes]),
  };
  if (id === 'Q37' || override.conflictFixtureKey) {
    const conflictFixtureKey = override.conflictFixtureKey;
    if (!conflictFixtureKey) throw new Error(`CONFLICT_OVERRIDE_REQUIRED:${id}`);
    const conflict = input.seed.knowledgeConflicts?.find(({ key }) => key === conflictFixtureKey);
    if (!conflict || conflict.shopKey !== shopKey) throw new Error(`CONFLICT_FIXTURE_INVALID:${id}:${conflictFixtureKey}`);
    return { ...common, expectation: { kind: 'CONFLICT', conflictFixtureKey, expectedStatus: 'CONFLICTED' } };
  }
  if (positive === 'NO') {
    return {
      ...common,
      expectation: {
        kind: 'NO_EVIDENCE',
        allowedStatuses: override.allowedStatuses ?? ['NO_EVIDENCE', 'AMBIGUOUS', 'DYNAMIC_FACT_REQUIRED'],
        forbiddenKnowledgeKeys: override.forbiddenKnowledgeKeys ?? [],
        forbiddenShopKeys: override.forbiddenShopKeys ?? [],
        forbiddenProductKeys: override.forbiddenProductKeys ?? [],
      },
    };
  }
  const expectedKnowledgeKeys = override.expectedKnowledgeKeys ?? [];
  if (expectedKnowledgeKeys.length === 0) throw new Error(`RETRIEVAL_KNOWLEDGE_OVERRIDE_REQUIRED:${id}`);
  const forbiddenKnowledgeKeys = override.forbiddenKnowledgeKeys ?? [];
  validateKnowledgeKeys(id, shopKey, productKey, expectedScope as 'STORE' | 'PRODUCT', expectedKnowledgeKeys, input.seed);
  validateKnownKnowledgeKeys(id, forbiddenKnowledgeKeys, input.seed);
  return {
    ...common,
    expectation: {
      kind: 'POSITIVE',
      expectedKnowledgeKeys,
      expectedScope: expectedScope as 'STORE' | 'PRODUCT',
      maxRank: maxRank as 1 | 3,
      forbiddenKnowledgeKeys,
      forbiddenShopKeys: override.forbiddenShopKeys ?? [],
      forbiddenProductKeys: override.forbiddenProductKeys ?? [],
    },
  };
}

function compileProductRow(row: ProductCsvRow, sourceRow: number, input: CompileEvalV2Input): ProductEvalCaseV2 {
  const id = row.ID.trim();
  const override: ProductOverrideV2 = input.overrides.product[id] ?? {};
  const tasks = override.expectedTasks ?? resolveTaskAlias(id, row.Expected_Task_Concept, input.aliases);
  const mode = row.Expected_Mode.trim() as ProductEvalCaseV2['expected']['mode'];
  if (!['AUTO', 'ASSIST', 'MANUAL'].includes(mode)) throw new Error(`PRODUCT_MODE_INVALID:${id}:${mode}`);
  tasks.forEach((task) => {
    if (!CANONICAL_INTENTS.has(task)) throw new Error(`TASK_TARGET_INVALID:${id}:${task}`);
  });

  const shopKey = override.shopKey ?? 'shop_mia_fashion';
  const buyerKey = override.buyerKey ?? 'buyer_001';
  const messages = override.messages ?? deriveSimpleMessages(id, row.User_Input);
  const setup = override.setup ?? defaultSetup(mode);
  const evidence = override.evidence ?? deriveEvidence(row.Expected_Evidence_or_Source);
  const tools = override.tools ?? deriveTools(tasks, row.Expected_Evidence_or_Source);
  const terminalStatuses = override.terminalStatuses ?? defaultTerminalStatuses(mode);
  const outputSources = override.outputSources ?? defaultOutputSources(mode);
  const executionKind = override.executionKind ?? (id.startsWith('E') ? 'RELIABILITY_HARNESS' : 'REPLY_RUNTIME');
  const requiredCapabilities = override.requiredCapabilities ?? deriveCapabilities(messages, setup, executionKind);

  validateProductReferences({ id, shopKey, buyerKey, messages, setup, evidence }, input.seed);
  if (evidence.required && evidence.knowledgeKeys.length === 0) throw new Error(`PRODUCT_KNOWLEDGE_OVERRIDE_REQUIRED:${id}`);
  return {
    id,
    sourceRow,
    domain: row.Domain,
    shopKey,
    buyerKey,
    messages,
    setup,
    expected: {
      tasks,
      mode,
      terminalStatuses,
      outputSources,
      evidence,
      tools,
      requiredFacts: splitPipe(row.Required_Facts),
      forbiddenClaims: splitPipe(row.Forbidden_Claims),
      maxClarificationQuestions: override.maxClarificationQuestions ?? null,
      autoSend: override.autoSend ?? (mode === 'AUTO' ? true : mode === 'MANUAL' ? false : null),
      oldReplyMustNotBeSent: override.oldReplyMustNotBeSent ?? false,
    },
    gateSeverity: row.Hard_Blocker.trim() === 'YES' ? 'SAFETY_BLOCKER' : 'STANDARD',
    execution: { kind: executionKind, requiredCapabilities },
    metricTags: splitPipe(row.Metric_Tags),
    notes: compact([row.Notes, ...(override.notes ?? [])]),
  };
}

function resolveTaskAlias(id: string, source: string, aliases: EvalV2Aliases): string[] {
  const exact = aliases.tasks[source.trim()];
  if (!exact || exact.length === 0) throw new Error(`TASK_ALIAS_UNMAPPED:${id}:${source.trim()}`);
  return [...exact];
}

function deriveSimpleMessages(id: string, input: string): EvalMessageV2[] {
  if (/[→/]/u.test(input) || /(?:商品卡|订单卡|上传.*图片|编辑上一条|撤回)/u.test(input)) {
    throw new Error(`PRODUCT_MESSAGE_OVERRIDE_REQUIRED:${id}`);
  }
  return [{ type: 'TEXT', text: input, turn: 1 }];
}

function deriveEvidence(source: string): ProductEvalCaseV2['expected']['evidence'] {
  const scopes: Array<'STORE' | 'PRODUCT'> = [];
  if (/^(?:MIA |PIXEL )?STORE(?::|售后|\+|\s|$)|\+STORE(?:[:+\s]|$)/u.test(source)) scopes.push('STORE');
  if (/^PRODUCT(?::|\sA|\+)|\+PRODUCT(?:[:+\s]|$)/u.test(source)) scopes.push('PRODUCT');
  return { required: scopes.length > 0, scopes, knowledgeKeys: [], productKeys: [] };
}

function deriveTools(tasks: string[], source: string): string[] {
  const tools = new Set<string>();
  if (tasks.includes('INVENTORY_QUERY') || /LIVE_SKU/u.test(source)) tools.add('GET_INVENTORY');
  if (tasks.includes('ORDER_QUERY') || /LIVE_ORDER/u.test(source)) tools.add('GET_ORDER');
  if (tasks.includes('LOGISTICS_QUERY') || /LOGISTICS/u.test(source)) tools.add('GET_LOGISTICS');
  if (/LIVE_PRODUCT_CONTEXT/u.test(source)) tools.add('GET_PRODUCT');
  if (tasks.some((task) => ['HUMAN_REQUEST', 'COMPLAINT', 'REFUND_REQUEST', 'EXCHANGE_REQUEST'].includes(task))) tools.add('TRANSFER_HUMAN');
  return [...tools];
}

function defaultSetup(mode: ProductEvalCaseV2['expected']['mode']): EvalSetupActionV2[] {
  return [{ type: 'SET_SHOP_AI_MODE', mode: mode === 'AUTO' ? 'AUTO_ALLOWED' : mode === 'ASSIST' ? 'ASSIST_ONLY' : 'AUTO_ALLOWED' }];
}

function defaultTerminalStatuses(mode: ProductEvalCaseV2['expected']['mode']): string[] {
  return mode === 'AUTO' ? ['SENT'] : mode === 'ASSIST' ? ['WAITING_HUMAN', 'READY_TO_SEND'] : ['WAITING_HUMAN', 'STALE'];
}

function defaultOutputSources(mode: ProductEvalCaseV2['expected']['mode']): ProductEvalCaseV2['expected']['outputSources'] {
  return mode === 'AUTO' ? ['SENT_MESSAGE', 'SEND_OUTBOX'] : mode === 'ASSIST' ? ['DRAFT'] : ['DRAFT', 'NONE'];
}

function deriveCapabilities(messages: EvalMessageV2[], setup: EvalSetupActionV2[], kind: ProductEvalCaseV2['execution']['kind']): string[] {
  const capabilities = new Set<string>(['TEXT_TURN']);
  const byMessage: Record<EvalMessageV2['type'], string> = {
    TEXT: 'TEXT_TURN', GOODS_CARD: 'GOODS_CARD', ORDER_CARD: 'ORDER_CARD', IMAGE: 'IMAGE_FIXTURE',
    EDIT_PREVIOUS: 'EDIT_PREVIOUS', RECALL_PREVIOUS: 'RECALL_PREVIOUS',
  };
  messages.forEach((message) => capabilities.add(byMessage[message.type]));
  setup.forEach((action) => {
    if (action.type === 'SET_HUMAN_ACTIVE') capabilities.add('HUMAN_ACTIVE');
    if (action.type === 'ACTIVATE_CONFLICT') capabilities.add('KNOWLEDGE_CONFLICT');
    if (action.type === 'CHANGE_INVENTORY_DURING_GENERATION') capabilities.add('INVENTORY_CHANGE_BARRIER');
    if (action.type === 'CHANGE_ORDER_DURING_GENERATION') capabilities.add('ORDER_CHANGE_BARRIER');
    if (action.type === 'CHANGE_LOGISTICS_DURING_GENERATION') capabilities.add('LOGISTICS_CHANGE_BARRIER');
    if (action.type === 'SET_PROVIDER_FAULT') capabilities.add('PROVIDER_FAULT');
    if (action.type === 'RESTART_DURING') capabilities.add(action.phase === 'GENERATING' ? 'RESTART_GENERATING' : 'RESTART_SENDING');
    if (action.type === 'SEND_DUPLICATE_TRANSPORT_MESSAGE') capabilities.add('DUPLICATE_TRANSPORT');
    if (action.type === 'SEND_OUT_OF_ORDER_TRANSPORT_MESSAGES') capabilities.add('OUT_OF_ORDER_TRANSPORT');
  });
  if (kind === 'RELIABILITY_HARNESS') capabilities.add('RELIABILITY_HARNESS');
  return [...capabilities];
}

function validateProductReferences(
  value: Pick<ProductEvalCaseV2, 'id' | 'shopKey' | 'buyerKey' | 'messages' | 'setup'> & { evidence: ProductEvalCaseV2['expected']['evidence'] },
  seed: EvalV2SeedCatalog,
): void {
  if (!seed.shops.some(({ key }) => key === value.shopKey)) throw new Error(`SHOP_KEY_INVALID:${value.id}:${value.shopKey}`);
  if (!seed.buyers.some(({ key }) => key === value.buyerKey)) throw new Error(`BUYER_KEY_INVALID:${value.id}:${value.buyerKey}`);
  const productKeys = [
    ...value.messages.filter((entry): entry is Extract<EvalMessageV2, { type: 'GOODS_CARD' }> => entry.type === 'GOODS_CARD').map(({ productKey }) => productKey),
    ...value.setup.filter((entry): entry is Extract<EvalSetupActionV2, { type: 'SELECT_PRODUCT' }> => entry.type === 'SELECT_PRODUCT').map(({ productKey }) => productKey),
    ...value.evidence.productKeys,
  ];
  productKeys.forEach((key) => {
    const product = seed.products.find((entry) => entry.key === key);
    if (!product || product.shopKey !== value.shopKey) throw new Error(`PRODUCT_KEY_INVALID:${value.id}:${key}`);
  });
  const orderKeys = [
    ...value.messages.filter((entry): entry is Extract<EvalMessageV2, { type: 'ORDER_CARD' }> => entry.type === 'ORDER_CARD').map(({ orderKey }) => orderKey),
    ...value.setup.filter((entry): entry is Extract<EvalSetupActionV2, { type: 'SELECT_ORDER' }> => entry.type === 'SELECT_ORDER').map(({ orderKey }) => orderKey),
    ...value.setup.filter((entry): entry is Extract<EvalSetupActionV2, { type: 'CHANGE_ORDER_DURING_GENERATION' }> => entry.type === 'CHANGE_ORDER_DURING_GENERATION').map(({ orderKey }) => orderKey),
    ...value.setup.filter((entry): entry is Extract<EvalSetupActionV2, { type: 'CHANGE_LOGISTICS_DURING_GENERATION' }> => entry.type === 'CHANGE_LOGISTICS_DURING_GENERATION').map(({ orderKey }) => orderKey),
  ];
  orderKeys.forEach((key) => {
    const order = seed.orders.find((entry) => entry.key === key);
    if (!order || order.shopKey !== value.shopKey || order.buyerKey !== value.buyerKey) throw new Error(`ORDER_KEY_INVALID:${value.id}:${key}`);
  });
  value.setup
    .filter((entry): entry is Extract<EvalSetupActionV2, { type: 'CHANGE_INVENTORY_DURING_GENERATION' }> => entry.type === 'CHANGE_INVENTORY_DURING_GENERATION')
    .forEach(({ externalSkuId }) => {
      const owner = seed.products.find((product) => product.skus?.some((sku) => sku.externalSkuId === externalSkuId));
      if (!owner || owner.shopKey !== value.shopKey) throw new Error(`SKU_KEY_INVALID:${value.id}:${externalSkuId}`);
    });
  value.setup
    .filter((entry): entry is Extract<EvalSetupActionV2, { type: 'ACTIVATE_CONFLICT' }> => entry.type === 'ACTIVATE_CONFLICT')
    .forEach(({ fixtureKey }) => {
      const fixture = seed.knowledgeConflicts?.find((entry) => entry.key === fixtureKey);
      if (!fixture || fixture.shopKey !== value.shopKey) throw new Error(`CONFLICT_FIXTURE_INVALID:${value.id}:${fixtureKey}`);
    });
  validateKnowledgeKeysForProductCase(value.id, value.shopKey, value.evidence, seed);
}

function validateForbiddenScopeKeys(id: string, shopKeys: string[], productKeys: string[], seed: EvalV2SeedCatalog): void {
  shopKeys.forEach((key) => {
    if (!seed.shops.some((entry) => entry.key === key)) throw new Error(`FORBIDDEN_SHOP_KEY_INVALID:${id}:${key}`);
  });
  productKeys.forEach((key) => {
    if (!seed.products.some((entry) => entry.key === key)) throw new Error(`FORBIDDEN_PRODUCT_KEY_INVALID:${id}:${key}`);
  });
}

function validateKnowledgeKeysForProductCase(id: string, shopKey: string, evidence: ProductEvalCaseV2['expected']['evidence'], seed: EvalV2SeedCatalog): void {
  evidence.knowledgeKeys.forEach((key) => {
    const knowledge = seed.knowledge.find((entry) => entry.key === key);
    if (!knowledge || knowledge.shopKey !== shopKey || !evidence.scopes.includes(knowledge.scope)) throw new Error(`KNOWLEDGE_KEY_INVALID:${id}:${key}`);
    if (knowledge.scope === 'PRODUCT' && evidence.productKeys.length > 0 && (!knowledge.productKey || !evidence.productKeys.includes(knowledge.productKey))) {
      throw new Error(`KNOWLEDGE_PRODUCT_MISMATCH:${id}:${key}`);
    }
  });
}

function validateKnowledgeKeys(id: string, shopKey: string, productKey: string | null, scope: 'STORE' | 'PRODUCT', keys: string[], seed: EvalV2SeedCatalog): void {
  keys.forEach((key) => {
    const knowledge = seed.knowledge.find((entry) => entry.key === key);
    if (!knowledge || knowledge.shopKey !== shopKey || knowledge.scope !== scope || (scope === 'PRODUCT' && knowledge.productKey !== productKey)) {
      throw new Error(`KNOWLEDGE_KEY_INVALID:${id}:${key}`);
    }
  });
}

function validateKnownKnowledgeKeys(id: string, keys: string[], seed: EvalV2SeedCatalog): void {
  keys.forEach((key) => {
    if (!seed.knowledge.some((entry) => entry.key === key)) throw new Error(`FORBIDDEN_KNOWLEDGE_KEY_INVALID:${id}:${key}`);
  });
}

function validateAliasTargets(input: CompileEvalV2Input): void {
  Object.entries(input.aliases.shops).forEach(([alias, key]) => {
    if (!input.seed.shops.some((entry) => entry.key === key)) throw new Error(`SHOP_ALIAS_TARGET_INVALID:${alias}:${key}`);
  });
  Object.entries(input.aliases.products).forEach(([alias, key]) => {
    if (!input.seed.products.some((entry) => entry.key === key)) throw new Error(`PRODUCT_ALIAS_TARGET_INVALID:${alias}:${key}`);
  });
}

function assertOverrideIds<T extends { ID: string }>(overrides: Record<string, unknown>, source: T[], suite: string): void {
  const ids = new Set(source.map(({ ID }) => ID));
  Object.keys(overrides).forEach((id) => {
    if (!ids.has(id)) throw new Error(`OVERRIDE_SOURCE_ID_UNKNOWN:${suite}:${id}`);
  });
}

function assertIds(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`${label}_SOURCE_IDS_INVALID`);
  }
}

function requireAlias(values: Record<string, string>, alias: string, prefix: string): string {
  const resolved = values[alias];
  if (!resolved) throw new Error(`${prefix}:${alias}`);
  return resolved;
}

function splitPipe(value: string): string[] {
  return value.split('|').map((entry) => entry.trim()).filter(Boolean);
}

function compact(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function normalizePath(path: string): string {
  return basename(dirname(path)) + '/' + basename(path);
}

export function writeEvalV2CanonicalAtomically(
  bundle: EvalV2CanonicalBundle,
  paths: { retrieval: string; product: string },
): void {
  const nonce = `${process.pid}-${Date.now()}`;
  const entries = [
    { target: paths.retrieval, content: stableJson(bundle.retrieval) },
    { target: paths.product, content: stableJson(bundle.product) },
  ].map((entry) => ({ ...entry, temporary: `${entry.target}.${nonce}.tmp`, backup: `${entry.target}.${nonce}.bak` }));
  const backedUp: typeof entries = [];
  const installed: typeof entries = [];
  try {
    entries.forEach((entry) => writeSynced(entry.temporary, entry.content));
    entries.forEach((entry) => {
      if (existsSync(entry.target)) {
        renameSync(entry.target, entry.backup);
        backedUp.push(entry);
      }
    });
    entries.forEach((entry) => {
      renameSync(entry.temporary, entry.target);
      installed.push(entry);
    });
    backedUp.forEach((entry) => rmSync(entry.backup, { force: true }));
  } catch (error) {
    installed.forEach((entry) => rmSync(entry.target, { force: true }));
    backedUp.forEach((entry) => {
      if (existsSync(entry.backup)) renameSync(entry.backup, entry.target);
    });
    entries.forEach((entry) => rmSync(entry.temporary, { force: true }));
    throw error;
  }
}

function writeSynced(path: string, content: string): void {
  const descriptor = openSync(path, 'wx');
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
