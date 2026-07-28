import { Module } from '@nestjs/common';
import { CdpRunnerService } from './cdp-runner.service';
import { ScreenshotController } from './screenshot.controller';
import { ScreenshotStorageService } from './screenshot-storage.service';

import { SupabaseScreenshotService } from './supabase-screenshot.service';

@Module({
  controllers: [ScreenshotController],
  providers: [
    CdpRunnerService,
    ScreenshotStorageService,
    SupabaseScreenshotService,
  ],
  exports: [
    CdpRunnerService,
    ScreenshotStorageService,
    SupabaseScreenshotService,
  ],
})
export class CdpModule {}
