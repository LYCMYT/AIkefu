import { randomUUID } from 'node:crypto';
import type { SeedData } from '../src/seed/seed-catalog';
import type { DemoWorkspaceProfile, ShopSettings, ShopSettingsInput } from '@ai-customer-service/contracts';
import type {
  AuthenticatedWorkspace,
  BootstrapView,
  CreateShopRepositoryInput,
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
  settings: Map<string, ShopSettings>;
};

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly records = new Map<string, RecordState>();

  async createWithSeed(input: {
    tokenHash: string;
    now: Date;
    expiresAt: Date;
    seed: SeedData;
    profile?: DemoWorkspaceProfile;
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
      shops: (input.profile ?? 'SEEDED') === 'SEEDED' ? this.seedShops(workspaceId, tenantId, input.seed) : [],
      seedCounts: (input.profile ?? 'SEEDED') === 'SEEDED' ? this.counts(input.seed) : this.emptyCounts(),
      runtimeConversations: 0,
      settings: new Map(),
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

  async reset(scope: WorkspaceScope, seed: SeedData, profile: DemoWorkspaceProfile = 'SEEDED'): Promise<SeedCounts> {
    const record = this.records.get(scope.workspaceId);
    if (!record || record.tenantId !== scope.tenantId) throw new Error('workspace not found');
    record.shops = profile === 'SEEDED' ? this.seedShops(scope.workspaceId, scope.tenantId, seed) : [];
    record.seedCounts = profile === 'SEEDED' ? this.counts(seed) : this.emptyCounts();
    record.runtimeConversations = 0;
    record.settings.clear();
    return { ...record.seedCounts };
  }

  async getBootstrap(scope: WorkspaceScope): Promise<BootstrapView | null> {
    const record = this.scoped(scope);
    if (!record) return null;
    return {
      workspace: { ...record.workspace },
      tenant: { ...record.tenant },
      shops: record.shops.map((shop) => ({ ...shop, settings: record.settings.get(shop.id) ?? {} })),
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

  async createShop(scope: WorkspaceScope, input: CreateShopRepositoryInput): Promise<ShopView> {
    const record = this.scoped(scope);
    if (!record) throw new Error('workspace not found');
    if (record.shops.length >= 20) throw new Error('SHOP_LIMIT_REACHED');
    if (record.shops.some((shop) => shop.externalShopId === input.externalShopId)) throw new Error('SHOP_ALREADY_EXISTS');
    const shop: ShopView = {
      id: `shop_${randomUUID()}`, ...scope, platform: 'DOUYIN_DEMO',
      externalShopId: input.externalShopId, name: input.name, aiMode: input.aiMode,
      aiReadiness: input.aiMode === 'MANUAL_ONLY' ? 'OFF' : 'PREPARING',
      connectionState: 'CONNECTED', syncComplete: true,
    };
    record.shops.push(shop);
    record.seedCounts.shops = record.shops.length;
    record.seedCounts.buyers += new Set(input.catalog.orders.filter((order) => order.shopKey === input.template.key).map((order) => order.buyerKey)).size;
    record.seedCounts.products += input.catalog.products.filter((product) => product.shopKey === input.template.key).length;
    record.seedCounts.orders += input.catalog.orders.filter((order) => order.shopKey === input.template.key).length;
    record.seedCounts.knowledge += input.catalog.knowledge.filter((entry) => entry.shopKey === input.template.key && entry.sourceType !== 'AUTO_LEARNED').length;
    record.settings.set(shop.id, {
      shopId: shop.id,
      tone: input.template.settings.tone,
      logisticsPolicy: input.template.settings.logisticsPolicy,
      shippingPolicy: input.template.settings.shippingPolicy,
      afterSalesPolicy: input.template.settings.afterSalesPolicy,
      welcomeMessage: input.template.settings.welcomeMessage,
      closingMessages: { ...input.template.settings.closingMessages },
      transferKeywords: [...input.template.settings.transferKeywords],
      forbiddenTerms: input.template.settings.forbiddenTerms.map((entry) => ({ ...entry })),
    });
    return { ...shop };
  }

  async getShopSettings(scope: WorkspaceScope, shopId: string): Promise<ShopSettings | null> {
    const record = this.scoped(scope);
    if (!record?.shops.some((shop) => shop.id === shopId)) return null;
    return record.settings.get(shopId) ?? null;
  }

  async updateShopSettings(scope: WorkspaceScope, shopId: string, input: ShopSettingsInput): Promise<ShopSettings | null> {
    const record = this.scoped(scope);
    if (!record?.shops.some((shop) => shop.id === shopId)) return null;
    const settings: ShopSettings = {
      shopId, ...input,
      closingMessages: { ...input.closingMessages },
      transferKeywords: [...input.transferKeywords],
      forbiddenTerms: input.forbiddenTerms.map((entry) => ({ ...entry })),
    };
    record.settings.set(shopId, settings);
    return settings;
  }

  async setShopAiMode(scope: WorkspaceScope, shopId: string, mode: ShopView['aiMode']): Promise<ShopView | null> {
    const shop = this.scoped(scope)?.shops.find((entry) => entry.id === shopId);
    if (!shop) return null;
    shop.aiMode = mode;
    return { ...shop };
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
      aiReadiness: source.aiMode === 'MANUAL_ONLY' ? 'OFF' : 'READY',
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

  private emptyCounts(): SeedCounts {
    return { shops: 0, buyers: 0, products: 0, orders: 0, knowledge: 0, workflows: 0 };
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
