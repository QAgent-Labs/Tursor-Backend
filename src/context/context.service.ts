
export interface WorkspaceContext {
  workspacePath: string;
  frontendPort: number | null;
  connected: boolean;
  lastUpdated: Date;
  contextReady: boolean;
  embeddingsDir: string | null;
}

export interface WorkspaceContextResponse {
  workspacePath: string | null;
  frontendPort: number | null;
  connected: boolean;
  contextReady: boolean;
}

export class ContextService {
  private context: WorkspaceContext | null = null;

  setWorkspaceContext(
    workspacePath: string,
    frontendPort?: number | null,
  ): void {
    this.context = {
      workspacePath,
      frontendPort:
        typeof frontendPort === 'number' && frontendPort > 0
          ? frontendPort
          : (this.context?.frontendPort ?? null),
      connected: true,
      lastUpdated: new Date(),
      contextReady: this.context?.contextReady ?? false,
      embeddingsDir: this.context?.embeddingsDir ?? null,
    };
  }

  setFrontendPort(port: number | null): void {
    if (!this.context) {
      return;
    }
    this.context = {
      ...this.context,
      frontendPort: port,
      lastUpdated: new Date(),
    };
  }

  getWorkspacePath(): string | null {
    return this.context?.workspacePath ?? null;
  }

  getFrontendPort(): number | null {
    return this.context?.frontendPort ?? null;
  }

  isContextReady(): boolean {
    return this.context?.contextReady ?? false;
  }

  markContextReady(meta: {
    embeddingsDir: string;
    filesIndexed: number;
    chunksIndexed: number;
    model: string;
  }): void {
    if (!this.context) {
      return;
    }
    this.context = {
      ...this.context,
      contextReady: true,
      embeddingsDir: meta.embeddingsDir,
      lastUpdated: new Date(),
    };
  }

  resetContextReady(): void {
    if (!this.context) {
      return;
    }
    this.context = {
      ...this.context,
      contextReady: false,
      embeddingsDir: null,
      lastUpdated: new Date(),
    };
  }

  getWorkspaceContext(): WorkspaceContextResponse {
    if (!this.context) {
      return {
        workspacePath: null,
        frontendPort: null,
        connected: false,
        contextReady: false,
      };
    }

    return {
      workspacePath: this.context.workspacePath,
      frontendPort: this.context.frontendPort,
      connected: this.context.connected,
      contextReady: this.context.contextReady,
    };
  }

  clearWorkspaceContext(): void {
    this.context = null;
  }
}
