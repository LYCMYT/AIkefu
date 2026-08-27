import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AttachmentService } from '../attachments/attachments.service';
import { PrismaService } from '../database/prisma.service';

export const CHAT_RETENTION_DAYS = 45;
export const CONVERSATION_SUMMARY_RETENTION_DAYS = 90;
export const RETENTION_REDACTED_TEXT = '[redacted by retention policy]';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHAT_RETENTION_TOMBSTONE = { redacted: true, reason: 'CHAT_RETENTION_EXPIRED' };
const MEMORY_RETENTION_TOMBSTONE = { redacted: true, reason: 'CUSTOMER_MEMORY_EXPIRED' };

export type DataRetentionResult = {
  attachmentsExpired: number;
  messagesRedacted: number;
  messageVersionsRedacted: number;
  reorderEntriesDeleted: number;
  processingOutboxesDeleted: number;
  processingReceiptsDeleted: number;
  userTurnsRedacted: number;
  replyDraftsRedacted: number;
  tasksRedacted: number;
  workflowNodeRunsRedacted: number;
  workflowProposalsRedacted: number;
  workflowProposalsInvalidated: number;
  sendOutboxesRedacted: number;
  qualityReviewsRedacted: number;
  incidentsRedacted: number;
  regressionCasesRedacted: number;
  traceEventsRedacted: number;
  summariesDeleted: number;
  customerMemoriesExpired: number;
};

/**
 * The single server-side lifecycle entrypoint. All work is idempotent: image
 * object deletion keeps a durable Attachment tombstone, while relational data
 * is redacted/deleted in one database transaction and retried by the worker.
 */
