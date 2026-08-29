import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowSettings } from '@ai-customer-service/contracts';
import type { ShopSettingsInput } from '@ai-customer-service/contracts';
import { isWorkflowGraph } from '@ai-customer-service/contracts';

const ID_MAX = 160;
const TEXT_MAX = 4_000;
const LONG_TEXT_MAX = 32_000;
const JSON_MAX_BYTES = 8_192;

@ValidatorConstraint({ name: 'boundedJson', async: false })
class BoundedJsonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isBoundedJson(value, JSON_MAX_BYTES, 0);
  }

  defaultMessage(): string {
    return 'JSON value exceeds the allowed size or depth';
  }
}

@ValidatorConstraint({ name: 'closingMessages', async: false })
class ClosingMessagesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
      && exactObject(value, Object.keys(value as object))
      && Object.entries(value).length <= 20
      && Object.entries(value).every(([key, entry]) => boundedString(key, 80) && typeof entry === 'string' && entry.length <= TEXT_MAX);
  }
}

@ValidatorConstraint({ name: 'forbiddenTerms', async: false })
class ForbiddenTermsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value)
      && value.length <= 100
      && value.every((entry) => exactObject(entry, ['term', 'replacement'])
        && boundedString(entry.term, 160)
        && typeof entry.replacement === 'string'
        && entry.replacement.length <= 160);
  }
}

@ValidatorConstraint({ name: 'workflowNodes', async: false })
class WorkflowNodesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value)
      && value.length <= 20
      && value.every((node) => exactObject(node, ['id', 'type', 'position', 'config'])
        && typeof node.id === 'string' && node.id.length > 0 && node.id.length <= ID_MAX
        && typeof node.type === 'string'
        && exactObject(node.position, ['x', 'y'])
        && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
        && isBoundedJson(node.config, JSON_MAX_BYTES, 0));
  }
}

@ValidatorConstraint({ name: 'workflowEdges', async: false })
class WorkflowEdgesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value)
      && value.length <= 40
      && value.every((edge) => exactObject(edge, ['id', 'source', 'target', 'condition'])
        && boundedString(edge.id, ID_MAX)
        && boundedString(edge.source, ID_MAX)
        && boundedString(edge.target, ID_MAX)
        && (edge.condition === undefined || boundedString(edge.condition, 64)));
  }
}

@ValidatorConstraint({ name: 'workflowSettings', async: false })
class WorkflowSettingsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return exactObject(value, ['maxSteps', 'timeoutMs'])
      && Number.isSafeInteger(value.maxSteps) && value.maxSteps >= 1 && value.maxSteps <= 20
      && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 1 && value.timeoutMs <= 30_000;
  }
}

@ValidatorConstraint({ name: 'workflowGraph', async: false })
class WorkflowGraphConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, arguments_: ValidationArguments): boolean {
    return isWorkflowGraph(arguments_.object)
      && new WorkflowNodesConstraint().validate((arguments_.object as WorkflowGraph).nodes)
      && new WorkflowEdgesConstraint().validate((arguments_.object as WorkflowGraph).edges);
  }
}

export class ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX)
  shopId!: string;
}

export class DemoWorkspaceProfileDto {
  @IsOptional() @IsIn(['EMPTY', 'SEEDED'])
  profile?: 'EMPTY' | 'SEEDED';
}

export class ShopCreateDto {
  @IsIn(['DOUYIN_DEMO'])
  platform!: 'DOUYIN_DEMO';

  @IsIn(['FASHION_DEMO', 'TECH_DEMO'])
  templateKey!: 'FASHION_DEMO' | 'TECH_DEMO';

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) @Matches(/^[\p{L}\p{N}\s._·-]+$/u)
  name?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) @Matches(/^[A-Za-z0-9_.:-]+$/)
  externalShopId?: string;

  @IsOptional() @IsIn(['AUTO_ALLOWED', 'ASSIST_ONLY', 'MANUAL_ONLY'])
  aiMode?: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
}

