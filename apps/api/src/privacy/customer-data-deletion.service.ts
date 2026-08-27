import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { CustomerDataDeletionResult } from '@ai-customer-service/contracts';
import { AttachmentService } from '../attachments/attachments.service';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';

export type { CustomerDataDeletionResult } from '@ai-customer-service/contracts';

/**
 * Delete Customer Data is intentionally workspace/tenant scoped. It removes
 * customer-facing and derived chat state, physically removes image objects via
 * AttachmentService, and retains only non-identifying order aggregates.
 */
@Injectable()
export class CustomerDataDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentService,
  ) {}

  async deleteCustomerData(
    scope: WorkspaceScope,
    buyerId: string,
    now = new Date(),
  ): Promise<CustomerDataDeletionResult> {
    const id = buyerId?.trim();
    if (!scope?.workspaceId || !scope.tenantId || !id) {
      throw new BadRequestException({ code: 'CUSTOMER_DATA_SCOPE_INVALID', message: 'workspace scope and buyerId are required' });
    }

    const buyer = await this.prisma.buyer.findFirst({
      where: { id, ...scope },
      select: { id: true, anonymizedAt: true },
    });
    if (!buyer) throw subjectNotFound();
    const anonymizedBuyerReference = opaqueId('buyer', scope, buyer.id);

    // A committed deletion writes one minimal, opaque audit fact. Returning it
    // again makes retries stable after a response/network failure and prevents
    // a second operation from reopening attachment storage or duplicate audit.
    if (buyer.anonymizedAt) {
      const previous = await this.prisma.auditLog.findFirst({
        where: {
          ...scope,
          action: 'CUSTOMER_DATA_DELETED',
          entityType: 'BUYER',
          entityId: anonymizedBuyerReference,
        },
        select: { metadataJson: true, createdAt: true },
      });
      const result = previous ? storedResult(buyer.id, previous.metadataJson, previous.createdAt) : undefined;
      if (result) return result;
    }

    const [conversations, messages, userTurns, replyJobs, incidents, attachmentRows, orders] = await Promise.all([
      this.prisma.conversation.findMany({ where: { ...scope, buyerId: buyer.id }, select: { id: true } }),
      this.prisma.message.findMany({ where: { ...scope, buyerId: buyer.id }, select: { id: true } }),
      this.prisma.userTurn.findMany({
        where: { ...scope, conversation: { buyerId: buyer.id } },
        select: { id: true },
      }),
      this.prisma.replyJob.findMany({
        where: { ...scope, conversation: { buyerId: buyer.id } },
        select: { id: true },
      }),
      this.prisma.replyIncident.findMany({
        where: { ...scope, conversation: { buyerId: buyer.id } },
        select: { id: true, regressionCaseId: true },
      }),
      this.prisma.attachment.findMany({ where: { ...scope, buyerId: buyer.id }, select: { id: true } }),
      this.prisma.order.findMany({ where: { ...scope, buyerId: buyer.id }, select: { id: true } }),
    ]);
    const conversationIds = ids(conversations);
    const messageIds = ids(messages);
    const userTurnIds = ids(userTurns);
    const replyJobIds = ids(replyJobs);
    const attachmentIds = ids(attachmentRows);
    const orderIds = ids(orders);
    const incidentIds = ids(incidents);
    const regressionCaseIds = incidents.flatMap((incident) => incident.regressionCaseId ? [incident.regressionCaseId] : []);

    // Object deletion happens before relational metadata deletion. A failure
    // stops the transaction, leaving remaining data discoverable for a safe,
    // idempotent retry rather than silently orphaning a PII object.
    for (const attachmentId of attachmentIds) {
      const erased = await this.attachments.deleteForCustomerData({ ...scope, buyerId: buyer.id }, attachmentId, now);
      if (!erased) {
        throw new InternalServerErrorException({
          code: 'CUSTOMER_DATA_ATTACHMENT_UNCONFIRMED',
          message: 'could not confirm attachment deletion',
        });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const outboxWhere = lifecycleOutboxWhere(scope, conversationIds, messageIds, userTurnIds, replyJobIds);
      const outboxes = outboxWhere
        ? await tx.processingOutbox.findMany({ where: outboxWhere, select: { eventId: true } })
        : [];
      const eventIds = outboxes.map((outbox) => outbox.eventId);

      // Delete non-FK derivatives before Conversation cascade so generated
      // regression cases, Trace and opaque queues cannot retain a chat link.
      const candidates = await deleteCandidates(tx, scope, conversationIds, replyJobIds);
      await deleteCustomerEvalCases(tx, scope, incidentIds, regressionCaseIds);
      await deleteTraceAndInvocationData(tx, scope, conversationIds, replyJobIds);
      if (eventIds.length) await tx.processingReceipt.deleteMany({ where: { ...scope, eventId: { in: eventIds } } });
      if (outboxWhere) await tx.processingOutbox.deleteMany({ where: outboxWhere });

      // Delete only the objects we personally confirmed above. If an upload
      // raced this request, keep its metadata rather than orphaning an object;
      // the guarded Buyer update below aborts and the next retry discovers it.
      const attachments = attachmentIds.length
        ? await tx.attachment.deleteMany({ where: { ...scope, buyerId: buyer.id, id: { in: attachmentIds } } })
        : { count: 0 };
      const memories = await tx.customerMemory.deleteMany({ where: { ...scope, buyerId: buyer.id } });
      // This cascades Message/MessageVersion/UserTurn/Task/ReplyJob/Draft,
      // Workflow/Quality/Incident state and SendOutbox for the customer.
      const conversationsDeleted = await tx.conversation.deleteMany({ where: { ...scope, buyerId: buyer.id } });

      const orderUpdates = await Promise.all(orders.map((order) => tx.order.updateMany({
        where: { id: order.id, ...scope, buyerId: buyer.id },
        data: {
          externalOrderId: opaqueId('order', scope, order.id),
          seedKey: opaqueId('order', scope, order.id),
          logisticsSnapshotJson: Prisma.DbNull,
        },
      })));
      const ordersAnonymized = orderUpdates.reduce((total, update) => total + update.count, 0);

      const anonymizedAt = buyer.anonymizedAt ?? now;
      const buyerUpdate = await tx.buyer.updateMany({
        // New uploads are rejected once anonymizedAt is set. The relation
        // predicate also catches an attachment inserted while this request
        // was physically deleting prior objects, so metadata is never deleted
        // unless every customer object was confirmed first.
        where: { id: buyer.id, ...scope, anonymizedAt: null, attachments: { none: {} } },
        data: {
          externalBuyerId: anonymizedBuyerReference,
          seedKey: anonymizedBuyerReference,
          displayName: '已匿名化客户',
          avatar: null,
          tagsJson: [],
          anonymizedAt,
        },
      });
      if (buyerUpdate.count !== 1) {
        throw new InternalServerErrorException({
          code: 'CUSTOMER_DATA_ATTACHMENT_UNCONFIRMED',
          message: 'could not confirm all customer attachments were deleted',
        });
      }

      const auditEntityIds = unique([buyer.id, ...conversationIds, ...messageIds, ...userTurnIds, ...replyJobIds, ...attachmentIds, ...orderIds]);
      const scrubbedAuditFacts = auditEntityIds.length
        ? (await tx.auditLog.updateMany({
          where: { ...scope, entityId: { in: auditEntityIds } },
          data: { entityId: 'ANONYMIZED', metadataJson: { subject: 'ANONYMIZED' } },
        })).count
        : 0;
      const deleted = {
        conversations: conversationsDeleted.count,
        messages: messageIds.length,
        attachments: attachments.count,
        customerMemories: memories.count,
        knowledgeCandidates: candidates.count,
      };
      const anonymized = { buyers: buyerUpdate.count, orders: ordersAnonymized };
      // Existing relevant audit rows remain as scrubbed, non-personal facts;
      // the new completion event is one additional minimal audit fact.
      const preserved = { anonymousAggregates: ordersAnonymized, auditFacts: scrubbedAuditFacts + 1 };
      const audit = await tx.auditLog.create({
        data: {
          ...scope,
          action: 'CUSTOMER_DATA_DELETED',
          entityType: 'BUYER',
          entityId: anonymizedBuyerReference,
          metadataJson: {
            deleted,
            anonymized,
            preserved,
          },
        },
      });
      return {
        buyerId: buyer.id,
        status: 'COMPLETED' as const,
        deleted,
        anonymized,
        preserved,
        completedAt: audit.createdAt.toISOString(),
      };
    });

    return result;
  }
}

