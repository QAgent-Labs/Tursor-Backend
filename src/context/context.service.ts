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
  private building = false;
  private waiters: Array<(ready: boolean) => void> = [];

  setWorkspaceContext(
    workspacePath: string,
    frontendPort?: number | null,
  ): void {
    // The index belongs to one workspace; a different one starts over.
    const sameWorkspace = this.context?.workspacePath === workspacePath;
    this.context = {
      workspacePath,
      frontendPort:
        typeof frontendPort === 'number' && frontendPort > 0
          ? frontendPort
          : (this.context?.frontendPort ?? null),
      connected: true,
      lastUpdated: new Date(),
      contextReady: sameWorkspace
        ? (this.context?.contextReady ?? false)
        : false,
      embeddingsDir: sameWorkspace
        ? (this.context?.embeddingsDir ?? null)
        : null,
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

  isBuilding(): boolean {
    return this.building;
  }

  setBuilding(building: boolean): void {
    this.building = building;
    if (!building) {
      this.release();
    }
  }

  /**
   * Resolves true once the context is ready. A build in progress is waited for (up to
   * timeoutMs); with no build running there is nothing to wait for.
   */
  waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.isContextReady()) return Promise.resolve(true);
    if (!this.building) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== done);
        resolve(this.isContextReady());
      }, timeoutMs);
      const done = (ready: boolean) => {
        clearTimeout(timer);
        resolve(ready);
      };
      this.waiters.push(done);
    });
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    const ready = this.isContextReady();
    for (const done of waiters) done(ready);
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
    this.release();
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

  /**
   * The socket dropped. The workspace and its index stay: a reconnect (webview reload,
   * network blip) for the same workspace can use them without rebuilding.
   */
  markDisconnected(): void {
    if (!this.context) return;
    this.context = {
      ...this.context,
      connected: false,
      lastUpdated: new Date(),
    };
  }
}
