import { coalesceTaskBundles, createTaskBundle, decideReplyPolicy, resolveContext } from '@ai-customer-service/core';
import { ReplyJobService } from '../src/replies/reply-job.service';
import { ReplyRuntimeService } from '../src/replies/reply-runtime.service';
import { ConversationReplyControlService } from '../src/replies/conversation-reply-control.service';
import { ReplyRecoveryService } from '../src/replies/reply-recovery.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

/**
 * Acceptance-shaped API harness. It uses production services/core policies;
 * only the database/model ports are tiny scoped fakes so it remains fast and
 * deterministic without a shared Postgres/Redis runtime.
 */
describe('Phase 04 Case 04–10 reliability harness', () => {
  it('Case 04: coalesces a continuous user turn into exactly one idempotent ReplyJob', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userTurn: { findFirst: jest.fn().mockResolvedValue({ id: 'turn-a' }) },
      replyJob: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'reply-a', status: 'PENDING' }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), create: jest.fn().mockResolvedValue({ id: 'reply-a', status: 'PENDING' }),
      },
      replyDraft: { updateMany: jest.fn() },
      replyEvidence: { createMany: jest.fn() },
    };
    const service = new ReplyJobService({ $transaction: jest.fn((work: Function) => work(tx)) } as never);
    const input = { conversationId: 'conversation-a', userTurnId: 'turn-a', mode: 'AUTO' as const, sourceLastMessageId: 'message-3', sourceSequence: 3, sourceContextVersion: 5, idempotencyKey: 'reply:turn-a', evidence: [] };

    await Promise.all([service.create(scope, input), service.create(scope, input)]);
    expect(tx.replyJob.create).toHaveBeenCalledTimes(1);
  });

  it('Case 05: a new message/context change makes an in-flight ReplyJob stale before composition', async () => {
    const prisma = {
      replyJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'reply-a', status: 'PENDING', mode: 'AUTO', conversationId: 'conversation-a', userTurnId: 'turn-a', sourceContextVersion: 4,
          sourceSequence: 5, evidences: [], conversation: { contextVersion: 5, humanActive: false, state: 'ACTIVE' }, userTurn: { normalizedText: '我是新疆的' },
        }), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const runtime = new ReplyRuntimeService(prisma as never, { search: jest.fn() } as never, { runStructured: jest.fn() } as never, {} as never, {} as never);

    await expect(runtime.process(scope, 'reply-a')).resolves.toMatchObject({ status: 'STALE', reason: 'CONTEXT_STALE' });
  });

  it('Case 06: two buyers can progress independently while each ReplyJob read remains exact-scope', async () => {
    const prisma = { replyJob: { findFirst: jest.fn().mockResolvedValue(null), }, $transaction: jest.fn() };
    const service = new ReplyJobService(prisma as never);
    await Promise.all([
      service.get(scope, 'reply-for-buyer-a'),
      service.get({ ...scope, shopId: 'shop-b' }, 'reply-for-buyer-b'),
    ]);
    expect(prisma.replyJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'reply-for-buyer-a', ...scope } }));
    expect(prisma.replyJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'reply-for-buyer-b', ...scope, shopId: 'shop-b' } }));
  });

  it('Case 07: a cross-shop ReplyJob never leaks shop-A evidence into shop-B', async () => {
    const prisma = { replyJob: { findFirst: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn() };
    const service = new ReplyJobService(prisma as never);
    await expect(service.get({ ...scope, shopId: 'shop-b' }, 'reply-a')).resolves.toBeNull();
    expect(prisma.replyJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'reply-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-b' } }));
  });

  it('Case 08: multiple order candidates remain ambiguous and stop after two clarification rounds', () => {
    const result = resolveContext({
      kind: 'ORDER', riskLevel: 'LOW', clarificationRounds: 2,
      candidates: [{ id: 'order-1', kind: 'ORDER', label: '订单 1' }, { id: 'order-2', kind: 'ORDER', label: '订单 2' }],
    });
    expect(result).toMatchObject({ status: 'AMBIGUOUS', manualRequired: true, clarification: null });
  });

  it('Case 09: a human takeover is a durable manual ceiling and cannot be weakened by AUTO policy', () => {
    const decision = decideReplyPolicy({
      shopMode: 'AUTO_ALLOWED', syncState: 'CONNECTED', humanActive: true, taskRisks: ['LOW'], contextStatus: 'RESOLVED',
      hasEvidence: true, hasBlockingFailure: false, userRequestedHuman: false,
    });
    expect(decision).toMatchObject({ mode: 'MANUAL', reasons: expect.arrayContaining(['HUMAN_ACTIVE']) });
  });

  it('Case 10: restart recovery moves only context-valid GENERATING jobs to RECOVERY_PENDING and leaves sends for UNCERTAIN handling', async () => {
    const prisma = {
      replyJob: {
        findMany: jest.fn().mockResolvedValue([{ id: 'reply-a', ...scope, conversationId: 'conversation-a', sourceContextVersion: 5 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 5, humanActive: false, state: 'ACTIVE' }) },
    };
    const sends = { recoverUncertain: jest.fn().mockResolvedValue(1) };
    const drafts = { expireDueAll: jest.fn().mockResolvedValue(0) };
    const recovery = new ReplyRecoveryService(prisma as never, sends as never, drafts as never);

    await expect(recovery.recoverOnce(new Date('2026-08-30T00:00:00.000Z'))).resolves.toEqual({ recoveryPending: 1, stale: 0, uncertain: 1, expiredDrafts: 0 });
  });

  it('Case 04 coalescing guard: only the newest task set is actionable when the buyer adds a message', () => {
    const first = createTaskBundle({ tasks: [{ id: 'task-1', intent: 'SHIPPING_POLICY', operation: 'READ', riskLevel: 'LOW', requiredContext: [], requiredTools: [], blocking: false }] });
    const next = createTaskBundle({ tasks: [{ id: 'task-2', intent: 'SHIPPING_POLICY', operation: 'READ', riskLevel: 'LOW', requiredContext: ['LOGISTICS'], requiredTools: [], blocking: false }] });
    expect(coalesceTaskBundles(first, next)).toMatchObject({ needsReplan: true, supersededTaskIds: ['task-1'], tasks: [expect.objectContaining({ id: 'task-2' })] });
  });
});
