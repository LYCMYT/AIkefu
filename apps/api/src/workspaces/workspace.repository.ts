import type { SeedData } from '../seed/seed-catalog';

export const WORKSPACE_REPOSITORY = Symbol('WORKSPACE_REPOSITORY');

export type WorkspaceScope = {
  workspaceId: string;
  tenantId: string;
};

export type WorkspaceView = {
  id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'DELETED';
  lastAccessedAt: string;
  expiresAt: string;
  createdAt: string;
};

export type TenantView = {
  id: string;
  workspaceId: string;
  name: string;
};

export type AuthenticatedWorkspace = WorkspaceScope & {
  workspace: WorkspaceView;
  tenant: TenantView;
};

export type ShopView = {
  id: string;
  workspaceId: string;
  tenantId: string;
  platform: string;
  externalShopId: string;
  name: string;
  aiMode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
  connectionState: 'CONNECTED' | 'RECONNECTING' | 'RECONCILING' | 'DEGRADED' | 'DISCONNECTED';
  syncComplete: boolean;
};

export type SeedCounts = {
  shops: number;
  buyers: number;
  products: number;
  orders: number;
  knowledge: number;
  workflows: number;
};

export type BootstrapView = {
  workspace: WorkspaceView;
  tenant: TenantView;
  shops: Array<ShopView & { settings: Record<string, unknown> | null }>;
  seed: { status: 'READY'; counts: SeedCounts };
  featureFlags: {
    mockDouyinOnly: true;
    developerTraceDefault: false;
  };
  phase: 'PHASE_01_FOUNDATION' | 'PHASE_02_MESSAGE_WORKBENCH' | 'PHASE_03_KNOWLEDGE_AI';
};

export interface WorkspaceRepository {
  createWithSeed(input: { tokenHash: string; now: Date; expiresAt: Date; seed: SeedData }): Promise<AuthenticatedWorkspace>;
  authenticateAndTouch(tokenHash: string, now: Date, expiresAt: Date): Promise<AuthenticatedWorkspace | null>;
  reset(scope: WorkspaceScope, seed: SeedData): Promise<SeedCounts>;
  getBootstrap(scope: WorkspaceScope): Promise<BootstrapView | null>;
  listShops(scope: WorkspaceScope): Promise<ShopView[]>;
  getShop(scope: WorkspaceScope, shopId: string): Promise<ShopView | null>;
  deleteExpired(now: Date): Promise<number>;
}
