import { Controller, Get } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  summary(@CurrentWorkspace() scope: AuthenticatedWorkspace) {
    return this.usage.summary(scope);
  }
}
