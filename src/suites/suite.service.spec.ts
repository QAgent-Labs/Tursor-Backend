import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScreenshotStorageService } from '../cdp/screenshot-storage.service';
import type { SupabaseScreenshotService } from '../cdp/supabase-screenshot.service';
import { runStamp } from '../websocket/run-orchestrator.service';
import { mergeCases, moduleSlug, slugify, SuiteService } from './suite.service';
import type { SupabaseSuiteService } from './supabase-suite.service';
import type { TestCase, TestRun, TestSuite } from './suite.types';

const step = (id: string) => ({
  id,
  label: id,
  actions: [{ type: 'navigate' as const, path: '/' }],
});

function baseCase(id: string, title: string): TestCase {
  return {
    id,
    suiteId: 's1',
    previousCaseId: null,
    position: 0,
    kind: 'success',
    title,
    explanation: '',
    steps: [step(id)],
    requirementIds: [],
  };
}

describe('mergeCases', () => {
  it('copies base cases forward and links each to its previous row', () => {
    const merged = mergeCases(
      [baseCase('a', 'Valid sign-in'), baseCase('b', 'Wrong password')],
      [],
    );
    expect(merged.map((item) => item.previousCaseId)).toEqual(['a', 'b']);
  });

  it('replaces a case with the same title and appends new ones', () => {
    const merged = mergeCases(
      [baseCase('a', 'Valid sign-in'), baseCase('b', 'Wrong password')],
      [
        {
          kind: 'failure',
          title: '  wrong   PASSWORD ',
          explanation: 'fixed',
          steps: [step('new-b')],
          requirementIds: ['R2'],
        },
        {
          kind: 'edge',
          title: 'Empty email',
          explanation: '',
          steps: [step('c')],
          requirementIds: [],
        },
      ],
    );
    expect(merged).toHaveLength(3);
    expect(merged[1].explanation).toBe('fixed');
    expect(merged[1].previousCaseId).toBe('b');
    expect(merged[1].requirementIds).toEqual(['R2']);
    expect(merged[2].title).toBe('Empty email');
    expect(merged[2].previousCaseId).toBeNull();
  });
});

describe('names', () => {
  it('builds readable folder parts', () => {
    expect(slugify('Valid sign-in reaches the Studio!')).toBe(
      'valid-sign-in-reaches-the-studio',
    );
    expect(
      moduleSlug({
        id: 'm',
        workspacePath: '/w',
        moduleKey: '/checkout/:workId',
        name: '',
      }),
    ).toBe('checkout-workid');
    expect(runStamp(new Date(2026, 9, 25, 14, 3, 7))).toBe(
      '2026-10-25_14-03-07',
    );
  });
});

describe('ScreenshotStorageService folders', () => {
  it('names a run folder and never removes outside the runs root', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tursor-ws-'));
    const storage = new ScreenshotStorageService();
    const first = storage.createRunDirectory(workspace, '2026-10-25_login_v3');
    const second = storage.createRunDirectory(workspace, '2026-10-25_login_v3');
    expect(first.runId).toBe('2026-10-25_login_v3');
    expect(second.runId).toBe('2026-10-25_login_v3-2');

    const outside = path.join(workspace, '.tursor', 'keep');
    fs.mkdirSync(outside, { recursive: true });
    storage.removeRunFolders(workspace, ['../keep', first.runId]);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(first.dir)).toBe(false);
    expect(fs.existsSync(second.dir)).toBe(true);
  });
});

describe('SuiteService.purgeOldVersions', () => {
  it('keeps five versions and removes runs, screenshots and reports of older ones', async () => {
    const suites: TestSuite[] = [7, 6, 5, 4, 3, 2, 1].map((version) => ({
      id: `s${version}`,
      moduleId: 'm',
      workspacePath: '/w',
      conversationId: null,
      prdId: null,
      version,
      feature: 'Login',
      createdAt: '',
      checkedFingerprint: '',
      checkResult: null,
    }));
    const runs: Partial<TestRun>[] = [
      { suiteId: 's2', runFolder: 'f2' },
      { suiteId: 's1', runFolder: 'f1' },
      { suiteId: 's1', runFolder: 'f1' },
    ];
    const deleted: string[][] = [];
    const store = {
      listSuitesForModule: jest.fn().mockResolvedValue(suites),
      listRuns: jest.fn().mockResolvedValue(runs),
      listReportPaths: jest.fn().mockResolvedValue(['reports/s1/a.md']),
      deleteSuites: jest.fn((_db, ids: string[]) => {
        deleted.push(ids);
        return Promise.resolve();
      }),
    } as unknown as SupabaseSuiteService;
    const remote = {
      removeRunFolders: jest.fn().mockResolvedValue(undefined),
      removeObjects: jest.fn().mockResolvedValue(undefined),
    } as unknown as SupabaseScreenshotService;
    const local = new ScreenshotStorageService();
    const removeLocal = jest
      .spyOn(local, 'removeRunFolders')
      .mockImplementation(() => undefined);

    const service = new SuiteService(store, remote, local);
    const purged = await service.purgeOldVersions(
      {
        database: { url: 'u', serviceRoleKey: 'k', schema: 'public' },
        bucket: { url: 'u', serviceRoleKey: 'k', name: 'b' },
      },
      { id: 'm', workspacePath: '/w', moduleKey: '/login', name: 'Login' },
      '/w',
    );

    expect(purged).toEqual(['s2', 's1']);
    expect(deleted).toEqual([['s2', 's1']]);
    expect(remote.removeRunFolders).toHaveBeenCalledWith(expect.anything(), [
      'f2',
      'f1',
    ]);
    expect(remote.removeObjects).toHaveBeenCalledWith(expect.anything(), [
      'reports/s1/a.md',
    ]);
    expect(removeLocal).toHaveBeenCalledWith('/w', ['f2', 'f1']);
  });
});