function deleteCandidates(
  tx: Prisma.TransactionClient,
  scope: WorkspaceScope,
  conversationIds: string[],
  replyJobIds: string[],
) {
  const or = [
    ...(conversationIds.length ? [{ sourceConversationId: { in: conversationIds } }] : []),
    ...(replyJobIds.length ? [{ sourceReplyJobId: { in: replyJobIds } }] : []),
  ];
  return or.length
    ? tx.knowledgeCandidate.deleteMany({ where: { ...scope, OR: or } })
    : Promise.resolve({ count: 0 });
}

function deleteTraceAndInvocationData(
  tx: Prisma.TransactionClient,
  scope: WorkspaceScope,
  conversationIds: string[],
  replyJobIds: string[],
) {
  const traceOr = [
    ...(conversationIds.length ? [{ conversationId: { in: conversationIds } }] : []),
    ...(replyJobIds.length ? [{ replyJobId: { in: replyJobIds } }] : []),
  ];
  const invocations = conversationIds.length
    ? tx.aIInvocation.deleteMany({ where: { ...scope, conversationId: { in: conversationIds } } })
    : Promise.resolve({ count: 0 });
  const usage = conversationIds.length
    ? tx.aIUsage.deleteMany({ where: { ...scope, conversationId: { in: conversationIds } } })
    : Promise.resolve({ count: 0 });
  const traces = traceOr.length
    ? tx.traceEvent.deleteMany({ where: { ...scope, OR: traceOr } })
    : Promise.resolve({ count: 0 });
  return Promise.all([traces, invocations, usage]);
}

