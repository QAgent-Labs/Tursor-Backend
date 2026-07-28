import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'node:fs';
import { ScreenshotStorageService } from './screenshot-storage.service';

@Controller('screenshots')
export class ScreenshotController {
  constructor(private readonly storage: ScreenshotStorageService) {}

  @Get(':runId/:filename')
  getScreenshot(
    @Param('runId') runId: string,
    @Param('filename') filename: string,
    @Res() res: Response,
  ): void {
    const filePath = this.storage.resolveFilePathWithIndex(runId, filename);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new NotFoundException('Screenshot not found');
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  }
}