@Injectable()
export class DataRetentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentService,
  ) {}

  async runOnce(now = new Date()): Promise<DataRetentionResult> {
    // AttachmentService advances metadata only after object storage confirms
    // deletion. Run it through this common entrypoint rather than maintaining
    // a separate image-only timer.
    const attachmentsExpired = await this.attachments.cleanupExpired(now);
    const chatCutoff = subtractDays(now, CHAT_RETENTION_DAYS);
    const summaryCutoff = subtractDays(now, CONVERSATION_SUMMARY_RETENTION_DAYS);

    const result = await this.prisma.$transaction(async (tx) => {
      // Current message/outbox producers persist only opaque ids after a
      // Message commit, except ScheduledMessage text. Remove all stale
      // outboxes rather than relying on that implementation detail forever.
      const staleOutboxes = await tx.processingOutbox.findMany({
        where: { createdAt: { lte: chatCutoff } },
        select: { eventId: true },
      });
      const staleEventIds = staleOutboxes.map((entry) => entry.eventId);
      const [messages, messageVersions, reorderEntries, processingOutboxes, processingReceipts, userTurns, replyDrafts, tasks, workflowNodeRuns, workflowProposals, invalidatedWorkflowProposals, sentOutboxes, pendingOutboxes, qualityReviews, incidents, regressionCases, traceEvents, summaries, memories] = await Promise.all([
        tx.message.updateMany({
          // Status is not a privacy marker: recalled/deleted rows can still
          // carry the original body. Only the exact tombstone is idempotent.
          where: { sentAt: { lte: chatCutoff }, NOT: { contentJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } } },
          data: { status: 'DELETED', contentJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue },
        }),
        tx.messageVersion.updateMany({
          where: { editedAt: { lte: chatCutoff }, NOT: { contentJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } } },
          data: { status: 'DELETED', contentJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue },
        }),
        // ReorderBufferEntry is a short-lived recovery record but its
        // payloadJson is the complete untrusted incoming message. Deletion is
        // safe after retention; it is never an aggregate or audit record.
        tx.reorderBufferEntry.deleteMany({ where: { createdAt: { lte: chatCutoff } } }),
        tx.processingOutbox.deleteMany({ where: { createdAt: { lte: chatCutoff } } }),
        staleEventIds.length
          ? tx.processingReceipt.deleteMany({ where: { eventId: { in: staleEventIds } } })
          : Promise.resolve({ count: 0 }),
        // UserTurn's normalized text and multimodal summary can contain the
        // exact original chat, even after Message is redacted.
        tx.userTurn.updateMany({
          where: { createdAt: { lte: chatCutoff }, normalizedText: { not: RETENTION_REDACTED_TEXT } },
          data: {
            normalizedText: RETENTION_REDACTED_TEXT,
            multimodalSummaryJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
          },
        }),
        // Drafts are a second copy of a conversation answer. Keep their
        // lifecycle metadata but remove the text once chat retention ends.
        tx.replyDraft.updateMany({
          where: { createdAt: { lte: chatCutoff }, aiDraft: { not: RETENTION_REDACTED_TEXT } },
          data: { aiDraft: RETENTION_REDACTED_TEXT, humanFinal: null, staleReason: 'RETENTION_REDACTED' },
        }),
        // Workflow state is derived from a conversation. Node/task outputs can
        // include a generated response or a human-entered reason, so retain
        // lifecycle facts while replacing all durable content after 45 days.
        tx.task.updateMany({
          where: { createdAt: { lte: chatCutoff }, NOT: { resultJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } } },
          data: {
            requiredContextJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            requiredKnowledgeJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            requiredToolsJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            resultJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
          },
        }),
        tx.workflowNodeRun.updateMany({
          where: { createdAt: { lte: chatCutoff }, NOT: { outputJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } } },
          data: {
            inputJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            outputJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
          },
        }),
        tx.workflowProposal.updateMany({
          where: { createdAt: { lte: chatCutoff }, NOT: { payloadJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } } },
          data: {
            payloadJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            executionJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            receiptJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            rejectedReason: null,
          },
        }),
        // Pending approval/action work cannot be executed after its source
        // content has been erased. Mark it stale once; completed lifecycle
        // facts remain untouched.
        tx.workflowProposal.updateMany({
          where: {
            createdAt: { lte: chatCutoff },
            status: { in: ['PROPOSED', 'POLICY_CHECKED', 'WAITING_APPROVAL', 'APPROVED', 'REVALIDATING', 'EXECUTING', 'UNCERTAIN'] },
          },
          data: { status: 'STALE', failureCode: 'RETENTION_REDACTED', decidedAt: now },
        }),
        // A sent result stays an anonymous delivery fact, but its textual
        // payload/receipt are not retained. A pending 45-day delivery is
        // failed closed so no redacted text can be dispatched later.
        tx.sendOutbox.updateMany({
          where: {
            createdAt: { lte: chatCutoff },
            status: { in: ['SENT', 'FAILED'] },
            OR: [{ failureReason: null }, { failureReason: { not: 'RETENTION_REDACTED' } }],
          },
          data: {
            payloadJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            receiptJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            failureReason: 'RETENTION_REDACTED',
          },
        }),
        tx.sendOutbox.updateMany({
          where: { createdAt: { lte: chatCutoff }, status: { in: ['PENDING', 'SENDING', 'UNCERTAIN'] } },
          data: {
            status: 'FAILED',
            payloadJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            receiptJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            failureCode: 'RETENTION_REDACTED',
            failureReason: 'RETENTION_REDACTED',
          },
        }),
        // Quality keeps verdicts, deterministic counts and metrics, but not
        // frozen reply text or a judge output that could quote it back.
        tx.qualityReview.updateMany({
          where: {
            createdAt: { lte: chatCutoff },
            NOT: { replySnapshotJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } },
          },
          data: {
            replySnapshotJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            judgeResultJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
          },
        }),
        // Incident root-cause category/severity remain useful anonymous facts;
        // answer/correction snapshots and free-form diagnosis do not.
        tx.replyIncident.updateMany({
          where: { createdAt: { lte: chatCutoff }, originalAnswerSnapshot: { not: RETENTION_REDACTED_TEXT } },
          data: {
            originalAnswerSnapshot: RETENTION_REDACTED_TEXT,
            correctedAnswer: null,
            rootCause: null,
            regressionCaseJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
          },
        }),
        // A generated regression case may retain a correction answer. Retain
        // its anonymous lifecycle row while removing executable chat content.
        tx.evalCase.updateMany({
          where: { source: 'REGRESSION', createdAt: { lte: chatCutoff }, status: { not: 'REDACTED' } },
          data: {
            status: 'REDACTED',
            inputJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            expectedJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
          },
        }),
        // TraceService strips unsafe keys on every write. Redacting old
        // conversation-linked payloads as well protects legacy/custom callers
        // that may have used an unrecognised field name, while retaining trace
        // IDs, stages and timestamps as minimal diagnostic facts.
        tx.traceEvent.updateMany({
          where: {
            createdAt: { lte: chatCutoff },
            conversationId: { not: null },
            NOT: { payloadJson: { equals: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue } },
          },
          data: { payloadJson: CHAT_RETENTION_TOMBSTONE as Prisma.InputJsonValue },
        }),
        tx.conversationMemory.deleteMany({ where: { updatedAt: { lte: summaryCutoff } } }),
        // An expired memory must be inaccessible even to an internal direct
        // database read. The tombstone leaves no preference/case content.
        tx.customerMemory.updateMany({
          where: { expiresAt: { lte: now }, status: { not: 'DELETED' } },
          data: {
            status: 'DELETED',
            key: RETENTION_REDACTED_TEXT,
            valueJson: MEMORY_RETENTION_TOMBSTONE as Prisma.InputJsonValue,
            updatedBy: 'RETENTION',
          },
        }),
      ]);
      return {
        messagesRedacted: messages.count,
        messageVersionsRedacted: messageVersions.count,
        reorderEntriesDeleted: reorderEntries.count,
        processingOutboxesDeleted: processingOutboxes.count,
        processingReceiptsDeleted: processingReceipts.count,
        userTurnsRedacted: userTurns.count,
        replyDraftsRedacted: replyDrafts.count,
        tasksRedacted: tasks.count,
        workflowNodeRunsRedacted: workflowNodeRuns.count,
        workflowProposalsRedacted: workflowProposals.count,
        workflowProposalsInvalidated: invalidatedWorkflowProposals.count,
        sendOutboxesRedacted: sentOutboxes.count + pendingOutboxes.count,
        qualityReviewsRedacted: qualityReviews.count,
        incidentsRedacted: incidents.count,
        regressionCasesRedacted: regressionCases.count,
        traceEventsRedacted: traceEvents.count,
        summariesDeleted: summaries.count,
        customerMemoriesExpired: memories.count,
      };
    });

    return { attachmentsExpired, ...result };
  }
}

function subtractDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
