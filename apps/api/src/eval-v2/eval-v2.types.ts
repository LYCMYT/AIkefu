export type EvalCaseStatus = 'PASS' | 'FAIL' | 'BLOCKED_UNSUPPORTED' | 'BLOCKED_ENVIRONMENT' | 'NOT_RUN';
export type EvalProviderMode = 'OFFLINE_FIXTURE' | 'REAL_PROVIDER';
export type EvalGateSeverity = 'STANDARD' | 'SAFETY_BLOCKER';

export const RETRIEVAL_CSV_HEADERS = [
  'ID',
  'Shop',
  'Product_Context',
  'Query',
  'Expected_Knowledge_Concept',
  'Expected_Scope',
  'Positive',
  'Max_Rank',
  'Forbidden_Scope_or_Concept',
  'Notes',
] as const;

export const PRODUCT_CSV_HEADERS = [
  'ID',
  'Domain',
  'User_Input',
  'Context_Setup',
  'Expected_Task_Concept',
  'Expected_Mode',
  'Expected_Evidence_or_Source',
  'Expected_Tool_or_Task_Assertion',
  'Required_Facts',
  'Forbidden_Claims',
  'Metric_Tags',
  'Hard_Blocker',
  'Notes',
] as const;

export type RetrievalCsvRow = Record<(typeof RETRIEVAL_CSV_HEADERS)[number], string>;
export type ProductCsvRow = Record<(typeof PRODUCT_CSV_HEADERS)[number], string>;

export type EvalV2Aliases = {
  shops: Record<string, string>;
  products: Record<string, string>;
  tasks: Record<string, string[]>;
};

export type RetrievalExpectationV2 =
  | {
      kind: 'POSITIVE';
      expectedKnowledgeKeys: string[];
      expectedScope: 'STORE' | 'PRODUCT';
      maxRank: 1 | 3;
      forbiddenKnowledgeKeys: string[];
      forbiddenShopKeys: string[];
      forbiddenProductKeys: string[];
    }
  | {
      kind: 'NO_EVIDENCE';
      allowedStatuses: Array<'NO_EVIDENCE' | 'AMBIGUOUS' | 'DYNAMIC_FACT_REQUIRED'>;
      forbiddenKnowledgeKeys: string[];
      forbiddenShopKeys: string[];
      forbiddenProductKeys: string[];
    }
  | {
      kind: 'CONFLICT';
      conflictFixtureKey: string;
      expectedStatus: 'CONFLICTED';
    };

export type RetrievalEvalCaseV2 = {
  id: string;
  sourceRow: number;
  shopKey: string;
  productKey: string | null;
  query: string;
  concept: string;
  expectation: RetrievalExpectationV2;
  notes: string[];
};

export type EvalMessageV2 =
  | { type: 'TEXT'; text: string; turn: number }
  | { type: 'GOODS_CARD'; productKey: string; turn: number }
  | { type: 'ORDER_CARD'; orderKey: string; turn: number }
  | { type: 'IMAGE'; fixture: string; turn: number }
  | { type: 'EDIT_PREVIOUS'; text: string; turn: number }
  | { type: 'RECALL_PREVIOUS'; turn: number };

