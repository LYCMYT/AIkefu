import type { IsoDateTime } from './workspace';

export const ACTION_PROPOSAL_TYPES = [
  'MARK_READ',
  'CREATE_INTERNAL_TASK',
  'TRANSFER_HUMAN',
  'ADD_ORDER_REMARK',
  'PROPOSE_COMPENSATION',
  'REFUND',
  'EXCHANGE',
] as const;
export type ActionProposalType = typeof ACTION_PROPOSAL_TYPES[number];

export const ACTION_RISK_LEVELS = ['READ', 'LOW_WRITE', 'MEDIUM_WRITE', 'HIGH_RISK'] as const;
export type ActionRiskLevel = typeof ACTION_RISK_LEVELS[number];

export const ACTION_PROPOSAL_STATUSES = [
  'PROPOSED',
  'POLICY_CHECKED',
  'WAITING_APPROVAL',
  'APPROVED',
  'REVALIDATING',
  'EXECUTING',
  'SUCCEEDED',
  'REJECTED',
  'STALE',
  'FAILED',
  'UNCERTAIN',
  'CANCELLED',
] as const;
export type ActionProposalStatus = typeof ACTION_PROPOSAL_STATUSES[number];

export interface ActionProposal {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  shopId: string;
  conversationId: string;
  workflowRunId?: string | null;
  type: ActionProposalType;
  riskLevel: ActionRiskLevel;
  targetEntityType: string;
  targetEntityId: string;
  payload?: Record<string, unknown>;
  evidenceIds?: string[];
  contextVersion: number;
  status: ActionProposalStatus;
  approvedBy?: string | null;
  approvedAt?: IsoDateTime | null;
  receipt?: Record<string, unknown> | null;
  createdAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
}

export interface ApproveActionProposalInput {
  expectedContextVersion?: number;
  idempotencyKey?: string;
}

export interface RejectActionProposalInput {
  reason?: string;
}

export const INCIDENT_STATUSES = [
  'OPEN',
  'CORRECTION_DRAFTED',
  'CORRECTED',
  'ROOT_CAUSE_FIXED',
  'REGRESSION_ADDED',
  'RESOLVED',
] as const;
export type IncidentStatus = typeof INCIDENT_STATUSES[number];
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type IncidentSeverity = typeof INCIDENT_SEVERITIES[number];

export interface ReplyIncident {
  id: string;
  workspaceId?: string;
  tenantId?: string;
  conversationId?: string;
  replyId: string;
  replyJobId?: string;
  errorType: string;
  severity: IncidentSeverity;
  sourceType?: string | null;
  originalAnswer: string;
  correctedAnswer?: string | null;
  rootCause?: string | null;
  status: IncidentStatus;
  regressionCaseId?: string | null;
  createdAt?: IsoDateTime;
  resolvedAt?: IsoDateTime | null;
}

export interface CreateReplyIncidentInput {
  errorType: string;
  severity: IncidentSeverity;
  notes?: string;
}

export interface CorrectionInput {
  correctedAnswer: string;
  sendToBuyer?: boolean;
}

export interface RootCauseInput {
  rootCause: string;
}

export function isActionProposal(value: unknown): value is ActionProposal {
  if (!plainObject(value)
    || typeof value.id !== 'string'
    || typeof value.shopId !== 'string'
    || typeof value.conversationId !== 'string'
    || !isMember(value.type, ACTION_PROPOSAL_TYPES)
    || !isMember(value.riskLevel, ACTION_RISK_LEVELS)
    || typeof value.targetEntityType !== 'string'
    || typeof value.targetEntityId !== 'string'
    || !Number.isSafeInteger(value.contextVersion)
    || value.contextVersion < 0
    || !isMember(value.status, ACTION_PROPOSAL_STATUSES)) return false;
  if (value.payload !== undefined && !plainObject(value.payload)) return false;
  if (value.evidenceIds !== undefined && (!Array.isArray(value.evidenceIds) || !value.evidenceIds.every((item) => typeof item === 'string'))) return false;
  return true;
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function plainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
