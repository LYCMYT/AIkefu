import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SeedData } from '../seed/seed-catalog';
import { PrismaService } from './prisma.service';
import type {
  AuthenticatedWorkspace,
  BootstrapView,
  SeedCounts,
  ShopView,
  WorkspaceRepository,
  WorkspaceScope,
  WorkspaceView,
} from '../workspaces/workspace.repository';

type Transaction = Prisma.TransactionClient;

@Injectable()
export class PrismaWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createWithSeed(input: {
    tokenHash: string;
    now: Date;
    expiresAt: Date;
    seed: SeedData;
  }): Promise<AuthenticatedWorkspace> {
    return this.prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.create({
        data: {
          tokenHash: input.tokenHash,
          lastAccessedAt: input.now,
          expiresAt: input.expiresAt,
        },
      });
      const tenant = await transaction.tenant.create({
        data: { workspaceId: workspace.id, name: 'Anonymous Demo Tenant' },
      });
      await this.seedScope(transaction, { workspaceId: workspace.id, tenantId: tenant.id }, input.seed);
      return {
        workspaceId: workspace.id,
        tenantId: tenant.id,
        workspace: this.workspaceView(workspace),
        tenant: { id: tenant.id, workspaceId: tenant.workspaceId, name: tenant.name },
      };
    });
  }

  async authenticateAndTouch(
    tokenHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<AuthenticatedWorkspace | null> {
    const match = await this.prisma.workspace.findFirst({
      where: { tokenHash, status: 'ACTIVE', expiresAt: { gt: now } },
      include: { tenant: true },
    });
    if (!match?.tenant) return null;
    const workspace = await this.prisma.workspace.update({
      where: { id: match.id },
      data: { lastAccessedAt: now, expiresAt },
    });
    return {
      workspaceId: workspace.id,
      tenantId: match.tenant.id,
      workspace: this.workspaceView(workspace),
      tenant: { id: match.tenant.id, workspaceId: match.tenant.workspaceId, name: match.tenant.name },
    };
  }

  async reset(scope: WorkspaceScope, seed: SeedData): Promise<SeedCounts> {
    // Auth middleware supplies an AuthenticatedWorkspace, which structurally
    // contains WorkspaceScope plus nested workspace/tenant views. Never spread
    // those extra properties into Prisma create inputs during reseeding.
    const normalizedScope = this.scope(scope);
    return this.prisma.$transaction(async (transaction) => {
      await transaction.auditLog.deleteMany({ where: normalizedScope });
      await transaction.workflow.deleteMany({ where: normalizedScope });
      await transaction.shop.deleteMany({ where: normalizedScope });
      await transaction.buyer.deleteMany({ where: normalizedScope });
      await this.seedScope(transaction, normalizedScope, seed);
      return this.seedCounts(transaction, normalizedScope);
    });
  }

  async getBootstrap(scope: WorkspaceScope): Promise<BootstrapView | null> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: scope.workspaceId, tenant: { id: scope.tenantId } },
      include: { tenant: true },
    });
    if (!workspace?.tenant) return null;
    const shops = await this.prisma.shop.findMany({
      where: this.scope(scope),
      include: { settings: true },
      orderBy: { externalShopId: 'asc' },
    });
    return {
      workspace: this.workspaceView(workspace),
      tenant: { id: workspace.tenant.id, workspaceId: workspace.tenant.workspaceId, name: workspace.tenant.name },
      shops: shops.map((shop) => ({
        ...this.shopView(shop),
        settings: shop.settings
          ? {
              tone: shop.settings.tone,
              logisticsPolicy: shop.settings.logisticsPolicy,
              shippingPolicy: shop.settings.shippingPolicy,
              afterSalesPolicy: shop.settings.afterSalesPolicy,
              welcomeMessage: shop.settings.welcomeMessage,
              closingMessages: shop.settings.closingMessagesJson,
              transferKeywords: shop.settings.transferKeywordsJson,
              forbiddenTerms: shop.settings.forbiddenTermsJson,
            }
          : null,
      })),
      seed: { status: 'READY', counts: await this.seedCounts(this.prisma, scope) },
      featureFlags: {
        mockDouyinOnly: true,
        developerTraceDefault: false,
      },
      phase: 'PHASE_03_KNOWLEDGE_AI',
    };
  }

  async listShops(scope: WorkspaceScope): Promise<ShopView[]> {
    const shops = await this.prisma.shop.findMany({
      where: this.scope(scope),
      orderBy: { externalShopId: 'asc' },
    });
    return shops.map((shop) => this.shopView(shop));
  }

  async getShop(scope: WorkspaceScope, shopId: string): Promise<ShopView | null> {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, ...this.scope(scope) },
    });
    return shop ? this.shopView(shop) : null;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.prisma.workspace.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return result.count;
  }

  private async seedScope(transaction: Transaction, scope: WorkspaceScope, seed: SeedData): Promise<void> {
    const shops = new Map<string, string>();
    for (const source of seed.shops) {
      const shop = await transaction.shop.upsert({
        where: {
          workspaceId_tenantId_seedKey: {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            seedKey: source.key,
          },
        },
        create: {
          ...scope,
          seedKey: source.key,
          platform: source.platform,
          externalShopId: source.externalShopId,
          name: source.name,
          aiMode: source.aiMode,
          connectionState: source.connectionState,
          syncComplete: true,
        },
        update: {
          platform: source.platform,
          externalShopId: source.externalShopId,
          name: source.name,
          aiMode: source.aiMode,
          connectionState: source.connectionState,
          syncComplete: true,
        },
      });
      shops.set(source.key, shop.id);
      await transaction.shopSettings.upsert({
        where: { shopId: shop.id },
        create: {
          ...scope,
          shopId: shop.id,
          tone: source.settings.tone,
          logisticsPolicy: source.settings.logisticsPolicy,
          shippingPolicy: source.settings.shippingPolicy,
          afterSalesPolicy: source.settings.afterSalesPolicy,
          welcomeMessage: source.settings.welcomeMessage,
          closingMessagesJson: source.settings.closingMessages,
          transferKeywordsJson: source.settings.transferKeywords,
          forbiddenTermsJson: source.settings.forbiddenTerms,
        },
        update: {
          tone: source.settings.tone,
          logisticsPolicy: source.settings.logisticsPolicy,
          shippingPolicy: source.settings.shippingPolicy,
          afterSalesPolicy: source.settings.afterSalesPolicy,
          welcomeMessage: source.settings.welcomeMessage,
          closingMessagesJson: source.settings.closingMessages,
          transferKeywordsJson: source.settings.transferKeywords,
          forbiddenTermsJson: source.settings.forbiddenTerms,
        },
      });
    }

    const buyers = new Map<string, string>();
    for (const source of seed.buyers) {
      const buyer = await transaction.buyer.upsert({
        where: {
          workspaceId_tenantId_seedKey: {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            seedKey: source.key,
          },
        },
        create: {
          ...scope,
          seedKey: source.key,
          externalBuyerId: source.externalBuyerId,
          displayName: source.displayName,
          avatar: source.avatar,
          tagsJson: source.tags,
        },
        update: { displayName: source.displayName, avatar: source.avatar, tagsJson: source.tags },
      });
      buyers.set(source.key, buyer.id);
    }

    const products = new Map<string, string>();
    const skus = new Map<string, string>();
    for (const source of seed.products) {
      const shopId = this.required(shops, source.shopKey, 'shop');
      const product = await transaction.product.upsert({
        where: {
          workspaceId_tenantId_seedKey: {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            seedKey: source.key,
          },
        },
        create: {
          ...scope,
          shopId,
          seedKey: source.key,
          externalProductId: source.externalProductId,
          title: source.title,
          description: source.description,
          contentHash: createHash('sha256').update(source.description).digest('hex'),
          status: source.status,
          recommendable: source.recommendable,
        },
        update: {
          title: source.title,
          description: source.description,
          contentHash: createHash('sha256').update(source.description).digest('hex'),
          status: source.status,
          recommendable: source.recommendable,
        },
      });
      products.set(source.key, product.id);
      for (const skuSource of source.skus) {
        const sku = await transaction.productSku.upsert({
          where: {
            workspaceId_tenantId_productId_externalSkuId: {
              workspaceId: scope.workspaceId,
              tenantId: scope.tenantId,
              productId: product.id,
              externalSkuId: skuSource.externalSkuId,
            },
          },
          create: {
            ...scope,
            shopId,
            productId: product.id,
            externalSkuId: skuSource.externalSkuId,
            attributesJson: skuSource.attributes,
            price: new Prisma.Decimal(skuSource.price),
            inventory: skuSource.inventory,
            status: 'ACTIVE',
          },
          update: {
            attributesJson: skuSource.attributes,
            price: new Prisma.Decimal(skuSource.price),
            inventory: skuSource.inventory,
            status: 'ACTIVE',
          },
        });
        skus.set(skuSource.externalSkuId, sku.id);
      }
    }

    for (const source of seed.orders) {
      const shopId = this.required(shops, source.shopKey, 'shop');
      await transaction.order.upsert({
        where: {
          workspaceId_tenantId_seedKey: {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            seedKey: source.key,
          },
        },
        create: {
          ...scope,
          shopId,
          buyerId: this.required(buyers, source.buyerKey, 'buyer'),
          productId: this.required(products, source.productKey, 'product'),
          skuId: this.required(skus, source.sku, 'sku'),
          seedKey: source.key,
          externalOrderId: source.externalOrderId,
          status: source.status,
          amount: new Prisma.Decimal(source.amount),
          orderedAt: new Date(source.orderedAt),
          shippedAt: source.shippedAt ? new Date(source.shippedAt) : undefined,
          logisticsSnapshotJson: source.logistics === null ? Prisma.DbNull : this.json(source.logistics),
        },
        update: {
          status: source.status,
          amount: new Prisma.Decimal(source.amount),
          orderedAt: new Date(source.orderedAt),
          shippedAt: source.shippedAt ? new Date(source.shippedAt) : undefined,
          logisticsSnapshotJson: source.logistics === null ? Prisma.DbNull : this.json(source.logistics),
          version: 1,
        },
      });
    }

    for (const source of seed.knowledge) {
      const shopId = this.required(shops, source.shopKey, 'shop');
      const item = await transaction.knowledgeItem.upsert({
        where: {
          workspaceId_tenantId_seedKey: {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            seedKey: source.key,
          },
        },
        create: {
          ...scope,
          shopId,
          productId: source.productKey ? this.required(products, source.productKey, 'product') : undefined,
          seedKey: source.key,
          scope: source.scope,
          sourceType: source.sourceType,
          businessStatus: source.businessStatus,
        },
        update: {
          scope: source.scope,
          sourceType: source.sourceType,
          businessStatus: source.businessStatus,
        },
      });
      const version = await transaction.knowledgeVersion.upsert({
        where: { knowledgeItemId_version: { knowledgeItemId: item.id, version: 1 } },
        create: {
          ...scope,
          knowledgeItemId: item.id,
          version: 1,
          question: source.question,
          answer: source.answer,
          sourceText: `${source.question}\n${source.answer}`,
          sourceVersion: 'seed-v1',
          confidence: source.sourceType === 'AUTO_LEARNED' ? 0.9 : 1,
          indexStatus: source.indexStatus,
        },
        update: {
          question: source.question,
          answer: source.answer,
          sourceText: `${source.question}\n${source.answer}`,
          sourceVersion: 'seed-v1',
          confidence: source.sourceType === 'AUTO_LEARNED' ? 0.9 : 1,
          indexStatus: source.indexStatus,
        },
      });
      await transaction.knowledgeItem.update({
        where: { id: item.id },
        data: { activeVersionId: source.indexStatus === 'READY' ? version.id : null },
      });
    }

    for (const source of seed.workflows) {
      const workflow = await transaction.workflow.upsert({
        where: {
          workspaceId_tenantId_seedKey: {
            workspaceId: scope.workspaceId,
            tenantId: scope.tenantId,
            seedKey: source.key,
          },
        },
        create: {
          ...scope,
          seedKey: source.key,
          name: source.name,
          type: source.type,
          status: source.status,
          priority: source.priority,
        },
        update: { name: source.name, type: source.type, status: source.status, priority: source.priority },
      });
      const version = await transaction.workflowVersion.upsert({
        where: { workflowId_version: { workflowId: workflow.id, version: source.version } },
        create: {
          ...scope,
          workflowId: workflow.id,
          version: source.version,
          graphJson: this.json(source.graph),
          publishedAt: source.status === 'PUBLISHED' ? new Date() : undefined,
          immutable: source.status === 'PUBLISHED',
        },
        update: { graphJson: this.json(source.graph) },
      });
      await transaction.workflow.update({
        where: { id: workflow.id },
        data: { activeVersionId: source.status === 'PUBLISHED' ? version.id : null },
      });
    }

    // Fixed cases are durable fixtures for repeatable evaluation. Their
    // upsert key makes workspace reset idempotent and deliberately stores no
    // result/accuracy claim.
    for (const source of seed.evalCases) {
      const shopId = source.shopKey ? this.required(shops, source.shopKey, 'shop') : undefined;
      await transaction.evalCase.upsert({
        where: { workspaceId_tenantId_key: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, key: source.key } },
        create: { ...scope, shopId, key: source.key, source: 'FIXED', inputJson: this.json(source.input), expectedJson: this.json(source.expected), assertionsJson: this.json(source.assertions) },
        update: { shopId, source: 'FIXED', inputJson: this.json(source.input), expectedJson: this.json(source.expected), assertionsJson: this.json(source.assertions), status: 'ACTIVE' },
      });
    }
  }

  private async seedCounts(client: Transaction, scope: WorkspaceScope): Promise<SeedCounts> {
    const [shops, buyers, products, orders, knowledge, workflows] = await Promise.all([
      client.shop.count({ where: this.scope(scope) }),
      client.buyer.count({ where: this.scope(scope) }),
      client.product.count({ where: this.scope(scope) }),
      client.order.count({ where: this.scope(scope) }),
      client.knowledgeItem.count({ where: this.scope(scope) }),
      client.workflow.count({ where: this.scope(scope) }),
    ]);
    return { shops, buyers, products, orders, knowledge, workflows };
  }

  private scope(scope: WorkspaceScope) {
    return { workspaceId: scope.workspaceId, tenantId: scope.tenantId };
  }

  private required(map: Map<string, string>, key: string, entity: string): string {
    const id = map.get(key);
    if (!id) throw new Error(`Synthetic seed references missing ${entity}: ${key}`);
    return id;
  }

  private json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private workspaceView(workspace: {
    id: string;
    status: 'ACTIVE' | 'EXPIRED' | 'DELETED';
    lastAccessedAt: Date;
    expiresAt: Date;
    createdAt: Date;
  }): WorkspaceView {
    return {
      id: workspace.id,
      status: workspace.status,
      lastAccessedAt: workspace.lastAccessedAt.toISOString(),
      expiresAt: workspace.expiresAt.toISOString(),
      createdAt: workspace.createdAt.toISOString(),
    };
  }

  private shopView(shop: {
    id: string;
    workspaceId: string;
    tenantId: string;
    platform: string;
    externalShopId: string;
    name: string;
    aiMode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
    connectionState: 'CONNECTED' | 'RECONNECTING' | 'RECONCILING' | 'DEGRADED' | 'DISCONNECTED';
    syncComplete: boolean;
  }): ShopView {
    return {
      id: shop.id,
      workspaceId: shop.workspaceId,
      tenantId: shop.tenantId,
      platform: shop.platform,
      externalShopId: shop.externalShopId,
      name: shop.name,
      aiMode: shop.aiMode,
      connectionState: shop.connectionState,
      syncComplete: shop.syncComplete,
    };
  }
}
