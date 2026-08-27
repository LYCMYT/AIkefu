import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { containsDynamicCommerceFact } from '../knowledge/knowledge.policy';

export type SeedShop = {
  key: string;
  name: string;
  platform: string;
  externalShopId: string;
  aiMode: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
  connectionState: 'CONNECTED' | 'RECONNECTING' | 'RECONCILING' | 'DEGRADED' | 'DISCONNECTED';
  settings: {
    tone: string;
    logisticsPolicy: string;
    shippingPolicy: string;
    afterSalesPolicy: string;
    welcomeMessage: string;
    closingMessages: Record<string, string>;
    transferKeywords: string[];
    forbiddenTerms: Array<{ term: string; replacement: string }>;
  };
};

export type SeedData = {
  shops: SeedShop[];
  buyers: Array<{ key: string; externalBuyerId: string; displayName: string; avatar?: string; tags: string[] }>;
  products: Array<{
    key: string;
    shopKey: string;
    externalProductId: string;
    title: string;
    status: 'ON_SHELF' | 'OFF_SHELF' | 'DELETED';
    recommendable: boolean;
    description: string;
    skus: Array<{ externalSkuId: string; attributes: Record<string, string>; price: number; inventory: number }>;
  }>;
  orders: Array<{
    key: string;
    shopKey: string;
    buyerKey: string;
    productKey: string;
    sku: string;
    externalOrderId: string;
    status: string;
    amount: number;
    orderedAt: string;
    shippedAt?: string;
    logistics: Record<string, unknown> | null;
  }>;
  knowledge: Array<{
    key: string;
    shopKey: string;
    productKey: string | null;
    scope: 'STORE' | 'PRODUCT';
    sourceType: 'MANUAL' | 'HUMAN_REVIEWED' | 'AUTO_LEARNED';
    businessStatus: 'DRAFT' | 'ENABLED' | 'DISABLED' | 'OUTDATED' | 'CONFLICTED' | 'DELETED';
    indexStatus: 'PENDING' | 'INDEXING' | 'READY' | 'FAILED';
    question: string;
    answer: string;
  }>;
  workflows: Array<{
    key: string;
    name: string;
    type: string;
    status: 'DRAFT' | 'PUBLISHED' | 'DISABLED';
    priority: number;
    version: number;
    graph: Record<string, unknown>;
  }>;
  /** Frozen fixtures are inputs/expectations, never claimed production scores. */
  evalCases: Array<{
    key: string;
    shopKey?: string;
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
    assertions: Record<string, unknown>;
  }>;
};

@Injectable()
export class SeedCatalog {
  private cached?: SeedData;

