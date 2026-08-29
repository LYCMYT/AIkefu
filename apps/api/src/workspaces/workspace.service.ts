import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CreateShopInput, DemoWorkspaceProfile, ShopSettingsInput } from '@ai-customer-service/contracts';
import {
  ConversationTransportMutex,
  localConversationTransportMutex,
  transportShopMutexKey,
} from '../replies/conversation-transport-mutex.service';
import { createWorkspaceToken, hashWorkspaceToken } from '@ai-customer-service/core';
import { SeedCatalog } from '../seed/seed-catalog';
import {
  WORKSPACE_REPOSITORY,
  type AuthenticatedWorkspace,
  type WorkspaceRepository,
  type WorkspaceScope,
} from './workspace.repository';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(WORKSPACE_REPOSITORY) private readonly repository: WorkspaceRepository,
    @Inject(SeedCatalog) private readonly seeds: SeedCatalog,
    private readonly transportMutex: ConversationTransportMutex = localConversationTransportMutex,
  ) {}

  async create(profile: DemoWorkspaceProfile = 'SEEDED') {
    const token = createWorkspaceToken();
    const now = new Date();
    const created = await this.repository.createWithSeed({
      tokenHash: hashWorkspaceToken(token),
      now,
      expiresAt: this.expiryFrom(now),
      seed: await this.seeds.load(),
      profile,
    });
    return { workspace: created.workspace, tenant: created.tenant, token };
  }

  async authenticate(token: string): Promise<AuthenticatedWorkspace> {
    return this.authenticateHash(hashWorkspaceToken(token));
  }

  async authenticateHash(tokenHash: string): Promise<AuthenticatedWorkspace> {
    const now = new Date();
    const authenticated = await this.repository.authenticateAndTouch(
      tokenHash,
      now,
      this.expiryFrom(now),
    );
    if (!authenticated) {
      throw new UnauthorizedException({
        code: 'WORKSPACE_TOKEN_INVALID',
        message: 'Demo workspace token is invalid or expired',
      });
    }
    return authenticated;
  }

  current(context: AuthenticatedWorkspace) {
    return context.workspace;
  }

  async reset(scope: WorkspaceScope, profile: DemoWorkspaceProfile = 'SEEDED') {
    const counts = await this.repository.reset(scope, await this.seeds.load(), profile);
    return { status: 'READY', counts };
  }

  async bootstrap(scope: WorkspaceScope) {
    const result = await this.repository.getBootstrap(scope);
    if (!result) this.notFound();
    return result;
  }

  async listShops(scope: WorkspaceScope) {
    return this.repository.listShops(scope);
  }

  async getShop(scope: WorkspaceScope, shopId: string) {
    const shop = await this.repository.getShop(scope, shopId);
    if (!shop) this.notFound('Shop');
    return shop;
  }

  async createShop(scope: WorkspaceScope, input: CreateShopInput) {
    const seed = await this.seeds.load();
    const requestedTemplate = input.templateKey;
    const seedKey = requestedTemplate === 'FASHION_DEMO' ? 'shop_mia_fashion'
      : requestedTemplate === 'TECH_DEMO' ? 'shop_pixel_tech'
        : requestedTemplate;
    const template = seed.shops.find((shop) => shop.key === seedKey);
    if (!template) {
      throw new BadRequestException({
        code: 'SHOP_TEMPLATE_INVALID',
        message: 'templateKey must be FASHION_DEMO or TECH_DEMO',
      });
    }
    if (input.platform !== 'DOUYIN_DEMO') {
      throw new BadRequestException({ code: 'SHOP_PLATFORM_INVALID', message: 'Only DOUYIN_DEMO is supported' });
    }
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const name = input.name?.trim() || `${template.name} Demo`;
    const externalShopId = input.externalShopId?.trim() || `dy_demo_${suffix}`;
    return this.repository.createShop(scope, {
      template,
      catalog: seed,
      name,
      externalShopId,
      aiMode: input.aiMode ?? 'AUTO_ALLOWED',
    });
  }

  async getShopSettings(scope: WorkspaceScope, shopId: string) {
    const settings = await this.repository.getShopSettings(scope, shopId);
    if (!settings) this.notFound('Shop settings');
    return settings;
  }

  async updateShopSettings(scope: WorkspaceScope, shopId: string, input: ShopSettingsInput) {
    const settings = await this.repository.updateShopSettings(scope, shopId, input);
    if (!settings) this.notFound('Shop settings');
    return settings;
  }

  async setShopAiMode(scope: WorkspaceScope, shopId: string, mode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY') {
    const shop = await this.transportMutex.run(
      transportShopMutexKey({ ...scope, shopId }),
      () => this.repository.setShopAiMode(scope, shopId, mode),
    );
    if (!shop) this.notFound('Shop');
    return shop;
  }

  cleanupExpired(now = new Date()) {
    return this.repository.deleteExpired(now);
  }

  private expiryFrom(now: Date): Date {
    const hours = Number(process.env.DEMO_WORKSPACE_IDLE_EXPIRY_HOURS ?? 24);
    return new Date(now.getTime() + hours * HOUR_MS);
  }

  private notFound(entity = 'Workspace'): never {
    throw new NotFoundException({ code: `${entity.toUpperCase()}_NOT_FOUND`, message: `${entity} not found` });
  }
}
