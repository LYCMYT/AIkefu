import { io } from 'socket.io-client';
import type { WorkspaceEventEnvelope } from '@ai-customer-service/contracts';

export type WorkspaceSocketStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

const heartbeatIntervalMs = 30_000;

export type WorkspaceSocketEvent = WorkspaceEventEnvelope | Record<string, unknown>;

/** Pages with a scoped realtime reconciler must not also reload their whole
 * snapshot for the same event. Explicit reset/reconnect refreshes still use
 * the independent snapshot version counter. */
export function shouldAdvanceGlobalSnapshotVersion(pathname: string, _event: WorkspaceSocketEvent): boolean {
  return pathname !== '/showcase' && !pathname.startsWith('/live-test/');
}

const conversationSnapshotEventTypes = new Set([
  'CONVERSATION_UPDATED',
  'MESSAGE_RECEIVED',
  'MESSAGE_EDITED',
  'MESSAGE_RECALLED',
  'USER_TURN_CREATED',
  'REPLY_JOB_STARTED',
  'REPLY_JOB_STREAM',
  'REPLY_JOB_WAITING_HUMAN',
  'REPLY_JOB_STALE',
  'REPLY_JOB_EXPIRED',
  'REPLY_SENT',
  'ORDER_UPDATED',
]);

/**
 * Return the conversation that should be reconciled after a pushed event.
 * An empty string means the event is conversation-relevant but has no
 * conversation id (for example an order update), so the selected conversation
 * may still be refreshed. Undefined means the event belongs to another UI
 * projection and should not trigger a Workbench conversation GET.
 */
export function conversationSnapshotRefreshTarget(event: WorkspaceSocketEvent): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  const eventType = typeof record.eventType === 'string' ? record.eventType : '';
  if (!conversationSnapshotEventTypes.has(eventType)) return undefined;
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : undefined;
  if (typeof payload?.conversationId === 'string' && payload.conversationId) return payload.conversationId;
  if (eventType === 'CONVERSATION_UPDATED' && payload?.conversation && typeof payload.conversation === 'object') {
    const conversation = payload.conversation as Record<string, unknown>;
    if (typeof conversation.id === 'string' && conversation.id) return conversation.id;
  }
  if (record.entityType === 'CONVERSATION' && typeof record.entityId === 'string' && record.entityId) return record.entityId;
  return '';
}

/** Invoke the canonical REST snapshot loader only for the selected conversation. */
export async function refreshConversationForWorkspaceEvent(
  event: WorkspaceSocketEvent,
  selectedConversationId: string,
  refresh: (conversationId: string) => Promise<unknown>,
): Promise<boolean> {
  if (!selectedConversationId) return false;
  const target = conversationSnapshotRefreshTarget(event);
  if (target === undefined || (target && target !== selectedConversationId)) return false;
  await refresh(selectedConversationId);
  return true;
}

/**
 * Keep the transport small and stateless: the server is the source of truth,
 * while App decides when a REST snapshot is needed after an event/reconnect.
 */
export function connectWorkspaceSocket(
  token: string,
  onStatus: (status: WorkspaceSocketStatus) => void,
  onEvent?: (event: WorkspaceSocketEvent) => void,
): () => void {
  const origin = import.meta.env.VITE_WS_BASE_URL ?? window.location.origin;
  const socket = io(origin, {
    path: import.meta.env.VITE_WS_PATH ?? '/ws',
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
  });
  let heartbeatTimer: number | undefined;
  let disposed = false;
  const seenEventIds = new Set<string>();

  const heartbeat = () => {
    if (disposed) return;
    socket.timeout(5_000).emit('workspace.heartbeat', {}, (error: Error | null) => {
      if (error && !disposed) onStatus('disconnected');
    });
  };

  const handleEvent = (value: unknown) => {
    if (!onEvent || !value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    const eventId = typeof event.eventId === 'string' ? event.eventId : undefined;
    if (eventId) {
      if (seenEventIds.has(eventId)) return;
      seenEventIds.add(eventId);
      if (seenEventIds.size > 300) {
        const first = seenEventIds.values().next().value;
        if (typeof first === 'string') seenEventIds.delete(first);
      }
    }
    onEvent(value as WorkspaceSocketEvent);
  };

  onStatus('connecting');
  socket.on('connect', () => {
    if (disposed) return;
    onStatus('connected');
    heartbeat();
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
    heartbeatTimer = window.setInterval(heartbeat, heartbeatIntervalMs);
  });
  socket.on('disconnect', () => {
    if (disposed) return;
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    onStatus('disconnected');
  });
  socket.on('connect_error', () => { if (!disposed) onStatus('disconnected'); });
  // The gateway can publish one generic event or event-type named events.
  socket.on('workspace.event', handleEvent);
  socket.onAny((eventName, value) => {
    if (eventName === 'workspace.event' || eventName === 'workspace.heartbeat') return;
    if (typeof value === 'object' && value !== null && 'eventType' in value) handleEvent(value);
  });

  return () => {
    disposed = true;
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    socket.off('workspace.event', handleEvent);
    socket.disconnect();
    onStatus('idle');
  };
}