export class ShopAiModeDto {
  @IsIn(['AUTO_ALLOWED', 'ASSIST_ONLY', 'MANUAL_ONLY'])
  mode!: 'AUTO_ALLOWED' | 'ASSIST_ONLY' | 'MANUAL_ONLY';
}

export class ShopSettingsDto implements ShopSettingsInput {
  @IsString() @MaxLength(500)
  tone!: string;

  @IsString() @MaxLength(TEXT_MAX)
  logisticsPolicy!: string;

  @IsString() @MaxLength(TEXT_MAX)
  shippingPolicy!: string;

  @IsString() @MaxLength(TEXT_MAX)
  afterSalesPolicy!: string;

  @IsString() @MaxLength(TEXT_MAX)
  welcomeMessage!: string;

  @IsObject() @Validate(ClosingMessagesConstraint)
  closingMessages!: Record<string, string>;

  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(160, { each: true })
  transferKeywords!: string[];

  @IsArray() @ArrayMaxSize(100) @Validate(ForbiddenTermsConstraint)
  forbiddenTerms!: Array<{ term: string; replacement: string }>;
}

export class BuyerMessageDto extends ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX)
  buyerId!: string;

  @IsOptional() @IsString() @MaxLength(ID_MAX)
  conversationId?: string;

  @IsIn(['TEXT', 'IMAGE'])
  kind!: 'TEXT' | 'IMAGE';

  @IsOptional() @IsString() @MaxLength(TEXT_MAX)
  text?: string;

  @IsOptional() @IsString() @MaxLength(ID_MAX)
  attachmentId?: string;

  @IsOptional() @IsISO8601()
  sentAt?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2_147_483_647)
  forcedSequence?: number;

  @IsOptional() @IsString() @MaxLength(255)
  duplicateExternalMessageId?: string;
}

export class BuyerProductCardDto extends ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) buyerId!: string;
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) productId!: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) conversationId?: string;
  @IsOptional() @IsISO8601() sentAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2_147_483_647) forcedSequence?: number;
}

export class BuyerOrderCardDto extends ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) buyerId!: string;
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) orderId!: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) conversationId?: string;
  @IsOptional() @IsISO8601() sentAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2_147_483_647) forcedSequence?: number;
}

export class MessageEditDto {
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX)
  text!: string;
}

export class AttachmentBodyDto extends ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) buyerId!: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) conversationId?: string;
}

export class ConversationModeDto extends ShopScopeDto {
  @IsIn(['AUTO', 'ASSIST', 'MANUAL', 'HOLD'])
  mode!: 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD';
}

export class ConversationMessageDto extends ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX) text!: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) sourceDraftId?: string;
  @IsOptional() @IsIn(['STYLE_EDIT', 'FACTUAL_CORRECTION', 'KNOWLEDGE_ENRICHMENT']) editType?: 'STYLE_EDIT' | 'FACTUAL_CORRECTION' | 'KNOWLEDGE_ENRICHMENT';
}

export class CustomerMemoryDto extends ShopScopeDto {
  @IsIn(['PREFERENCE', 'PRODUCT_PREFERENCE', 'ONGOING_CASE'])
  type!: 'PREFERENCE' | 'PRODUCT_PREFERENCE' | 'ONGOING_CASE';
  @IsString() @IsNotEmpty() @MaxLength(128) key!: string;
  @IsObject() @Validate(BoundedJsonConstraint) value!: Record<string, unknown>;
  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class KnowledgeCreateDto extends ShopScopeDto {
  @IsIn(['STORE', 'PRODUCT']) scope!: 'STORE' | 'PRODUCT';
  @IsOptional() @IsString() @MaxLength(ID_MAX) productId?: string;
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX) question!: string;
  @IsString() @IsNotEmpty() @MaxLength(LONG_TEXT_MAX) answer!: string;
}

export class KnowledgeImportDto extends ShopScopeDto {
  @IsOptional() @IsString() @MaxLength(1_048_576) csv?: string;
  @IsOptional() @IsString() @MaxLength(255) sourceName?: string;
}

