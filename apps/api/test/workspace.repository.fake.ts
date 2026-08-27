import { randomUUID } from 'node:crypto';
import type { SeedData } from '../src/seed/seed-catalog';
import type {
  AuthenticatedWorkspace,
  BootstrapView,
  SeedCounts,
  ShopView,
  WorkspaceRepository,
  WorkspaceScope,
} from '../src/workspaces/workspace.repository';

type RecordState = AuthenticatedWorkspace & {
  tokenHash: string;
  shops: ShopView[];
  seedCounts: SeedCounts;
  runtimeConversations: number;
};

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly records = new Map<string, RecordState>();

  async createWithSeed(input: {
    tokenHash: string;
    now: Date;
    expiresAt: Date;
    seed: SeedData;
  }): Promise<AuthenticatedWorkspace> {
    const workspaceId = `ws_${randomUUID()}`;
    const tenantId = `tenant_${randomUUID()}`;
    const record: RecordState = {
      tokenHash: input.tokenHash,
      workspaceId,
      tenantId,
      workspace: {
        id: workspaceId,
        status: 'ACTIVE',
        lastAccessedAt: input.now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        createdAt: input.now.toISOString(),
      },
      tenant: { id: tenantId, workspaceId, name: 'Anonymous Demo Tenant' },
      shops: this.seedShops(workspaceId, tenantId, input.seed),
      seedCounts: this.counts(input.seed),
      runtimeConversations: 0,
    };
    this.records.set(workspaceId, record);
    return this.authView(record);
  }

  async authenticateAndTouch(
    tokenHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<AuthenticatedWorkspace | null> {
    const record = [...this.records.values()].find(
      (entry) => entry.tokenHash === tokenHash && new Date(entry.workspace.expiresAt) > now,
    );
    if (!record) return null;
    record.workspace.lastAccessedAt = now.toISOString();
    record.workspace.expiresAt = expiresAt.toISOString();
    return this.authView(record);
  }

  async reset(scope: WorkspaceScope, seed: SeedData): Promise<SeedCounts> {
    const record = this.records.get(scope.workspaceId);
    if (!record || record.tenantId !== scope.tenantId) throw new Error('workspace not found');
    record.shops = this.seedShops(scope.workspaceId, scope.tenantId, seed);
    record.seedCounts = this.counts(seed);
    record.runtimeConversations = 0;
    return { ...record.seedCounts };
  }

  async getBootstrap(scope: WorkspaceScope): Promise<BootstrapView | null> {
    const record = this.scoped(scope);
    if (!record) return null;
    return {
      workspace: { ...record.workspace },
      tenant: { ...record.tenant },
      shops: record.shops.map((shop) => ({ ...shop, settings: {} })),
      seed: { status: 'READY', counts: { ...record.seedCounts } },
      featureFlags: {
        mockDouyinOnly: true,
        developerTraceDefault: false,
      },
      phase: 'PHASE_03_KNOWLEDGE_AI',
    };
  }

  async listShops(scope: WorkspaceScope): Promise<ShopView[]> {
    return this.scoped(scope)?.shops.map((shop) => ({ ...shop })) ?? [];
  }

  async getShop(scope: WorkspaceScope, shopId: string): Promise<ShopView | null> {
    return this.scoped(scope)?.shops.find((shop) => shop.id === shopId) ?? null;
  }

  async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (new Date(record.workspace.expiresAt) <= now) {
        this.records.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async addRuntimeConversation(workspaceId: string, tenantId: string): Promise<void> {
    const record = this.scoped({ workspaceId, tenantId });
    if (!record) throw new Error('workspace not found');
    record.runtimeConversations += 1;
  }

  runtimeConversationCount(workspaceId: string): number {
    return this.records.get(workspaceId)?.runtimeConversations ?? 0;
  }

  expireWorkspace(workspaceId: string): void {
    const record = this.records.get(workspaceId);
    if (record) record.workspace.expiresAt = new Date(0).toISOString();
  }

  private scoped(scope: WorkspaceScope): RecordState | undefined {
    const record = this.records.get(scope.workspaceId);
    return record?.tenantId === scope.tenantId ? record : undefined;
  }

  private seedShops(workspaceId: string, tenantId: string, seed: SeedData): ShopView[] {
    return seed.shops.map((source) => ({
      id: `shop_${randomUUID()}`,
      workspaceId,
      tenantId,
      platform: source.platform,
      externalShopId: source.externalShopId,
      name: source.name,
      aiMode: source.aiMode,
      connectionState: source.connectionState,
      syncComplete: true,
    }));
  }

  private counts(seed: SeedData): SeedCounts {
    return {
      shops: seed.shops.length,
      buyers: seed.buyers.length,
      products: seed.products.length,
      orders: seed.orders.length,
      knowledge: seed.knowledge.length,
      workflows: seed.workflows.length,
    };
  }

  private authView(record: RecordState): AuthenticatedWorkspace {
    return {
      workspaceId: record.workspaceId,
      tenantId: record.tenantId,
      workspace: { ...record.workspace },
      tenant: { ...record.tenant },
    };
  }
}
