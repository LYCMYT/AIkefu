import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { MAX_ATTACHMENT_BYTES, AttachmentService } from './attachments.service';
import type { AttachmentFile } from './attachments.types';

type AttachmentBody = {
  shopId?: string;
  buyerId?: string;
  conversationId?: string;
};

@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  upload(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Body() body: AttachmentBody,
    @UploadedFile() file?: AttachmentFile,
  ) {
    if (!body?.shopId || !body.buyerId) {
      throw inputError('ATTACHMENT_OWNERSHIP_REQUIRED', 'shopId and buyerId are required');
    }
    if (!file) throw inputError('ATTACHMENT_FILE_REQUIRED', 'file is required');
    return this.attachments.upload(scope, {
      shopId: body.shopId,
      buyerId: body.buyerId,
      conversationId: body.conversationId,
      file,
    });
  }

  @Get(':attachmentId/signed-url')
  signedUrl(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('attachmentId') attachmentId: string,
    @Query('shopId') shopId?: string,
  ) {
    if (!attachmentId) throw inputError('ATTACHMENT_ID_REQUIRED', 'attachmentId is required');
    if (!shopId?.trim()) throw inputError('SHOP_ID_REQUIRED', 'shopId is required');
    return this.attachments.createSignedUrl({ ...scope, shopId }, attachmentId);
  }

  @Delete(':attachmentId')
  remove(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('attachmentId') attachmentId: string,
    @Query('shopId') shopId?: string,
  ) {
    if (!attachmentId) throw inputError('ATTACHMENT_ID_REQUIRED', 'attachmentId is required');
    if (!shopId?.trim()) throw inputError('SHOP_ID_REQUIRED', 'shopId is required');
    return this.attachments.delete({ ...scope, shopId }, attachmentId);
  }
}

function inputError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