export class KnowledgeConflictResolveDto extends ShopScopeDto {
  @IsIn(['KEEP_LEFT', 'KEEP_RIGHT', 'MERGE', 'CUSTOM']) resolution!: 'KEEP_LEFT' | 'KEEP_RIGHT' | 'MERGE' | 'CUSTOM';
  @IsOptional() @IsString() @MaxLength(TEXT_MAX) customQuestion?: string;
  @IsOptional() @IsString() @MaxLength(LONG_TEXT_MAX) customAnswer?: string;
}

export class KnowledgeReviseDto extends ShopScopeDto {
  @IsOptional() @IsString() @MaxLength(TEXT_MAX) question?: string;
  @IsOptional() @IsString() @MaxLength(LONG_TEXT_MAX) answer?: string;
}

export class KnowledgeSearchDto extends ShopScopeDto {
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX) query!: string;
  @IsOptional() @IsIn(['STORE', 'PRODUCT']) scope?: 'STORE' | 'PRODUCT';
  @IsOptional() @IsString() @MaxLength(ID_MAX) productId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3) topK?: number;
}

export class ProductLearningDto {
  @IsOptional() @IsString() @MaxLength(ID_MAX) productId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(ID_MAX, { each: true }) productIds?: string[];
  @IsOptional() @IsBoolean() retryFailed?: boolean;
}

export class InventoryUpdateDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(2_147_483_647) inventory!: number;
}

export class OrderStatusDto {
  @IsIn(['WAITING_SHIPMENT', 'SHIPPED', 'COMPLETED']) status!: string;
}

export class QualityStartDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) conversationId!: string;
}

export class QualityConclusionDto {
  @IsIn(['PASS', 'FAIL', 'NEEDS_HUMAN']) result!: 'PASS' | 'FAIL' | 'NEEDS_HUMAN';
}

export class IncidentCreateDto {
  @IsString() @IsNotEmpty() @MaxLength(128) errorType!: string;
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) severity!: string;
}

export class IncidentRootCauseDto {
  @IsString() @IsNotEmpty() @MaxLength(LONG_TEXT_MAX) rootCause!: string;
}

export class IncidentCorrectionDto {
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX) correctedAnswer!: string;
  @IsBoolean() sendToBuyer!: boolean;
}

export class IncidentRegressionDto {
  @IsOptional() @IsString() @MaxLength(ID_MAX) caseId?: string;
}

export class CreateWorkflowDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) type!: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) shopId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(-10_000) @Max(10_000) priority?: number;
}

export class WorkflowGraphDto implements WorkflowGraph {
  @IsArray() @ArrayMaxSize(20) @Validate(WorkflowNodesConstraint)
  nodes!: WorkflowNode[];
  @IsArray() @ArrayMaxSize(40) @Validate(WorkflowEdgesConstraint)
  edges!: WorkflowEdge[];
  @IsObject() @Validate(WorkflowSettingsConstraint)
  settings!: WorkflowSettings;
  @Validate(WorkflowGraphConstraint)
  private readonly graphIsValid = true;
}

export class WorkflowTestRunDto {
  @IsString() @IsNotEmpty() @MaxLength(ID_MAX) conversationId!: string;
}

export class WorkflowApproveDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) expectedContextVersion?: number;
  @IsOptional() @IsString() @MaxLength(160) approvedBy?: string;
}

export class WorkflowRejectDto {
  @IsOptional() @IsString() @MaxLength(1_000) reason?: string;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function exactObject(value: unknown, allowedKeys: readonly string[]): value is Record<string, any> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every((key) => allowedKeys.includes(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
}

function isBoundedJson(value: unknown, maximumBytes: number, depth: number): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') <= maximumBytes;
  if (Array.isArray(value)) return value.length <= 100 && value.every((entry) => isBoundedJson(entry, maximumBytes, depth + 1));
  if (!exactObject(value, Object.keys(value as object))) return false;
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) return false;
  } catch {
    return false;
  }
  return Object.entries(value).every(([key, entry]) => key.length <= 128 && isBoundedJson(entry, maximumBytes, depth + 1));
}
