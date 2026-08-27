import { QualityReviewService } from '../src/quality/quality-review.service';

const scope = { workspaceId: 'workspace-a', tenantId: 'tenant-a', shopId: 'shop-a' };

describe('QualityReviewService', () => {
  it('is manually triggered, freezes scoped reply/evidence facts, and fails closed to NEEDS_HUMAN when Judge fails', async () => {
    const tx = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation-a', contextVersion: 4 }) },
      message: { findMany: jest.fn().mockResolvedValue([{ id: 'reply-a', role: 'ASSISTANT', contentJson: { text: '合成答复' }, sequence: 4 }]) },
      replyEvidence: { findMany: jest.fn().mockResolvedValue([{ id: 'evidence-a', retrievedContentSnapshotJson: { question: 'q', answer: 'a' } }]) },
      qualityReview: { create: jest.fn().mockResolvedValue({ id: 'quality-a', status: 'PENDING' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const judge = { runStructured: jest.fn().mockRejectedValue(new Error('provider down')) };
    const prisma = { $transaction: jest.fn((work: Function) => work(tx)), qualityReview: tx.qualityReview };
    const service = new QualityReviewService(prisma as never, judge as never);
    await expect(service.start(scope, { conversationId: 'conversation-a', createdBy: 'operator-a' })).resolves.toMatchObject({
      id: 'quality-a', status: 'NEEDS_HUMAN', sampleSize: 1,
      metrics: {
        frozenReplyCount: 1, frozenEvidenceCount: 1, frozenSendCount: 0,
        deterministicCheckCount: 6, deterministicCheckPassedCount: 6, deterministicCheckPassRate: 1,
      },
    });
    expect(tx.message.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ...scope, conversationId: 'conversation-a', role: { in: ['ASSISTANT', 'HUMAN'] } }) }));
    expect(tx.qualityReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'NEEDS_HUMAN',
      metricsJson: expect.objectContaining({ frozenReplyCount: 1, deterministicCheckPassRate: 1 }),
    }) }));
  });

  it('rewrites only frozen deterministic metrics when a human concludes an actionable review', async () => {
    const metrics = {
      frozenReplyCount: 1, frozenEvidenceCount: 1, frozenSendCount: 0,
      deterministicCheckCount: 6, deterministicCheckPassedCount: 5, deterministicCheckPassRate: 5 / 6,
    };
    const review = { id: 'quality-a', conversationId: 'conversation-a', sampleSize: 1, status: 'NEEDS_HUMAN', metricsJson: metrics };
    const prisma = {
      qualityReview: {
        findFirst: jest.fn().mockResolvedValue(review),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new QualityReviewService(prisma as never, {} as never);

    const concluded = await service.conclude(scope, 'quality-a', 'PASS');

    expect(concluded).toMatchObject({ id: 'quality-a', status: 'PASS', humanResult: 'PASS', sampleSize: 1, metrics });
    expect(concluded).not.toHaveProperty('metricsJson');
    expect(prisma.qualityReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'quality-a', ...scope, status: { in: ['AUTO_REVIEWED', 'NEEDS_HUMAN'] } },
      data: expect.objectContaining({ status: 'PASS', humanResult: 'PASS', metricsJson: metrics }),
    }));
  });
});
