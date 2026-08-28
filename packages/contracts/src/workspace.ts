/** An ISO-8601 timestamp serialized at the HTTP/WebSocket boundary. */
export type IsoDateTime = string;

export type WorkspaceStatus = 'ACTIVE' | 'EXPIRED' | 'DELETED';

export type ImplementationPhase =
  | 'PHASE_01_FOUNDATION'
  | 'PHASE_02_MESSAGE_WORKBENCH'
  | 'PHASE_03_KNOWLEDGE_AI'
  | 'PHASE_04_CONVERSATION_RELIABILITY';

export interface Workspace {
  id: string;
  status: WorkspaceStatus;
  tenantId?: string;
  createdAt?: IsoDateTime;
  lastAccessedAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export interface Tenant {
  id: string;
  workspaceId: string;
  name: string;
}

/**
 * Returned once a new anonymous demo workspace has been created.
 * The clear-text token belongs at the client boundary; persistence uses only
 * the hash produced by @ai-customer-service/core.
 */
export interface WorkspaceSession {
  workspace: Workspace;
  tenant: Tenant;
  token: string;
}

export type ShopAIMode = 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';

export type ShopConnectionState =
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'RECONCILING'
  | 'DEGRADED'
  | 'DISCONNECTED';

export interface Shop {
  id: string;
  /** Server-side repository projections include these scope fields. */
  workspaceId?: string;
  tenantId?: string;
  name: string;
  platform: 'DOUYIN_DEMO' | (string & {});
  externalShopId?: string;
  aiMode: ShopAIMode;
  connectionState: ShopConnectionState;
  syncComplete: boolean;
}

export type DemoShopTemplateKey = 'FASHION_DEMO' | 'TECH_DEMO';

export interface CreateShopInput {
  /** The demo transport is deliberately the only supported V1 platform. */
  platform: 'DOUYIN_DEMO';
  templateKey: DemoShopTemplateKey;
  name?: string;
  externalShopId?: string;
  /** Omitted values start at the safer ASSIST_ONLY ceiling. */
  aiMode?: ShopAIMode;
}

export interface UpdateShopAiModeInput {
  mode: ShopAIMode;
}

export interface SeedCounts {
  shops: number;
  buyers: number;
  products: number;
  orders: number;
  knowledge: number;
  workflows: number;
  /** The frozen PRD requires seeded eval cases but does not freeze a count. */
  evalCases?: number;
}

export interface SeedSnapshot {
  version?: string;
  seededAt?: IsoDateTime;
  status: 'READY';
  counts: SeedCounts;
}

export interface FeatureFlags {
  mockDouyinOnly: true;
  developerTraceDefault: false;
}

export interface Bootstrap {
  workspace: Workspace;
  tenant: Tenant;
  shops: Shop[];
  seed: SeedSnapshot;
  featureFlags: FeatureFlags;
  phase: ImplementationPhase;
}
