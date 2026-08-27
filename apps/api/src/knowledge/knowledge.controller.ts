import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import {
  KnowledgeConflictResolveDto,
  KnowledgeCreateDto,
  KnowledgeImportDto,
  KnowledgeReviseDto,
  KnowledgeSearchDto,
  ProductLearningDto,
  ShopScopeDto,
} from '../common/request-dtos';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { KnowledgeService } from './knowledge.service';

type CsvUpload = { buffer?: Buffer; originalname?: string; mimetype?: string };
const MAX_IMPORT_BYTES = 1024 * 1024;

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Query('shopId') shopId?: string,
    @Query('scope') knowledgeScope?: string,
    @Query('productId') productId?: string,
  ) {
    return this.knowledge.list(scope, { shopId: shopId ?? '', scope: knowledgeScope as 'STORE' | 'PRODUCT' | undefined, productId });
  }

  @Post()
  create(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Body() body: KnowledgeCreateDto,
  ) {
    return this.knowledge.create(scope, {
      shopId: body?.shopId ?? '',
      scope: body?.scope as 'STORE' | 'PRODUCT',
      productId: body?.productId,
      question: body?.question ?? '',
      answer: body?.answer ?? '',
    });
  }

  /** OpenAPI primary path. `file` is multipart CSV; JSON csv remains useful for demos/tests. */
  @Post('imports')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_BYTES },
      fileFilter: (_request, file, callback) => {
        if (!isAllowedImportFile(file.originalname, file.mimetype)) {
          callback(inputError('KNOWLEDGE_IMPORT_TYPE_INVALID', 'Only CSV and non-macro XLSX uploads are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  async upload(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Body() body: KnowledgeImportDto,
    @UploadedFile() file?: CsvUpload,
  ) {
    const upload = importSource(file, body?.csv);
    const preview = await this.knowledge.previewImport(scope, {
      shopId: body?.shopId ?? '',
      ...upload,
      sourceName: file?.originalname ?? body?.sourceName,
    });
    return { status: 'ACCEPTED' as const, operationId: preview.id, importId: preview.id };
  }

  /** Compatibility preview path retained for clients that render a row-by-row review. */
  @Post('imports/preview')
  async preview(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Body() body: KnowledgeImportDto,
  ) {
    return this.knowledge.previewImport(scope, { shopId: body?.shopId ?? '', csv: body?.csv ?? '', sourceName: body?.sourceName });
  }

  @Get('imports/:jobId')
  getImport(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('jobId') jobId: string,
    @Query('shopId') shopId?: string,
  ) {
    return this.knowledge.getImport(scope, jobId, shopId);
  }

  @Post('imports/:id/commit')
  commit(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('id') id: string,
    @Body() body: ShopScopeDto,
  ) {
    return this.knowledge.commitImport(scope, id, body?.shopId);
  }

  @Get('candidates')
  listCandidates(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Query('shopId') shopId?: string,
    @Query('status') status?: string,
  ) {
    return this.knowledge.listCandidates(scope, shopId ?? '', status);
  }

  @Post('candidates/:candidateId/approve')
  @HttpCode(HttpStatus.ACCEPTED)
  approveCandidate(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('candidateId') candidateId: string,
    @Query('shopId') shopId?: string,
  ) {
    return this.knowledge.approveCandidate(scope, candidateId, shopId);
  }

  @Post('candidates/:candidateId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async rejectCandidate(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('candidateId') candidateId: string,
    @Query('shopId') shopId?: string,
  ) {
    await this.knowledge.rejectCandidate(scope, candidateId, shopId);
  }

  @Get('conflicts')
  listConflicts(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Query('shopId') shopId?: string,
    @Query('status') status?: string,
  ) {
    return this.knowledge.listConflicts(scope, shopId ?? '', status);
  }

  @Get('conflicts/:conflictId')
  getConflict(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('conflictId') conflictId: string,
    @Query('shopId') shopId?: string,
  ) {
    return this.knowledge.getConflict(scope, conflictId, shopId);
  }

  @Post('conflicts/:conflictId/resolve')
  @HttpCode(HttpStatus.ACCEPTED)
  resolveConflict(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('conflictId') conflictId: string,
    @Body()
    body: KnowledgeConflictResolveDto,
  ) {
    if (!isConflictResolution(body?.resolution)) {
      throw inputError('KNOWLEDGE_CONFLICT_RESOLUTION_REQUIRED', 'resolution must be KEEP_LEFT, KEEP_RIGHT, MERGE, or CUSTOM');
    }
    return this.knowledge.resolveConflict(scope, conflictId, {
      shopId: body?.shopId,
      resolution: body.resolution,
      customQuestion: body?.customQuestion,
      customAnswer: body?.customAnswer,
    });
  }

  @Post(':id/reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  reindex(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('id') id: string,
    @Query('shopId') shopId?: string,
  ) {
    return this.knowledge.reindex(scope, id, shopId);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  revise(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('id') id: string,
    @Body() body: KnowledgeReviseDto,
  ) {
    return this.knowledge.revise(scope, id, {
      shopId: body?.shopId,
      question: body?.question,
      answer: body?.answer,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('id') id: string,
    @Query('shopId') shopId?: string,
  ) {
    await this.knowledge.delete(scope, id, shopId);
  }

  @Post('search')
  search(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Body() body: KnowledgeSearchDto,
  ) {
    return this.knowledge.search(scope, {
      shopId: body?.shopId ?? '',
      query: body?.query ?? '',
      scope: body?.scope as 'STORE' | 'PRODUCT' | undefined,
      productId: body?.productId,
      topK: body?.topK,
    });
  }
}

@Controller('shops/:shopId')
export class KnowledgeShopController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post('products/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  syncProducts(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('shopId') shopId: string) {
    return this.knowledge.syncProducts(scope, shopId);
  }

  @Post('product-learning-jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  startLearning(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('shopId') shopId: string,
    @Body() body: ProductLearningDto,
  ) {
    const productIds = body?.productIds ?? (body?.productId ? [body.productId] : undefined);
    return this.knowledge.startProductLearning(scope, shopId, productIds, Boolean(body?.retryFailed));
  }

  @Get('product-learning-jobs')
  listLearningJobs(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('shopId') shopId: string) {
    return this.knowledge.listProductLearningJobs(scope, shopId);
  }
}

@Controller('products')
export class ProductLearningController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post(':productId/learn')
  @HttpCode(HttpStatus.ACCEPTED)
  learn(
    @CurrentWorkspace() scope: AuthenticatedWorkspace,
    @Param('productId') productId: string,
    @Query('shopId') shopId?: string,
  ) {
    return this.knowledge.startProductLearningForProduct(scope, productId, shopId);
  }
}

/** Legacy/fallback list route retained for callers that do not nest under shop. */
@Controller('product-learning-jobs')
export class ProductLearningJobsController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Query('shopId') shopId?: string) {
    return this.knowledge.listProductLearningJobs(scope, shopId ?? '');
  }
}

function inputError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

function importSource(file?: CsvUpload, csv?: string): { csv?: string; xlsx?: Buffer } {
  if (!file?.buffer) {
    if (!csv) throw inputError('IMPORT_SOURCE_REQUIRED', 'CSV file, XLSX file, or csv body is required');
    return { csv };
  }
  if (!isAllowedImportFile(file.originalname, file.mimetype)) {
    throw inputError('KNOWLEDGE_IMPORT_TYPE_INVALID', 'Only CSV and non-macro XLSX uploads are allowed');
  }
  const name = file.originalname?.toLowerCase() ?? '';
  if (name.endsWith('.xlsx')) return { xlsx: file.buffer };
  if (name.endsWith('.xls') || name.endsWith('.xlsm')) {
    throw inputError('XLSX_REQUIRED', 'Only non-macro .xlsx uploads are supported');
  }
  return { csv: file.buffer.toString('utf8') };
}

function isAllowedImportFile(name?: string, mimeType?: string): boolean {
  const lowerName = name?.toLowerCase() ?? '';
  const lowerMime = mimeType?.toLowerCase() ?? '';
  const isCsv = lowerName.endsWith('.csv') && ['text/csv', 'application/csv', 'text/plain'].includes(lowerMime);
  const isXlsx =
    lowerName.endsWith('.xlsx') &&
    lowerMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return isCsv || isXlsx;
}

function isConflictResolution(value: unknown): value is 'KEEP_LEFT' | 'KEEP_RIGHT' | 'MERGE' | 'CUSTOM' {
  return value === 'KEEP_LEFT' || value === 'KEEP_RIGHT' || value === 'MERGE' || value === 'CUSTOM';
}
