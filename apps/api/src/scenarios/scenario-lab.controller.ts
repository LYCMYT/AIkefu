import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentWorkspace } from '../auth/current-workspace.decorator';
import type { AuthenticatedWorkspace } from '../workspaces/workspace.repository';
import { ScenarioLabService } from './scenario-lab.service';

/** REST boundary for the fixed, synthetic Scenario Lab. */
@Controller('scenarios')
export class ScenarioLabController {
  constructor(private readonly scenarios: ScenarioLabService) {}

  @Get()
  list(@CurrentWorkspace() scope: AuthenticatedWorkspace) {
    return this.scenarios.list(scope);
  }

  @Post(':scenarioKey/run')
  @HttpCode(HttpStatus.ACCEPTED)
  run(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('scenarioKey') scenarioKey: string) {
    return this.scenarios.run(scope, scenarioKey);
  }

  @Post(':scenarioKey/reset')
  @HttpCode(HttpStatus.ACCEPTED)
  reset(@CurrentWorkspace() scope: AuthenticatedWorkspace, @Param('scenarioKey') scenarioKey: string) {
    return this.scenarios.reset(scope, scenarioKey);
  }
}
