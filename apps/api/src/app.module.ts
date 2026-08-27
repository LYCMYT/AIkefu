import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { WorkspaceAuthGuard } from './auth/workspace-auth.guard';
import { HttpErrorFilter } from './common/http-error.filter';
import { PrismaWorkspaceRepository } from './database/prisma-workspace.repository';
import { PrismaService } from './database/prisma.service';
import { SeedCatalog } from './seed/seed-catalog';
import { ShopsController } from './shops/shops.controller';
import {
  BuyerSimulatorController,
  BuyersController,
  ConversationsController,
  ShopContextController,
} from './messages/message.controllers';
import { MESSAGE_APPLICATION } from './messages/message.application';
import { PrismaMessageApplication } from './messages/prisma-message.application';
import { MockDouyinAdapter } from '@ai-customer-service/mock-douyin';
import { WorkspaceGateway } from './websocket/workspace.gateway';
import { WorkspaceCleanupService } from './workspaces/workspace-cleanup.service';
import { WorkspaceController } from './workspaces/workspace.controller';
import { WORKSPACE_REPOSITORY } from './workspaces/workspace.repository';
import { WorkspaceService } from './workspaces/workspace.service';
import { AttachmentsController } from './attachments/attachments.controller';
import { ATTACHMENT_REPOSITORY, PrismaAttachmentRepository } from './attachments/attachments.repository';
import { AttachmentService } from './attachments/attachments.service';
import { createImageAnalyzer, IMAGE_ANALYZER } from './attachments/image-analysis';
import { MinioObjectStorage, OBJECT_STORAGE } from './attachments/attachments.storage';
import { DataRetentionService } from './lifecycle/data-retention.service';
import { DataRetentionWorker } from './lifecycle/data-retention.worker';
import { CustomerDataDeletionController } from './privacy/customer-data-deletion.controller';
import { CustomerDataDeletionService } from './privacy/customer-data-deletion.service';
import {
  KnowledgeController,
  KnowledgeShopController,
  ProductLearningController,
  ProductLearningJobsController,
} from './knowledge/knowledge.controller';
import { KnowledgeService } from './knowledge/knowledge.service';
import { createKnowledgeEmbeddingProvider, KNOWLEDGE_EMBEDDING_PROVIDER } from './knowledge/knowledge.vector';
import { ConversationMemoryService } from './ai/conversation-memory.service';
import { AI_INVOCATION_REPOSITORY, PrismaAIInvocationRepository } from './ai/ai-invocation.repository';
import { AIInvocationService } from './ai/ai-invocation.service';
import { AI_RUNTIME, AiRuntimeApplicationService } from './ai/ai-runtime-application.service';
import { createServerAiRuntime } from './ai/ai-providers';
import {
  CoalescingConversationMemoryRebuildScheduler,
  CONVERSATION_MEMORY_REBUILD_SCHEDULER,
} from './ai/conversation-memory.scheduler';
import { ConversationMemoryRebuildWorker } from './ai/conversation-memory.worker';
import { UsageController } from './ai/usage.controller';
import { UsageService } from './ai/usage.service';
import { ReplyJobService } from './replies/reply-job.service';
import { ReplyDraftService } from './replies/reply-draft.service';
import { SendOutboxService } from './replies/send-outbox.service';
import { ReplyRecoveryService } from './replies/reply-recovery.service';
import { CustomerMemoryService } from './replies/customer-memory.service';
import { CustomerMemoryController, MemoryMutationController } from './replies/customer-memory.controller';
import { ConversationReplyController } from './replies/conversation-reply.controller';
import { ConversationReplyControlService } from './replies/conversation-reply-control.service';
import { ReplyRuntimeService } from './replies/reply-runtime.service';
import { MockDouyinSendWorker } from './replies/mock-douyin-send.worker';
import { ScheduledConversationMessageService, ScheduledConversationMessageWorker } from './replies/scheduled-conversation-message.service';
import { ContextInvalidationService } from './replies/context-invalidation.service';
import { ContextInvalidationController } from './replies/context-invalidation.controller';
import { ConversationTransportMutex } from './replies/conversation-transport-mutex.service';
import { WorkflowService } from './workflow/workflow.service';
import { WorkflowRuntimeService } from './workflow/workflow-runtime.service';
import { WorkflowRouterService } from './workflow/workflow-router.service';
import { WorkflowProposalService } from './workflow/workflow-proposal.service';
import { WorkflowController } from './workflow/workflow.controller';
import { WorkflowRecoveryWorker } from './workflow/workflow-recovery.worker';
import { QualityReviewService } from './quality/quality-review.service';
import { QualityController } from './quality/quality.controller';
import { TraceService } from './trace/trace.service';
import { TraceController } from './trace/trace.controller';
import { ReplyIncidentService } from './incidents/reply-incident.service';
import { ReplyIncidentController } from './incidents/reply-incident.controller';
import { ScenarioLabService } from './scenarios/scenario-lab.service';
import { ScenarioLabController } from './scenarios/scenario-lab.controller';
import { ReplyIncidentPublisher } from './incidents/reply-incident.publisher';
import { WorkflowRealtimePublisher } from './workflow/workflow-realtime.publisher';

