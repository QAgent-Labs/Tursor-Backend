import { ContextService } from './context.service';

const meta = {
  embeddingsDir: '/w/.tursor/embeddings',
  filesIndexed: 1,
  chunksIndexed: 1,
  model: 'test',
};

describe('ContextService', () => {
  it('lets a chat wait for a build in progress', async () => {
    const context = new ContextService();
    context.setWorkspaceContext('/w');
    context.setBuilding(true);
    const waiting = context.waitUntilReady(5_000);
    context.markContextReady(meta);
    context.setBuilding(false);
    await expect(waiting).resolves.toBe(true);
  });

  it('does not wait when no build is running', async () => {
    const context = new ContextService();
    context.setWorkspaceContext('/w');
    await expect(context.waitUntilReady(5_000)).resolves.toBe(false);
  });

  it('answers false when the build ends without an index', async () => {
    const context = new ContextService();
    context.setWorkspaceContext('/w');
    context.setBuilding(true);
    const waiting = context.waitUntilReady(5_000);
    context.setBuilding(false);
    await expect(waiting).resolves.toBe(false);
  });

  it('keeps the index across a reconnect to the same workspace only', () => {
    const context = new ContextService();
    context.setWorkspaceContext('/w');
    context.markContextReady(meta);
    context.markDisconnected();
    context.setWorkspaceContext('/w');
    expect(context.isContextReady()).toBe(true);
    context.setWorkspaceContext('/other');
    expect(context.isContextReady()).toBe(false);
  });
});
