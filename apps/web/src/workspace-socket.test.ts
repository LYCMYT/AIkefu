import { describe, expect, it } from 'vitest';
import websocketSchemaText from '../../../specs/websocket-events.json?raw';
import { conversationModeOptionLabel, isConversationModeAllowed, sendOutboxStatusLabel } from './App';
import {
  conversationSnapshotRefreshTarget,
  refreshConversationForWorkspaceEvent,
  shouldAdvanceGlobalSnapshotVersion,
} from './workspace-socket';

type SchemaDefinition = {
  required?: string[];
  properties?: Record<string, { type?: string; const?: boolean; required?: string[] }>;
  oneOf?: Array<SchemaDefinition>;
  additionalProperties?: boolean;
};

describe('Phase 04 workspace event contract', () => {
  it('routes reliability events to the selected conversation REST snapshot', () => {
    expect(conversationSnapshotRefreshTarget({
      eventId: 'evt-1',
      eventType: 'REPLY_JOB_WAITING_HUMAN',
      workspaceId: 'workspace-1',
      entityType: 'REPLY_JOB',
      entityId: 'reply-job-1',
      entityVersion: 1,
      occurredAt: '2026-08-27T10:00:00.000Z',
      payload: { conversationId: 'conversation-1', replyJobId: 'reply-job-1' },
    })).toBe('conversation-1');
    expect(conversationSnapshotRefreshTarget({
      eventId: 'evt-2',
      eventType: 'ORDER_UPDATED',
      workspaceId: 'workspace-1',
      entityType: 'ORDER',
      entityId: 'order-1',
      entityVersion: 2,
      occurredAt: '2026-08-27T10:00:01.000Z',
      payload: { shopId: 'shop-1', orderId: 'order-1' },
    })).toBe('');
    expect(conversationSnapshotRefreshTarget({
      eventId: 'evt-3',
      eventType: 'PRODUCT_UPDATED',
      workspaceId: 'workspace-1',
      entityType: 'PRODUCT',
      entityId: 'product-1',
      entityVersion: 3,
      occurredAt: '2026-08-27T10:00:02.000Z',
      payload: { shopId: 'shop-1', productId: 'product-1' },
    })).toBeUndefined();
  });

  it('refreshes the selected conversation for the current backend refresh marker', () => {
    expect(conversationSnapshotRefreshTarget({
      eventId: 'evt-refresh',
      eventType: 'CONVERSATION_UPDATED',
      workspaceId: 'workspace-1',
      entityType: 'CONVERSATION',
      entityId: 'conversation-1',
      entityVersion: 5,
      occurredAt: '2026-08-27T10:00:02.500Z',
      payload: { conversationId: 'conversation-1', refresh: true },
    })).toBe('conversation-1');
  });

  it('invokes the REST snapshot loader for the selected reliability event target', async () => {
    const refresh = async (conversationId: string) => conversationId;
    const called: string[] = [];
    const observed = await refreshConversationForWorkspaceEvent({
      eventId: 'evt-4',
      eventType: 'REPLY_SENT',
      workspaceId: 'workspace-1',
      entityType: 'REPLY',
      entityId: 'reply-1',
      entityVersion: 1,
      occurredAt: '2026-08-27T10:00:03.000Z',
      payload: { conversationId: 'conversation-1', sendOutboxId: 'outbox-1' },
    }, 'conversation-1', async (conversationId) => {
      called.push(await refresh(conversationId));
    });
    expect(observed).toBe(true);
    expect(called).toEqual(['conversation-1']);
  });

  it('does not duplicate global snapshot reloads on pages that reconcile the same realtime event directly', () => {
    const event = {
      eventId: 'evt-scoped', eventType: 'REPLY_JOB_STREAM', workspaceId: 'workspace-1', entityType: 'REPLY_JOB',
      entityId: 'reply-job-1', entityVersion: 4, occurredAt: '2026-08-27T10:00:03.000Z',
      payload: { conversationId: 'conversation-1', replyJobId: 'reply-job-1' },
    } as const;

    expect(shouldAdvanceGlobalSnapshotVersion('/showcase', event)).toBe(false);
    expect(shouldAdvanceGlobalSnapshotVersion('/live-test/shop-1', event)).toBe(false);
    expect(shouldAdvanceGlobalSnapshotVersion('/workbench/shops/shop-1', event)).toBe(true);
  });

  it('validates ConversationUpdated against the emitted nested conversation snapshot shape', () => {
    const schema = JSON.parse(websocketSchemaText) as { $defs: Record<string, SchemaDefinition> };
    const conversationUpdated = schema.$defs.ConversationUpdatedPayload;
    if (!conversationUpdated) throw new Error('ConversationUpdatedPayload schema is missing');
    expect(conversationUpdated.required).toEqual(['conversationId']);
    expect(conversationUpdated.oneOf).toHaveLength(2);
    const snapshotBranch = conversationUpdated.oneOf?.find((branch) => branch.required?.includes('conversation'));
    const refreshBranch = conversationUpdated.oneOf?.find((branch) => branch.required?.includes('refresh'));
    expect(snapshotBranch?.required).toEqual(expect.arrayContaining(['conversation']));
    expect(refreshBranch?.required).toEqual(expect.arrayContaining(['refresh']));
    expect(conversationUpdated.properties?.conversation?.type).toBe('object');
    expect(conversationUpdated.properties?.conversation?.required).toEqual(
      expect.arrayContaining(['id', 'shopId', 'effectiveMode', 'contextVersion']),
    );
    expect(conversationUpdated.properties?.refresh).toMatchObject({ const: true });

    const emittedPayload = {
      conversationId: 'conversation-1',
      conversation: {
        id: 'conversation-1',
        workspaceId: 'workspace-1',
        tenantId: 'tenant-1',
        shopId: 'shop-1',
        buyerId: 'buyer-1',
        state: 'ACTIVE',
        mode: 'ASSIST',
        effectiveMode: 'ASSIST',
        syncState: 'CONNECTED',
        contextVersion: 4,
        lastCommittedSequence: 9,
        humanActive: false,
        needsReplan: false,
        buyer: { id: 'buyer-1', displayName: '小林' },
      },
    };
    expect(emittedPayload.conversation.id).toBe(emittedPayload.conversationId);
    expect(emittedPayload.conversation.effectiveMode).toBe('ASSIST');
  });

  it('renders UNCERTAIN as a recovery state instead of a successful send', () => {
    expect(sendOutboxStatusLabel('UNCERTAIN')).toBe('结果待确认');
    expect(sendOutboxStatusLabel('SENT')).toBe('发送成功');
  });

  it('enforces the selected shop AI mode ceiling in Workbench mode options', () => {
    expect(isConversationModeAllowed('AUTO', 'ASSIST_ONLY')).toBe(false);
    expect(conversationModeOptionLabel('AUTO', 'ASSIST_ONLY')).toContain('店铺上限');
    expect(isConversationModeAllowed('AUTO', 'MANUAL_ONLY')).toBe(false);
    expect(isConversationModeAllowed('ASSIST', 'MANUAL_ONLY')).toBe(false);
    expect(isConversationModeAllowed('MANUAL', 'MANUAL_ONLY')).toBe(true);
    expect(isConversationModeAllowed('ASSIST', 'ASSIST_ONLY')).toBe(true);
    expect(isConversationModeAllowed('AUTO', 'AUTO_ALLOWED')).toBe(true);
  });
});
