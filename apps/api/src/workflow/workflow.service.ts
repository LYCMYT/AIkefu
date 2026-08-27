import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { validateWorkflowGraph, type WorkflowDefinition } from '@ai-customer-service/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { randomUUID } from 'node:crypto';
import { normalizeWorkflowGraph } from './workflow-graph';
import { toWorkflowDto, toWorkflowVersionDto } from './workflow.dto';

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: WorkspaceScope) {
    const workflows = await this.prisma.workflow.findMany({ where: scope, orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }], include: { versions: { orderBy: { version: 'desc' } } } });
    return workflows.map(toWorkflowDto);
  }

  async get(scope: WorkspaceScope, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, ...scope }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!workflow) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found in this Workspace' });
    return toWorkflowDto(workflow);
  }

  async create(scope: WorkspaceScope, input: { name: string; type: string; priority?: number; graph?: WorkflowDefinition }) {
    const initial = input.graph ?? { nodes: [], edges: [], settings: { maxSteps: 1, timeoutMs: 1_000 } };
    return this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.create({ data: { ...scope, seedKey: `workflow:${randomUUID()}`, name: input.name, type: input.type, priority: input.priority ?? 0, status: 'DRAFT' } });
      const version = await tx.workflowVersion.create({ data: { ...scope, workflowId: workflow.id, version: 1, graphJson: initial as unknown as Prisma.InputJsonValue } });
      return toWorkflowDto({ ...workflow, versions: [version] });
    });
  }

  async updateDraft(scope: WorkspaceScope, workflowId: string, graph: WorkflowDefinition) {
    // Draft canvas edits are intentionally allowed to be temporarily invalid.
    // Validate/publish are the only gates, so operators can build a graph in
    // several saves without inventing placeholder edges.
    await this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.findFirst({ where: { id: workflowId, ...scope }, select: { id: true, activeVersionId: true } });
      if (!workflow) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found in this Workspace' });
      let draft = await tx.workflowVersion.findFirst({ where: { workflowId, ...scope, immutable: false }, orderBy: { version: 'desc' } });
      if (!draft) {
        const active = workflow.activeVersionId
          ? await tx.workflowVersion.findFirst({ where: { id: workflow.activeVersionId, workflowId, ...scope, immutable: true } })
          : null;
        if (!active) throw new ConflictException({ code: 'WORKFLOW_DRAFT_IMMUTABLE', message: 'No base version is available for a new draft' });
        draft = await tx.workflowVersion.create({ data: { ...scope, workflowId, version: active.version + 1, graphJson: active.graphJson as Prisma.InputJsonValue, immutable: false } });
      }
      const updated = await tx.workflowVersion.updateMany({ where: { id: draft.id, workflowId, immutable: false }, data: { graphJson: graph as unknown as Prisma.InputJsonValue } });
      if (!updated.count) throw new ConflictException({ code: 'WORKFLOW_DRAFT_CONFLICT', message: 'Draft changed during update' });
    });
    return this.get(scope, workflowId);
  }

  async validate(scope: WorkspaceScope, workflowId: string) {
    const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, ...scope }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!workflow) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found in this Workspace' });
    const version = workflow.versions.find((entry) => !entry.immutable);
    if (!version) throw new ConflictException({ code: 'WORKFLOW_DRAFT_IMMUTABLE', message: 'No editable draft exists' });
    const graph = normalizeWorkflowGraph(version.graphJson);
    if (!graph) return { valid: false, errors: [{ code: 'EDGE_INVALID' as const }] };
    return validateWorkflowGraph(graph);
  }

  async publish(scope: WorkspaceScope, workflowId: string) {
    return this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.findFirst({ where: { id: workflowId, ...scope }, select: { id: true, activeVersionId: true, status: true } });
      if (!workflow) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found in this Workspace' });
      const version = await tx.workflowVersion.findFirst({ where: { workflowId, ...scope, immutable: false }, orderBy: { version: 'desc' } });
      if (!version) throw new ConflictException({ code: 'WORKFLOW_DRAFT_IMMUTABLE', message: 'No editable draft exists' });
      const graph = normalizeWorkflowGraph(version.graphJson);
      const validation = graph ? validateWorkflowGraph(graph) : { valid: false, errors: [{ code: 'EDGE_INVALID' as const }] };
      if (!validation.valid) throw new BadRequestException({ code: 'WORKFLOW_GRAPH_INVALID', errors: validation.errors });
      const frozen = await tx.workflowVersion.updateMany({ where: { id: version.id, workflowId, immutable: false }, data: { immutable: true, publishedAt: new Date() } });
      if (!frozen.count) throw new ConflictException({ code: 'WORKFLOW_PUBLISH_CONFLICT', message: 'Draft changed during publish' });
      const active = await tx.workflow.updateMany({ where: { id: workflowId, ...scope, activeVersionId: workflow.activeVersionId }, data: { activeVersionId: version.id, status: 'PUBLISHED' } });
      if (!active.count) throw new ConflictException({ code: 'WORKFLOW_PUBLISH_CONFLICT', message: 'Workflow changed during publish' });
      return toWorkflowVersionDto({ ...version, immutable: true, publishedAt: new Date() });
    });
  }

  async setEnabled(scope: WorkspaceScope, workflowId: string, enabled: boolean) {
    if (enabled) {
      const workflow = await this.prisma.workflow.findFirst({ where: { id: workflowId, ...scope }, select: { activeVersionId: true } });
      if (!workflow) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found in this Workspace' });
      const active = workflow.activeVersionId
        ? await this.prisma.workflowVersion.findFirst({ where: { id: workflow.activeVersionId, workflowId, ...scope, immutable: true }, select: { id: true } })
        : null;
      if (!active) throw new ConflictException({ code: 'WORKFLOW_ACTIVE_VERSION_REQUIRED', message: 'Enable requires an immutable published version' });
    }
    const updated = await this.prisma.workflow.updateMany({ where: { id: workflowId, ...scope }, data: { status: enabled ? 'PUBLISHED' : 'DISABLED' } });
    if (!updated.count) throw new NotFoundException({ code: 'WORKFLOW_NOT_FOUND', message: 'Workflow not found in this Workspace' });
  }
}
