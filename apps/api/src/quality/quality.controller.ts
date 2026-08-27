import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { QualityReviewService } from './quality-review.service';

@Controller('quality/reviews')
export class QualityController {
  constructor(private readonly quality: QualityReviewService) {}
  @Post() @HttpCode(HttpStatus.ACCEPTED)
  async start(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Body() input: { conversationId: string }) { const review = await this.quality.start(await this.quality.scopeForConversation(scope, input.conversationId), { conversationId: input.conversationId, createdBy: 'demo-operator' }); return { status: 'ACCEPTED' as const, operationId: review.id }; }
  @Get() list(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Query('conversationId') conversationId?: string) { return this.quality.list(scope, conversationId); }
  @Get(':id') get(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('id') id: string) { return this.quality.get(scope, id); }
  @Post(':id/conclusion') @HttpCode(HttpStatus.ACCEPTED)
  async conclude(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('id') id: string, @Body() input: { result: 'PASS'|'FAIL'|'NEEDS_HUMAN' }) { const review = await this.quality.conclude(await this.quality.scopeForReview(scope, id), id, input.result); return { status: 'ACCEPTED' as const, operationId: review.id }; }
}