function lifecycleOutboxWhere(
  scope: WorkspaceScope,
  conversationIds: string[],
  messageIds: string[],
  userTurnIds: string[],
  replyJobIds: string[],
) {
  const or = [
    ...(conversationIds.length ? [{ aggregateType: 'CONVERSATION', aggregateId: { in: conversationIds } }] : []),
    ...(messageIds.length ? [{ aggregateType: 'MESSAGE', aggregateId: { in: messageIds } }] : []),
    ...(userTurnIds.length ? [{ aggregateType: 'USER_TURN', aggregateId: { in: userTurnIds } }] : []),
    ...(replyJobIds.length ? [{ aggregateType: 'TASK_BUNDLE', aggregateId: { in: replyJobIds } }] : []),
  ];
  return or.length ? { ...scope, OR: or } : undefined;
}

function opaqueId(kind: 'buyer' | 'order', scope: WorkspaceScope, id: string): string {
  const digest = createHash('sha256')
    .update(`${kind}:${scope.workspaceId}:${scope.tenantId}:${id}`)
    .digest('hex')
    .slice(0, 32);
  return `anonymized-${kind}-${digest}`;
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function subjectNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'CUSTOMER_DATA_SUBJECT_NOT_FOUND',
    message: 'Buyer not found in this Workspace',
  });
}

function deleteCustomerEvalCases(
  tx: Prisma.TransactionClient,
  scope: WorkspaceScope,
  incidentIds: string[],
  regressionCaseIds: string[],
) {
  const or = [
    ...(incidentIds.length ? [{ createdFromIncidentId: { in: incidentIds } }] : []),
    ...(regressionCaseIds.length ? [{ id: { in: regressionCaseIds } }] : []),
  ];
  return or.length ? tx.evalCase.deleteMany({ where: { ...scope, OR: or } }) : Promise.resolve({ count: 0 });
}

function storedResult(
  buyerId: string,
  metadata: unknown,
  completedAt: Date,
): CustomerDataDeletionResult | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  const deleted = countMap(record.deleted, ['conversations', 'messages', 'attachments', 'customerMemories', 'knowledgeCandidates'] as const);
  const anonymized = countMap(record.anonymized, ['buyers', 'orders'] as const);
  const preserved = countMap(record.preserved, ['anonymousAggregates', 'auditFacts'] as const);
  if (!deleted || !anonymized || !preserved) return undefined;
  return { buyerId, status: 'COMPLETED', deleted, anonymized, preserved, completedAt: completedAt.toISOString() };
}

function countMap<Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return keys.every((key) => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0)
    ? Object.fromEntries(keys.map((key) => [key, record[key] as number])) as Record<Key, number>
    : undefined;
}
