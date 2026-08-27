import type { Request } from 'express';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';

export type WorkspaceRequest = Request & {
  workspace: AuthenticatedWorkspace;
};
