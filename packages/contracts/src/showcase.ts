export type ShowcaseRunStatus =
  | 'NOT_STARTED'
  | 'PREPARING'
  | 'RUNNING'
  | 'WAITING_AI'
  | 'WAITING_HUMAN'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ShowcaseProviderMode = 'REAL' | 'OFFLINE' | 'UNAVAILABLE';
export type ShowcaseMultimodalMode = 'REAL' | 'FIXTURE';

export interface ShowcaseStep {
  actor: 'SYSTEM' | 'BUYER';
  action: string;
  [key: string]: unknown;
}

export interface ShowcaseScenario {
  id: string;
  order: number;
  title: string;
  shopKey: string;
  buyerKey: string;
  aiMode: 'AUTO_ALLOWED' | 'ASSIST_ONLY';
  objective: string;
  steps: ShowcaseStep[];
  expected: Record<string, unknown>;
}

export interface ShowcaseCatalog {
  version: string;
  providerMode: ShowcaseProviderMode;
  multimodalMode: ShowcaseMultimodalMode;
  resources: {
    shops: Array<{ key: string; name: string }>;
    buyers: Array<{ key: string; externalBuyerId: string }>;
    products: Array<{ key: string; externalProductId: string }>;
    orders: Array<{ key: string; externalOrderId: string }>;
  };
  scenarios: ShowcaseScenario[];
}