@Module({
  controllers: [
    WorkspaceController,
    ShopsController,
    BuyersController,
    ConversationsController,
    ShopContextController,
    BuyerSimulatorController,
    AttachmentsController,
    CustomerDataDeletionController,
    KnowledgeController,
    KnowledgeShopController,
    ProductLearningController,
    ProductLearningJobsController,
    UsageController,
    CustomerMemoryController,
    MemoryMutationController,
    ConversationReplyController,
    ContextInvalidationController,
    WorkflowController,
    QualityController,
    TraceController,
    ReplyIncidentController,
    ScenarioLabController,
  ],
  providers: [
    PrismaService,
    SeedCatalog,
    WorkspaceService,
    WorkspaceCleanupService,
    AttachmentService,
    DataRetentionService,
    DataRetentionWorker,
    CustomerDataDeletionService,
    KnowledgeService,
    ConversationMemoryService,
    ConversationMemoryRebuildWorker,
    CoalescingConversationMemoryRebuildScheduler,
    AIInvocationService,
    UsageService,
    ReplyJobService,
    ReplyDraftService,
    ConversationTransportMutex,
    SendOutboxService,
    ReplyRecoveryService,
    CustomerMemoryService,
    ConversationReplyControlService,
    ReplyRuntimeService,
    MockDouyinSendWorker,
    ScheduledConversationMessageService,
    ScheduledConversationMessageWorker,
    ContextInvalidationService,
    WorkflowService,
    WorkflowRuntimeService,
    WorkflowRouterService,
    WorkflowProposalService,
    WorkflowRecoveryWorker,
    WorkflowRealtimePublisher,
    QualityReviewService,
    TraceService,
    ReplyIncidentService,
    ScenarioLabService,
    ReplyIncidentPublisher,
    PrismaAIInvocationRepository,
    AiRuntimeApplicationService,
    WorkspaceGateway,
    { provide: AI_RUNTIME, useFactory: () => createServerAiRuntime() },
    { provide: KNOWLEDGE_EMBEDDING_PROVIDER, useFactory: () => createKnowledgeEmbeddingProvider() },
    { provide: AI_INVOCATION_REPOSITORY, useExisting: PrismaAIInvocationRepository },
    {
      provide: CONVERSATION_MEMORY_REBUILD_SCHEDULER,
      useExisting: CoalescingConversationMemoryRebuildScheduler,
    },
    { provide: MockDouyinAdapter, useFactory: () => new MockDouyinAdapter() },
    { provide: MESSAGE_APPLICATION, useClass: PrismaMessageApplication },
    { provide: WORKSPACE_REPOSITORY, useClass: PrismaWorkspaceRepository },
    { provide: ATTACHMENT_REPOSITORY, useClass: PrismaAttachmentRepository },
    {
      provide: IMAGE_ANALYZER,
      useFactory: (runtime: AiRuntimeApplicationService) => createImageAnalyzer(runtime),
      inject: [AiRuntimeApplicationService],
    },
    { provide: OBJECT_STORAGE, useFactory: () => MinioObjectStorage.fromEnv() },
    { provide: APP_GUARD, useClass: WorkspaceAuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