export type EvalSetupActionV2 =
  | { type: 'SET_SHOP_AI_MODE'; mode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY' }
  | { type: 'SELECT_PRODUCT'; productKey: string }
  | { type: 'SELECT_ORDER'; orderKey: string }
  | { type: 'SET_HUMAN_ACTIVE'; value: boolean }
  | { type: 'ACTIVATE_CONFLICT'; fixtureKey: string }
  | { type: 'CHANGE_INVENTORY_DURING_GENERATION'; externalSkuId: string; from: number; to: number }
  | { type: 'CHANGE_ORDER_DURING_GENERATION'; orderKey: string; toStatus: string }
  | { type: 'CHANGE_LOGISTICS_DURING_GENERATION'; orderKey: string; toNode: string }
  | { type: 'SET_PROVIDER_FAULT'; primary: string; fallback: string }
  | { type: 'RESTART_DURING'; phase: 'GENERATING' | 'SEND_OUTBOX_SENDING' }
  | { type: 'SEND_DUPLICATE_TRANSPORT_MESSAGE' }
  | { type: 'SEND_OUT_OF_ORDER_TRANSPORT_MESSAGES' };

export type ProductEvalCaseV2 = {
  id: string;
  sourceRow: number;
  domain: string;
  shopKey: string;
  buyerKey: string;
  messages: EvalMessageV2[];
  setup: EvalSetupActionV2[];
  expected: {
    tasks: string[];
    mode: 'AUTO' | 'ASSIST' | 'MANUAL';
    terminalStatuses: string[];
    outputSources: Array<'SENT_MESSAGE' | 'SEND_OUTBOX' | 'DRAFT' | 'TASK_RESULT' | 'NONE'>;
    evidence: {
      required: boolean;
      scopes: Array<'STORE' | 'PRODUCT'>;
      knowledgeKeys: string[];
      productKeys: string[];
    };
    tools: string[];
    requiredFacts: string[];
    forbiddenClaims: string[];
    maxClarificationQuestions: number | null;
    autoSend: boolean | null;
    oldReplyMustNotBeSent: boolean;
  };
  gateSeverity: EvalGateSeverity;
  execution: {
    kind: 'REPLY_RUNTIME' | 'RELIABILITY_HARNESS';
    requiredCapabilities: string[];
  };
  metricTags: string[];
  notes: string[];
};

export type RetrievalOverrideV2 = {
  expectedKnowledgeKeys?: string[];
  forbiddenKnowledgeKeys?: string[];
  forbiddenShopKeys?: string[];
  forbiddenProductKeys?: string[];
  conflictFixtureKey?: string;
  allowedStatuses?: Array<'NO_EVIDENCE' | 'AMBIGUOUS' | 'DYNAMIC_FACT_REQUIRED'>;
};

export type ProductOverrideV2 = {
  shopKey?: string;
  buyerKey?: string;
  messages?: EvalMessageV2[];
  setup?: EvalSetupActionV2[];
  expectedTasks?: string[];
  terminalStatuses?: string[];
  outputSources?: Array<'SENT_MESSAGE' | 'SEND_OUTBOX' | 'DRAFT' | 'TASK_RESULT' | 'NONE'>;
  evidence?: ProductEvalCaseV2['expected']['evidence'];
  tools?: string[];
  maxClarificationQuestions?: number | null;
  autoSend?: boolean | null;
  oldReplyMustNotBeSent?: boolean;
  executionKind?: 'REPLY_RUNTIME' | 'RELIABILITY_HARNESS';
  requiredCapabilities?: string[];
  notes?: string[];
};

export type EvalV2Overrides = {
  retrieval: Record<string, RetrievalOverrideV2>;
  product: Record<string, ProductOverrideV2>;
};

export type EvalV2SourceBundle = {
  paths: { retrieval: string; product: string };
  retrieval: RetrievalCsvRow[];
  product: ProductCsvRow[];
};

export type EvalV2SeedCatalog = {
  shops: Array<{ key: string }>;
  buyers: Array<{ key: string }>;
  products: Array<{ key: string; shopKey: string; skus?: Array<{ externalSkuId: string; inventory: number }> }>;
  orders: Array<{ key: string; shopKey: string; buyerKey: string; productKey: string }>;
  knowledge: Array<{ key: string; shopKey: string; productKey: string | null; scope: 'STORE' | 'PRODUCT' }>;
  knowledgeConflicts?: Array<{ key: string; shopKey: string }>;
};

export type CompileEvalV2Input = {
  source: EvalV2SourceBundle;
  aliases: EvalV2Aliases;
  overrides: EvalV2Overrides;
  seed: EvalV2SeedCatalog;
  sourceHashes: { retrieval: string; product: string };
};

export type EvalV2CanonicalSuite<T> = {
  schemaVersion: '2.0';
  source: { path: string; sha256: string; caseCount: number };
  cases: T[];
};

export type EvalV2CanonicalBundle = {
  schemaVersion: '2.0';
  retrieval: EvalV2CanonicalSuite<RetrievalEvalCaseV2>;
  product: EvalV2CanonicalSuite<ProductEvalCaseV2>;
};
