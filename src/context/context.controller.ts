import { Body, Controller, Post } from '@nestjs/common';
import { ContextService } from './context.service';

@Controller('context')
export class ContextController {
  constructor(private readonly contextService: ContextService) {}

  @Post('init')
  init(@Body() body: { rootPath: string }) {
    this.contextService.init(body.rootPath);

    return {
      status: 'ok',
    };
  }

  @Post('update')
  update(@Body() body: { path: string }) {
    this.contextService.updateFile(body.path);

    return {
      status: 'received',
    };
  }
}
