import { Controller, Get } from '@nestjs/common';
import { ContextService } from './context.service';
import { WorkspaceConfigValidator } from './workspace-config.validator';

@Controller('context')
export class ContextController {
  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
  ) {}

  @Get('current')
  getCurrentContext() {
    return this.contextService.getWorkspaceContext();
  }

  @Get('validate')
  validateWorkspaceConfig() {
    const path = this.contextService.getWorkspacePath();
    if (!path) {
      return { ok: false, error: 'No workspace path set.' };
    }
    const result = this.validator.validate(path);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      configPath: result.configPath,
      excluded: result.excluded,
    };
  }
}
