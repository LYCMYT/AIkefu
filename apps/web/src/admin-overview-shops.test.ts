import { describe, expect, it } from 'vitest';
import type { QualityReview, UsageSummary } from './api';
import {
  buildAdminOverviewSnapshot,
  buildConversationTrend,
  connectionStateLabel,
  modeLabel,
  type AdminOverviewSnapshot,
} from './App';
import type { Conversation } from './api';
import type { Shop } from '@ai-customer-service/contracts';

const shops: Shop[] = [
  {
    id: 'shop-a',
    name: 'Shop A',
    platform: 'DOUYIN_DEMO',
    aiMode: 'AUTO_ALLOWED',
    connectionState: 'CONNECTED',
    syncComplete: true,
  },
  {
    id: 'shop-b',
    name: 'Shop B',
    platform: 'DOUYIN_DEMO',
    aiMode: 'ASSIST_ONLY',
    connectionState: 'DEGRADED',
    syncComplete: false,
  },
];

const usage: UsageSummary = {
  calls: 9,
  inputTokens: 90,
  outputTokens: 30,
  estimatedCost: 0,
  failures: 1,
  fallbacks: 2,
  fastPathReplies: 4,
  byPurpose: {
    REPLY_GENERATION: { calls: 3, inputTokens: 40, outputTokens: 18, failures: 0, fallbacks: 1 },
  },
};

const conversation = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  id,
  shopId: 'shop-a',
  buyerId: `buyer-${id}`,
  state: 'ACTIVE',
  createdAt: '2026-08-27T08:00:00.000Z',
  updatedAt: '2026-08-27T10:00:00.000Z',
  lastMessageAt: '2026-08-27T10:00:00.000Z',
  ...overrides,
});

describe('Phase 05 Admin Overview and Shops helpers', () => {
  it('derives only observable workspace metrics and marks missing history as unavailable', () => {
    const snapshot: AdminOverviewSnapshot = buildAdminOverviewSnapshot(
      shops,
      {
        'shop-a': [conversation('today-active', { humanActive: true }), conversation('today-ai')],
        'shop-b': [conversation('yesterday', { shopId: 'shop-b', lastMessageAt: '2026-08-26T10:00:00.000Z' })],
      },
      usage,
      [
        { id: 'review-pass', conversationId: 'today-ai', status: 'PASS', humanResult: 'PASS', sampleSize: 1 },
        { id: 'review-human', conversationId: 'today-active', status: 'NEEDS_HUMAN', humanResult: null, sampleSize: 1 },
      ] as QualityReview[],
      new Date('2026-08-27T12:00:00.000Z'),
    );

    expect(snapshot.onlineShops).toEqual({ value: 1, sampleSize: 2 });
    expect(snapshot.todayInbound).toEqual({ value: 2, sampleSize: 3 });
    expect(snapshot.humanTakeover).toEqual({ value: 1, sampleSize: 3 });
    expect(snapshot.fastPath).toEqual({ value: 4, sampleSize: 1 });
    expect(snapshot.llmReply).toEqual({ value: 3, sampleSize: 1 });
    expect(snapshot.aiUsage).toEqual({ value: 9, sampleSize: 1 });
    expect(snapshot.qualityPassRate).toEqual({ value: 100, sampleSize: 1 });
  });

  it('keeps missing or invalid source data unavailable instead of using placeholder KPI values', () => {
    const snapshot = buildAdminOverviewSnapshot(shops, { 'shop-a': [] }, undefined, [], new Date('2026-08-27T12:00:00.000Z'));

    expect(snapshot.todayInbound.value).toBeNull();
    expect(snapshot.todayInbound.sampleSize).toBe(0);
    expect(snapshot.fastPath.value).toBeNull();
    expect(snapshot.llmReply.value).toBeNull();
    expect(snapshot.qualityPassRate.value).toBeNull();
  });

  it('builds a seven-day trend from conversation timestamps without inventing zero-source days', () => {
    const trend = buildConversationTrend(
      [conversation('one', { lastMessageAt: '2026-08-27T10:00:00.000Z' }), conversation('two', { lastMessageAt: '2026-08-25T10:00:00.000Z' })],
      new Date('2026-08-27T12:00:00.000Z'),
    );

    expect(trend).toHaveLength(7);
    expect(trend.at(-1)).toMatchObject({ count: 1 });
    expect(trend.at(-3)).toMatchObject({ count: 1 });
  });

  it('supports a bounded thirty-day operational range without inventing metrics', () => {
    const trend = buildConversationTrend(
      [conversation('old', { lastMessageAt: '2026-08-01T10:00:00.000Z' })],
      new Date('2026-08-27T12:00:00.000Z'),
      30,
    );

    expect(trend).toHaveLength(30);
    expect(trend.reduce((total, point) => total + point.count, 0)).toBe(1);
  });

  it('uses frozen labels for shop AI modes and connection states', () => {
    expect(modeLabel('AUTO_ALLOWED')).toBe('自动接待');
    expect(modeLabel('ASSIST_ONLY')).toBe('辅助模式');
    expect(modeLabel('MANUAL_ONLY')).toBe('人工模式');
    expect(connectionStateLabel('CONNECTED')).toBe('已连接');
    expect(connectionStateLabel('DEGRADED')).toBe('降级');
    expect(connectionStateLabel('UNKNOWN')).toBe('未知状态');
  });
});