  async load(): Promise<SeedData> {
    if (this.cached) return this.cached;
    const configured = process.env.DEMO_SEED_PATH;
    const candidates = [
      configured ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)) : undefined,
      resolve(process.cwd(), 'seed/seed-data.json'),
      resolve(process.cwd(), '../../seed/seed-data.json'),
      resolve(__dirname, '../../../../seed/seed-data.json'),
      resolve(__dirname, '../../../../../seed/seed-data.json'),
    ].filter((value): value is string => Boolean(value));

    let lastError: unknown;
    for (const path of candidates) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as SeedData;
        this.assertShape(parsed);
        // Frozen Phase 01 seed graphs predate bounded workflow settings. Keep
        // the fixture source stable while making every imported graph explicit
        // about the finite V1 execution limits.
        const normalized: SeedData = {
          ...parsed,
          workflows: parsed.workflows.map((workflow) => ({
            ...workflow,
            graph: withWorkflowDefaults(workflow.graph),
          })),
          evalCases: await this.loadEvalCases(path),
        };
        this.cached = normalized;
        return normalized;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Unable to load synthetic seed-data.json: ${String(lastError)}`);
  }

  private assertShape(seed: SeedData): void {
    const expected: Array<[keyof SeedData, number]> = [
      ['shops', 2],
      ['buyers', 4],
      ['products', 10],
      ['orders', 10],
      ['knowledge', 80],
      ['workflows', 2],
    ];
    for (const [key, count] of expected) {
      if (!Array.isArray(seed[key]) || seed[key].length !== count) {
        throw new Error(`Synthetic seed ${key} must contain exactly ${count} entries`);
      }
    }
    for (const entry of seed.knowledge) {
      if (
        entry.businessStatus === 'ENABLED'
        && entry.indexStatus === 'READY'
        && containsDynamicCommerceFact(`${entry.question}\n${entry.answer}`)
      ) {
        throw new Error(
          `Synthetic seed enabled READY knowledge must not contain dynamic commerce facts: ${entry.key}`,
        );
      }
    }
  }

  private async loadEvalCases(seedPath: string): Promise<SeedData['evalCases']> {
    const configured = process.env.DEMO_EVAL_CASES_PATH;
    const candidates = [...new Set([
      configured ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)) : undefined,
      resolve(dirname(seedPath), 'eval-cases.json'),
      resolve(process.cwd(), 'seed/eval-cases.json'),
      resolve(process.cwd(), '../../seed/eval-cases.json'),
      resolve(__dirname, '../../../../seed/eval-cases.json'),
      resolve(__dirname, '../../../../../seed/eval-cases.json'),
    ].filter((value): value is string => Boolean(value)))];
    let lastError: unknown;
    for (const path of candidates) {
      try {
        const file = JSON.parse(await readFile(path, 'utf8')) as { cases?: unknown[] };
        if (!Array.isArray(file.cases) || file.cases.length !== 36) {
          throw new Error('Synthetic fixed Eval file must contain exactly 36 cases');
        }
        const ids = new Set<string>();
        return file.cases.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Synthetic Eval case must be an object');
          const source = value as Record<string, unknown>;
          if (typeof source.id !== 'string' || !source.id || ids.has(source.id)) throw new Error('Synthetic Eval case id must be unique');
          if (typeof source.category !== 'string' || typeof source.shopKey !== 'string' || typeof source.buyerKey !== 'string') throw new Error(`Synthetic Eval case ${source.id} has invalid scope`);
          if (!Array.isArray(source.messages) || !Array.isArray(source.expectedTasks) || !Array.isArray(source.expectedFacts) || !Array.isArray(source.forbiddenClaims)) throw new Error(`Synthetic Eval case ${source.id} has invalid expectations`);
          ids.add(source.id);
          return {
            key: `fixed:${source.id}`,
            shopKey: source.shopKey,
            input: { buyerKey: source.buyerKey, messages: source.messages, contextSetup: source.contextSetup ?? {} },
            expected: { category: source.category, tasks: source.expectedTasks, mode: source.expectedMode ?? null, facts: source.expectedFacts },
            assertions: { forbiddenClaims: source.forbiddenClaims, notes: typeof source.notes === 'string' ? source.notes : '' },
          };
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Unable to load synthetic eval-cases.json: ${String(lastError)}`);
  }
}

function withWorkflowDefaults(graph: Record<string, unknown>): Record<string, unknown> {
  const settings = graph.settings;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? [...graph.edges] : [];
  // The frozen after-sales fixture predates closed boolean condition edges.
  // Normalize the imported demo to a safe false -> END path, while keeping
  // source seed data stable for historical Phase 01 checks.
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || (node as Record<string, unknown>).type !== 'CONDITION') continue;
    const id = (node as Record<string, unknown>).id;
    if (typeof id !== 'string') continue;
    const hasFalse = edges.some((edge) => edge && typeof edge === 'object' && (edge as Record<string, unknown>).source === id && (edge as Record<string, unknown>).condition === 'false');
    const end = nodes.find((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).type === 'END') as Record<string, unknown> | undefined;
    if (!hasFalse && typeof end?.id === 'string') edges.push({ id: `seed-${id}-false-end`, source: id, target: end.id, condition: 'false' });
  }
  return { ...graph, edges, settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : { maxSteps: 20, timeoutMs: 30_000 } };
}
