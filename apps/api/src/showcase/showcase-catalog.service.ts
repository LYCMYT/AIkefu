import { Injectable } from '@nestjs/common';
import type { ShowcaseCatalog, ShowcaseScenario } from '@ai-customer-service/contracts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { SeedCatalog } from '../seed/seed-catalog';

@Injectable()
export class ShowcaseCatalogService {
  private scenarios?: ShowcaseScenario[];

  constructor(private readonly seedCatalog: SeedCatalog) {}

  async catalog(): Promise<ShowcaseCatalog> {
    const seed = await this.seedCatalog.load();
    return {
      version: '1.0',
      providerMode: providerMode(process.env),
      multimodalMode: multimodalMode(process.env),
      resources: {
        shops: seed.shops.map(({ key, name }) => ({ key, name })),
        buyers: seed.buyers.map(({ key, externalBuyerId }) => ({ key, externalBuyerId })),
        products: seed.products.map(({ key, externalProductId }) => ({ key, externalProductId })),
        orders: seed.orders.map(({ key, externalOrderId }) => ({ key, externalOrderId })),
      },
      scenarios: await this.loadScenarios(),
    };
  }

  private async loadScenarios(): Promise<ShowcaseScenario[]> {
    if (this.scenarios) return this.scenarios;
    const configured = process.env.DEMO_SHOWCASE_SCENARIOS_PATH;
    const candidates = [
      configured ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)) : undefined,
      resolve(process.cwd(), 'seed/showcase-scenarios.json'),
      resolve(process.cwd(), '../../seed/showcase-scenarios.json'),
      resolve(__dirname, '../../../../seed/showcase-scenarios.json'),
      resolve(__dirname, '../../../../../seed/showcase-scenarios.json'),
    ].filter((value): value is string => Boolean(value));
    let firstValidationError: unknown;
    let lastError: unknown;
    for (const path of candidates) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { scenarios?: unknown };
        this.scenarios = validateScenarios(parsed.scenarios);
        return this.scenarios;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('SHOWCASE_') && !firstValidationError) firstValidationError = error;
        lastError = error;
      }
    }
    throw firstValidationError ?? new Error(`SHOWCASE_CATALOG_UNAVAILABLE:${String(lastError)}`);
  }
}

function validateScenarios(value: unknown): ShowcaseScenario[] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error('SHOWCASE_SCENARIO_COUNT_INVALID');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('SHOWCASE_SCENARIO_INVALID');
    const scenario = entry as unknown as ShowcaseScenario;
    if (!scenario.id || ids.has(scenario.id) || scenario.order !== index + 1 || !scenario.shopKey || !scenario.buyerKey || !Array.isArray(scenario.steps)) {
      throw new Error('SHOWCASE_SCENARIO_INVALID');
    }
    ids.add(scenario.id);
    return scenario;
  });
}

function providerMode(env: Readonly<Record<string, string | undefined>>): ShowcaseCatalog['providerMode'] {
  const hasProvider = Boolean(env.AI_PROVIDER?.trim() || env.AI_BASE_URL?.trim());
  const hasSecret = Boolean(env.AI_API_KEY?.trim() || (env.AI_API_KEY_FILE?.trim() && existsSync(env.AI_API_KEY_FILE.trim())));
  if (hasProvider && hasSecret) return 'REAL';
  if (env.AI_OFFLINE_MODE === '1' || env.NODE_ENV !== 'production') return 'OFFLINE';
  return 'UNAVAILABLE';
}

function multimodalMode(env: Readonly<Record<string, string | undefined>>): ShowcaseCatalog['multimodalMode'] {
  return providerMode(env) === 'REAL' && env.AI_EXTERNAL_IMAGE_ANALYSIS_OPT_IN === 'true' ? 'REAL' : 'FIXTURE';
}
