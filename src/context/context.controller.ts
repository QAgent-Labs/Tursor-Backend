import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContextService } from './context.service';
import { WorkspaceConfigValidator } from './workspace-config.validator';

@ApiTags('context')
@Controller('context')
export class ContextController {
  constructor(
    private readonly contextService: ContextService,
    private readonly validator: WorkspaceConfigValidator,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Active workspace session state' })
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
      aiConfigured: result.ai !== null,
      generationModel: result.ai?.generationModel ?? null,
    };
  }
}
