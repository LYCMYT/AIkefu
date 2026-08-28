import { BadRequestException, Body, Controller, Delete, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import { ConversationMessageDto, ConversationModeDto, ShopScopeDto } from '../common/request-dtos';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { ConversationReplyControlService } from './conversation-reply-control.service';

@Controller('conversations')
export class ConversationReplyController {
  constructor(private readonly controls: ConversationReplyControlService) {}

  @Post(':conversationId/mode')
  @HttpCode(HttpStatus.ACCEPTED)
  async setMode(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('conversationId') conversationId: string,
    @Body() input: ConversationModeDto,
  ) {
    const result = await this.controls.setMode(scoped(scope, input?.shopId), conversationId, requiredMode(input?.mode));
    return {
      id: result.id, overrideMode: result.overrideMode, effectiveMode: result.effectiveMode,
      shopAiMode: result.shopAiMode, humanActive: result.humanActive,
    };
  }

  @Post(':conversationId/takeover')
  @HttpCode(HttpStatus.ACCEPTED)
  async takeover(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('conversationId') conversationId: string, @Body() input: ShopScopeDto) {
    return this.controls.takeover(scoped(scope, input?.shopId), conversationId);
  }

  @Post(':conversationId/resume-ai')
  @HttpCode(HttpStatus.ACCEPTED)
  async resumeAi(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('conversationId') conversationId: string, @Body() input: ShopScopeDto) {
    const result = await this.controls.resumeAi(scoped(scope, input?.shopId), conversationId);
    return { id: result.id, overrideMode: result.overrideMode, humanActive: result.humanActive, resumed: result.resumed };
  }

  @Post(':conversationId/reply/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  async regenerate(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('conversationId') conversationId: string, @Body() input: ShopScopeDto) {
    const job = await this.controls.regenerate(scoped(scope, input?.shopId), conversationId);
    return accepted(job.id);
  }

  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  async humanMessage(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('conversationId') conversationId: string,
    @Body() input: ConversationMessageDto,
  ) {
    if (!input?.text?.trim()) throw inputError('HUMAN_MESSAGE_REQUIRED', 'text is required');
    if (input.editType && !['STYLE_EDIT', 'FACTUAL_CORRECTION', 'KNOWLEDGE_ENRICHMENT'].includes(input.editType)) {
      throw inputError('REPLY_DRAFT_EDIT_TYPE_INVALID', 'editType is invalid');
    }
    const result = await this.controls.saveHumanFinal(scoped(scope, input.shopId), conversationId, {
      text: input.text, sourceDraftId: input.sourceDraftId, editType: input.editType,
    });
    return { status: 'ACCEPTED' as const, sendOutboxId: result.sendOutboxId, ...(result.candidateId ? { candidateId: result.candidateId } : {}) };
  }


  @Delete(':conversationId/messages/:messageId')
  async deleteOutgoingMessage(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() input: ShopScopeDto,
  ) {
    return this.controls.deleteOutgoingMessage(scoped(scope, input?.shopId), conversationId, messageId);
  }
}

function accepted(operationId: string) {
  return { status: 'ACCEPTED' as const, operationId };
}

function scoped(scope: AuthenticatedWorkspace, shopId?: string) {
  if (!shopId?.trim()) throw inputError('SHOP_ID_REQUIRED', 'shopId is required');
  return { workspaceId: scope.workspaceId, tenantId: scope.tenantId, shopId: shopId.trim() };
}

function requiredMode(value: unknown): 'AUTO' | 'ASSIST' | 'MANUAL' | 'HOLD' {
  if (value === 'AUTO' || value === 'ASSIST' || value === 'MANUAL' || value === 'HOLD') return value;
  throw inputError('CONVERSATION_MODE_INVALID', 'mode must be AUTO, ASSIST, MANUAL, or HOLD');
}

function inputError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
