import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
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
  ) {}

  async create() {
    const token = createWorkspaceToken();
    const now = new Date();
    const created = await this.repository.createWithSeed({
      tokenHash: hashWorkspaceToken(token),
      now,
      expiresAt: this.expiryFrom(now),
      seed: await this.seeds.load(),
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

  async reset(scope: WorkspaceScope) {
    const counts = await this.repository.reset(scope, await this.seeds.load());
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
