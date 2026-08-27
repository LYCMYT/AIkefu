import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { WorkspaceRequest } from './workspace-request';

export const CurrentWorkspace = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<WorkspaceRequest>().workspace;
});
