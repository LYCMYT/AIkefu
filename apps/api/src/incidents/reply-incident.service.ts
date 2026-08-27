import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '@ai-customer-service/contracts';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { SendOutboxService } from '../replies/send-outbox.service';
import { TraceService } from '../trace/trace.service';
import { ReplyIncidentPublisher } from './reply-incident.publisher';
import { toReplyIncidentDto } from './reply-incident.dto';

type Scope = WorkspaceScope & { shopId: string };
type IncidentListFilter = { conversationId?: string; status?: string; severity?: string };
@Injectable()
export class ReplyIncidentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sends: SendOutboxService,
    @Optional() private readonly publisher?: ReplyIncidentPublisher,
    @Optional() private readonly traces?: TraceService,
  ) {}
  async create(scope: Scope, input: { conversationId: string; replyMessageId: string; errorType: string; severity: string }) {
    const severity = incidentSeverity(input.severity);
    if (!severity) throw new BadRequestException({ code: 'INCIDENT_SEVERITY_INVALID', message: 'severity is required' });
    const message = await this.prisma.message.findFirst({ where: { id: input.replyMessageId, ...scope, conversationId: input.conversationId, role: { in: ['ASSISTANT', 'HUMAN'] } }, select: { id: true, contentJson: true } });
    if (!message) throw new NotFoundException({ code: 'REPLY_MESSAGE_NOT_FOUND', message: 'Projected reply not found in this Shop' });
    const incident = await this.prisma.replyIncident.create({ data: { ...scope, conversationId: input.conversationId, replyMessageId: message.id, errorType: input.errorType, severity, originalAnswerSnapshot: text(message.contentJson) } });
    this.publish(scope, incident);
    return toReplyIncidentDto(incident);
  }
  async rootCause(scope: Scope, id: string, rootCause: string) {
    const changed = await this.prisma.replyIncident.updateMany({ where: { id, ...scope, status: 'CORRECTED' }, data: { rootCause: rootCause.slice(0, 1000), status: 'ROOT_CAUSE_FIXED' } });
    if (!changed.count) throw new ConflictException({ code: 'REPLY_INCIDENT_STATE_INVALID', message: 'Root cause requires a receipt-confirmed correction' });
    const incident = await this.prisma.replyIncident.findFirstOrThrow({ where: { id, ...scope } }); this.publish(scope, incident); return toReplyIncidentDto(incident);
  }
  async regression(scope: Scope, id: string, input: { caseId?: string } = {}) {
    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.replyIncident.findFirst({ where: { id, ...scope } });
      if (!incident) throw new NotFoundException({ code: 'REPLY_INCIDENT_NOT_FOUND', message: 'Incident not found in this Shop' });
      if (incident.status === 'REGRESSION_ADDED' && incident.regressionCaseId) return { incident, evalCaseId: incident.regressionCaseId };
      if (incident.status !== 'ROOT_CAUSE_FIXED') throw new ConflictException({ code: 'REPLY_INCIDENT_STATE_INVALID', message: 'Regression requires a fixed root cause' });
      const key = `incident:${incident.id}`;
      const evalCase = input.caseId
        ? await tx.evalCase.findFirst({ where: { id: input.caseId, ...scope, status: 'ACTIVE' } })
        : await tx.evalCase.upsert({ where: { workspaceId_tenantId_key: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, key } }, create: { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: scope.shopId, key, source: 'REGRESSION', inputJson: { replyMessageId: incident.replyMessageId }, expectedJson: { correctedAnswer: incident.correctedAnswer ?? null }, assertionsJson: { noKnownFailure: true }, createdFromIncidentId: incident.id }, update: { expectedJson: { correctedAnswer: incident.correctedAnswer ?? null }, assertionsJson: { noKnownFailure: true } } });
      if (!evalCase) throw new NotFoundException({ code: 'EVAL_CASE_NOT_FOUND', message: 'Active EvalCase not found in this Shop' });
      const updated = await tx.replyIncident.update({ where: { id: incident.id }, data: { regressionCaseId: evalCase.id, status: 'REGRESSION_ADDED' } });
      return { incident: updated, evalCaseId: evalCase.id };
    });
    this.publish(scope, result.incident);
    return { incident: toReplyIncidentDto(result.incident), evalCaseId: result.evalCaseId };
  }
  async resolve(scope: Scope, id: string) {
    const changed = await this.prisma.replyIncident.updateMany({ where: { id, ...scope, status: 'REGRESSION_ADDED' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
    if (!changed.count) throw new ConflictException({ code: 'REPLY_INCIDENT_STATE_INVALID', message: 'Resolve requires a durable regression case' });
    const incident = await this.prisma.replyIncident.findFirstOrThrow({ where: { id, ...scope } }); this.publish(scope, incident); return toReplyIncidentDto(incident);
  }

  async correction(scope: Scope, id: string, input: { correctedAnswer: string; sendToBuyer: boolean }) {
    const answer = input.correctedAnswer.trim();
    if (!answer) throw new ConflictException({ code: 'CORRECTION_REQUIRED', message: 'Correction text is required' });
    const result = await this.prisma.$transaction(async (tx) => {
      const incident = await tx.replyIncident.findFirst({ where: { id, ...scope } });
      if (!incident) throw new NotFoundException({ code: 'REPLY_INCIDENT_NOT_FOUND', message: 'Incident not found in this Shop' });
      if (incident.correctionSendOutboxId) {
        if ((incident.correctedAnswer ?? '').trim() !== answer) {
          throw new ConflictException({
            code: 'CORRECTION_SEND_IMMUTABLE',
            message: 'A queued correction cannot be replaced with different text',
          });
        }
        return { incidentId: incident.id, sendOutboxId: incident.correctionSendOutboxId, status: 'ACCEPTED' as const };
      }
      const conversation = await tx.conversation.findFirst({ where: { id: incident.conversationId, ...scope }, select: { id: true, lastCommittedSequence: true, contextVersion: true } });
      if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Shop' });
      const lastMessage = await tx.message.findFirst({ where: { ...scope, conversationId: conversation.id, status: { not: 'RECALLED' } }, orderBy: [{ sequence: 'desc' }, { createdAt: 'desc' }], select: { id: true } });
      const outbox = input.sendToBuyer
        ? await this.sends.enqueueInTransaction(tx, scope, {
            conversationId: conversation.id,
            idempotencyKey: `incident-correction:${incident.id}`,
            text: answer,
            senderRole: 'HUMAN',
            expectedLastMessageId: lastMessage?.id,
            expectedSequence: conversation.lastCommittedSequence,
            expectedContextVersion: conversation.contextVersion,
          })
        : undefined;
      const changed = await tx.replyIncident.updateMany({
        where: { id: incident.id, ...scope, status: { in: ['OPEN', 'CORRECTION_DRAFTED'] } },
        data: { correctedAnswer: answer, status: 'CORRECTION_DRAFTED', ...(outbox ? { correctionSendOutboxId: outbox.id } : {}) },
      });
      if (!changed.count) throw new ConflictException({ code: 'REPLY_INCIDENT_STATE_INVALID', message: 'Incident is no longer editable' });
      return { incidentId: incident.id, sendOutboxId: outbox?.id, status: 'ACCEPTED' as const };
    });
    const incident = await this.prisma.replyIncident.findFirst({ where: { id, ...scope } });
    if (incident) this.publish(scope, incident);
    return result;
  }

  async contextForReply(scope: WorkspaceScope, replyMessageId: string): Promise<Scope & { conversationId: string }> {
    const reply = await this.prisma.message.findFirst({
      where: { id: replyMessageId, ...scope, role: { in: ['ASSISTANT', 'HUMAN'] } },
      select: { shopId: true, conversationId: true },
    });
    if (!reply) throw new NotFoundException({ code: 'REPLY_MESSAGE_NOT_FOUND', message: 'Projected reply not found in this Workspace' });
    return { ...scope, shopId: reply.shopId, conversationId: reply.conversationId };
  }

  async scopeForConversation(scope: WorkspaceScope, conversationId: string): Promise<Scope> {
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, ...scope }, select: { shopId: true } });
    if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found in this Workspace' });
    return { ...scope, shopId: conversation.shopId };
  }

  async scopeForIncident(scope: WorkspaceScope, id: string): Promise<Scope> {
    const incident = await this.prisma.replyIncident.findFirst({ where: { id, ...scope }, select: { shopId: true } });
    if (!incident) throw new NotFoundException({ code: 'REPLY_INCIDENT_NOT_FOUND', message: 'Incident not found in this Workspace' });
    return { ...scope, shopId: incident.shopId };
  }

  async list(scope: WorkspaceScope, filter: IncidentListFilter = {}) {
    const status = incidentStatus(filter.status);
    const severity = incidentSeverity(filter.severity);
    const incidents = await this.prisma.replyIncident.findMany({ where: { ...scope, ...(filter.conversationId ? { conversationId: filter.conversationId } : {}), ...(status ? { status } : {}), ...(severity ? { severity } : {}) }, orderBy: { createdAt: 'desc' } });
    return incidents.map(toReplyIncidentDto);
  }

  private publish(scope: Scope, incident: object): void {
    try {
      this.publisher?.publish(scope, incident);
      const incidentValue = incident as { id?: string; conversationId?: string; status?: string };
      if (incidentValue.id && incidentValue.conversationId) void this.traces?.record({ ...scope, conversationId: incidentValue.conversationId }, `incident:${incidentValue.id}`, 'REPLY_INCIDENT_UPDATED', { status: incidentValue.status ?? 'OPEN' });
    } catch { /* durable record is still canonical */ }
  }
}
function text(value: unknown): string { if (typeof value === 'string') return value; if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).text === 'string') return (value as Record<string, unknown>).text as string; return ''; }

function incidentStatus(value: string | undefined): (typeof INCIDENT_STATUSES)[number] | undefined {
  if (value === undefined) return undefined;
  if (!INCIDENT_STATUSES.includes(value as (typeof INCIDENT_STATUSES)[number])) {
    throw new BadRequestException({ code: 'INCIDENT_STATUS_INVALID', message: 'status must be one of the documented incident statuses' });
  }
  return value as (typeof INCIDENT_STATUSES)[number];
}

function incidentSeverity(value: string | undefined): (typeof INCIDENT_SEVERITIES)[number] | undefined {
  if (value === undefined) return undefined;
  if (!INCIDENT_SEVERITIES.includes(value as (typeof INCIDENT_SEVERITIES)[number])) {
    throw new BadRequestException({ code: 'INCIDENT_SEVERITY_INVALID', message: 'severity must be one of the documented incident severities' });
  }
  return value as (typeof INCIDENT_SEVERITIES)[number];
}

export { toReplyIncidentDto } from './reply-incident.dto';
