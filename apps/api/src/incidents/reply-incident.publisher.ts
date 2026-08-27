import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkspaceScope } from '../workspaces/workspace.repository';
import { WorkspaceGateway } from '../websocket/workspace.gateway';
import { toReplyIncidentDto } from './reply-incident.dto';

@Injectable()
export class ReplyIncidentPublisher {
  constructor(@Optional() private readonly gateway?: WorkspaceGateway) {}

  publish(scope: WorkspaceScope & { shopId: string }, incident: object): void {
    try {
      const dto = toReplyIncidentDto(incident);
      this.gateway?.publish({
        eventId: randomUUID(), eventType: 'REPLY_INCIDENT_UPDATED', workspaceId: scope.workspaceId,
        entityType: 'REPLY_INCIDENT', entityId: String(dto.id), entityVersion: 1, occurredAt: new Date().toISOString(),
        payload: { incident: dto },
      });
    } catch { /* durable state is canonical; refresh remains advisory */ }
  }
}
