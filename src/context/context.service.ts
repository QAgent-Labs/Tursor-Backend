import { Injectable } from '@nestjs/common';

type FileMap = Map<string, boolean>;

@Injectable()
export class ContextService {
  private rootPath = '';
  private files: FileMap = new Map();

  init(rootPath: string) {
    this.rootPath = rootPath;
    this.files.clear();

    console.log('[Context] Initialized with root:', rootPath);
  }

  updateFile(path: string) {
    this.files.set(path, true);

    console.log('[Context] File updated:', path);
  }

  getRootPath() {
    return this.rootPath;
  }

  getAllFiles() {
    return Array.from(this.files.keys());
  }
}
