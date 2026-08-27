import {
  CHAT_RETENTION_DAYS,
  CONVERSATION_SUMMARY_RETENTION_DAYS,
  DataRetentionService,
} from '../src/lifecycle/data-retention.service';

describe('DataRetentionService', () => {
  const now = new Date('2026-08-27T12:00:00.000Z');

  it('runs one durable lifecycle entry: 15-day attachment cleanup, 45-day chat redaction, 90-day summaries, and expired memory scrubbing', async () => {
    const tx = {
      message: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
      messageVersion: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      reorderBufferEntry: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
      processingOutbox: {
        findMany: jest.fn().mockResolvedValue([{ eventId: 'event-a' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      processingReceipt: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userTurn: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      workflowNodeRun: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      workflowProposal: { updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }) },
      sendOutbox: { updateMany: jest.fn().mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 }) },
      qualityReview: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      replyIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      evalCase: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      traceEvent: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      conversationMemory: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
      customerMemory: { updateMany: jest.fn().mockResolvedValue({ count: 6 }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const attachments = { cleanupExpired: jest.fn().mockResolvedValue(7) };
    const service = new DataRetentionService(prisma as never, attachments as never);

    await expect(service.runOnce(now)).resolves.toEqual({
      attachmentsExpired: 7,
      messagesRedacted: 4,
      messageVersionsRedacted: 3,
      reorderEntriesDeleted: 2,
      processingOutboxesDeleted: 1,
      processingReceiptsDeleted: 1,
      userTurnsRedacted: 2,
      replyDraftsRedacted: 1,
      tasksRedacted: 2,
      workflowNodeRunsRedacted: 3,
      workflowProposalsRedacted: 1,
      workflowProposalsInvalidated: 1,
      sendOutboxesRedacted: 3,
      qualityReviewsRedacted: 1,
      incidentsRedacted: 1,
      regressionCasesRedacted: 1,
      traceEventsRedacted: 2,
      summariesDeleted: 5,
      customerMemoriesExpired: 6,
    });

    const chatCutoff = new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const summaryCutoff = new Date(now.getTime() - CONVERSATION_SUMMARY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(attachments.cleanupExpired).toHaveBeenCalledWith(now);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { sentAt: { lte: chatCutoff }, NOT: { contentJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } } },
      data: {
        status: 'DELETED',
        contentJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' },
      },
    });
    expect(tx.messageVersion.updateMany).toHaveBeenCalledWith({
      where: { editedAt: { lte: chatCutoff }, NOT: { contentJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } } },
      data: {
        status: 'DELETED',
        contentJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' },
      },
    });
    // Reorder entries are the only durable queue record that stores the raw
    // normalized incoming payload. Old entries are removed, not merely marked.
    expect(tx.reorderBufferEntry.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lte: chatCutoff } } });
    expect(tx.processingOutbox.findMany).toHaveBeenCalledWith({
      where: { createdAt: { lte: chatCutoff } }, select: { eventId: true },
    });
    expect(tx.processingReceipt.deleteMany).toHaveBeenCalledWith({ where: { eventId: { in: ['event-a'] } } });
    expect(tx.userTurn.updateMany).toHaveBeenCalledWith({
      where: { createdAt: { lte: chatCutoff }, normalizedText: { not: '[redacted by retention policy]' } },
      data: {
        normalizedText: '[redacted by retention policy]',
        multimodalSummaryJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' },
      },
    });
    expect(tx.replyDraft.updateMany).toHaveBeenCalledWith({
      where: { createdAt: { lte: chatCutoff }, aiDraft: { not: '[redacted by retention policy]' } },
      data: { aiDraft: '[redacted by retention policy]', humanFinal: null, staleReason: 'RETENTION_REDACTED' },
    });
    // Tasks and workflow node/proposal payloads are derived state, but may
    // include a generated reply or a human-entered reason. Tombstone all
    // textual JSON from old conversation work and make pending actions stale.
    expect(tx.task.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { lte: chatCutoff }, NOT: { resultJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } } }),
      data: expect.objectContaining({ resultJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } }),
    }));
    expect(tx.workflowNodeRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { lte: chatCutoff }, NOT: { outputJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } } }),
      data: expect.objectContaining({ inputJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' }, outputJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } }),
    }));
    expect(tx.workflowProposal.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ createdAt: { lte: chatCutoff }, NOT: { payloadJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } } }),
      data: expect.objectContaining({ payloadJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' }, rejectedReason: null }),
    }));
    expect(tx.workflowProposal.updateMany).toHaveBeenNthCalledWith(2, {
      where: { createdAt: { lte: chatCutoff }, status: { in: ['PROPOSED', 'POLICY_CHECKED', 'WAITING_APPROVAL', 'APPROVED', 'REVALIDATING', 'EXECUTING', 'UNCERTAIN'] } },
      data: { status: 'STALE', failureCode: 'RETENTION_REDACTED', decidedAt: now },
    });
    expect(tx.sendOutbox.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        createdAt: { lte: chatCutoff },
        status: { in: ['SENT', 'FAILED'] },
        OR: [{ failureReason: null }, { failureReason: { not: 'RETENTION_REDACTED' } }],
      },
      data: expect.objectContaining({ payloadJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' }, receiptJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } }),
    });
    expect(tx.sendOutbox.updateMany).toHaveBeenNthCalledWith(2, {
      where: { createdAt: { lte: chatCutoff }, status: { in: ['PENDING', 'SENDING', 'UNCERTAIN'] } },
      data: expect.objectContaining({ status: 'FAILED', failureCode: 'RETENTION_REDACTED' }),
    });
    expect(tx.qualityReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { lte: chatCutoff } }),
      data: expect.objectContaining({ replySnapshotJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' }, judgeResultJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } }),
    }));
    expect(tx.replyIncident.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ createdAt: { lte: chatCutoff }, originalAnswerSnapshot: { not: '[redacted by retention policy]' } }),
      data: expect.objectContaining({ originalAnswerSnapshot: '[redacted by retention policy]', correctedAnswer: null, rootCause: null }),
    }));
    expect(tx.evalCase.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { source: 'REGRESSION', createdAt: { lte: chatCutoff }, status: { not: 'REDACTED' } },
      data: expect.objectContaining({ status: 'REDACTED', inputJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' }, expectedJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } }),
    }));
    // Trace service denies raw input at write time; this second 45-day pass
    // also removes any legacy/unknown trace payload linked to a conversation.
    expect(tx.traceEvent.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lte: chatCutoff }, conversationId: { not: null },
        NOT: { payloadJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } },
      },
      data: { payloadJson: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } },
    });
    expect(tx.conversationMemory.deleteMany).toHaveBeenCalledWith({ where: { updatedAt: { lte: summaryCutoff } } });
    expect(tx.customerMemory.updateMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now }, status: { not: 'DELETED' } },
      data: {
        status: 'DELETED',
        key: '[redacted by retention policy]',
        valueJson: { redacted: true, reason: 'CUSTOMER_MEMORY_EXPIRED' },
        updatedBy: 'RETENTION',
      },
    });
  });

  it('does not mistake a historical DELETED or RECALLED status for a privacy tombstone', async () => {
    const tx = {
      message: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      messageVersion: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      reorderBufferEntry: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      processingOutbox: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      processingReceipt: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      userTurn: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyDraft: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      task: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      workflowNodeRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      workflowProposal: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      sendOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      qualityReview: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      replyIncident: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      evalCase: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      traceEvent: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      conversationMemory: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      customerMemory: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = { $transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
    const service = new DataRetentionService(prisma as never, { cleanupExpired: jest.fn().mockResolvedValue(0) } as never);

    await service.runOnce(now);
    const messageWhere = tx.message.updateMany.mock.calls[0][0].where;
    const versionWhere = tx.messageVersion.updateMany.mock.calls[0][0].where;
    expect(messageWhere).not.toHaveProperty('status');
    expect(versionWhere).not.toHaveProperty('status');
    expect(messageWhere.NOT).toEqual({ contentJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } });
    expect(versionWhere.NOT).toEqual({ contentJson: { equals: { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' } } });
  });

  it('does not report a successful lifecycle pass when durable metadata cleanup fails', async () => {
    const prisma = { $transaction: jest.fn().mockRejectedValue(new Error('database unavailable')) };
    const attachments = { cleanupExpired: jest.fn().mockResolvedValue(0) };
    const service = new DataRetentionService(prisma as never, attachments as never);

    await expect(service.runOnce(now)).rejects.toThrow('database unavailable');
    expect(attachments.cleanupExpired).toHaveBeenCalledWith(now);
  });
});
