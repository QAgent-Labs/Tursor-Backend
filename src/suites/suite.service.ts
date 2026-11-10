import type { CdpStepDefinition } from '../cdp/cdp-step.types';
import { createLogger } from '../lib/logger';
import type { RunLogPayload } from '../websocket/run-log.types';
import type {
  WorkspaceSupabaseBucketConfig,
  WorkspaceSupabaseDatabaseConfig,
} from '../context/workspace-config.types';
import { ScreenshotStorageService } from '../cdp/screenshot-storage.service';
import { SupabaseScreenshotService } from '../cdp/supabase-screenshot.service';
import { SupabaseSuiteService } from './supabase-suite.service';
import {
  MAX_SUITE_VERSIONS,
  type NewSuiteCase,
  type SuiteDetail,
  type TestCase,
  type TestModule,
  type TestSuite,
} from './suite.types';

type Stores = {
  database: WorkspaceSupabaseDatabaseConfig;
  bucket: WorkspaceSupabaseBucketConfig;
};

/** What chat needs to offer an existing suite: its latest version per module. */
export type LastRunSummary = {
  run_id: string;
  status: string;
  finished_at: string;
  failed_step: string;
  status_message: string;
};

export type ExistingSuiteSummary = {
  suite_id: string;
  module_key: string;
  module_name: string;
  feature: string;
  version: number;
  created_at: string;
  cases: Array<{
    id: string;
    title: string;
    kind: string;
    last_status: string;
    /** The latest finished run, so chat can answer questions about results. */
    last_run: LastRunSummary | null;
    steps: CdpStepDefinition[];
  }>;
  checked_fingerprint: string;
  check_result: Record<string, unknown> | null;
};

function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '') || 'case';
}

/** Module keys are routes like /checkout/:workId; a readable slug for folder names. */
export function moduleSlug(module: TestModule): string {
  return slugify(module.name || module.moduleKey.replace(/[:/]/g, ' '), 32);
}

/**
 * Merge the cases the model returned into the base version.
 * Base cases are copied forward (linked to their previous row). A returned case
 * with the same title replaces that base case; any other returned case is added.
 */
export function mergeCases(
  base: TestCase[],
  generated: NewSuiteCase[],
): Array<NewSuiteCase & { previousCaseId: string | null }> {
  const merged: Array<NewSuiteCase & { previousCaseId: string | null }> =
    base.map((item) => ({
      kind: item.kind,
      title: item.title,
      explanation: item.explanation,
      steps: item.steps,
      requirementIds: item.requirementIds,
      previousCaseId: item.id,
    }));
  for (const item of generated) {
    const index = merged.findIndex(
      (existing) => titleKey(existing.title) === titleKey(item.title),
    );
    if (index === -1) {
      merged.push({ ...item, previousCaseId: null });
    } else {
      merged[index] = { ...item, previousCaseId: merged[index].previousCaseId };
    }
  }
  return merged;
}

export class SuiteService {
  private readonly logger = createLogger('SuiteService');
  private panelLog: (payload: RunLogPayload) => void = () => undefined;

  /** Lines for the extension's log panel (wired to the socket gateway). */
  setPanelLog(log: (payload: RunLogPayload) => void): void {
    this.panelLog = log;
  }

  constructor(
    private readonly store: SupabaseSuiteService,
    private readonly screenshots: SupabaseScreenshotService,
    private readonly localShots: ScreenshotStorageService,
  ) {}

  async getDetail(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteId: string,
    options: { withRuns: boolean },
  ): Promise<SuiteDetail | null> {
    const suite = await this.store.getSuite(database, suiteId);
    if (!suite) return null;
    const module = await this.store.getModule(database, suite.moduleId);
    if (!module) return null;
    const cases = await this.store.listCases(database, [suite.id]);
    const runs = options.withRuns
      ? await this.store.listRuns(database, { suiteIds: [suite.id] })
      : [];
    return {
      suite,
      module,
      cases: cases.map((item) => ({
        ...item,
        runs: runs.filter((run) => run.caseId === item.id),
      })),
    };
  }

  /** Latest version of every module in the workspace, with each case's last result. */
  async listExisting(
    database: WorkspaceSupabaseDatabaseConfig,
    workspacePath: string,
  ): Promise<ExistingSuiteSummary[]> {
    const [modules, suites] = await Promise.all([
      this.store.listModules(database, workspacePath),
      this.store.listSuitesForWorkspace(database, workspacePath),
    ]);
    const latest = new Map<string, TestSuite>();
    for (const suite of suites) {
      const current = latest.get(suite.moduleId);
      if (!current || suite.version > current.version) {
        latest.set(suite.moduleId, suite);
      }
    }
    const chosen = [...latest.values()].slice(0, 30);
    const cases = await this.store.listCases(
      database,
      chosen.map((suite) => suite.id),
    );
    const runs = await this.store.listRuns(database, {
      suiteIds: chosen.map((suite) => suite.id),
    });
    const byModule = new Map(modules.map((item) => [item.id, item]));
    return chosen.flatMap((suite) => {
      const module = byModule.get(suite.moduleId);
      if (!module) return [];
      return [
        {
          suite_id: suite.id,
          module_key: module.moduleKey,
          module_name: module.name,
          feature: suite.feature,
          version: suite.version,
          created_at: suite.createdAt,
          cases: cases
            .filter((item) => item.suiteId === suite.id)
            .map((item) => {
              const finished = runs.filter(
                (run) => run.caseId === item.id && run.status !== 'running',
              );
              const last = finished.at(-1);
              return {
                id: item.id,
                title: item.title,
                kind: item.kind,
                last_status: last?.status ?? '',
                last_run: last
                  ? {
                      run_id: last.id,
                      status: last.status,
                      finished_at: last.finishedAt ?? last.startedAt,
                      failed_step: last.failedStep,
                      status_message: last.statusMessage.slice(0, 600),
                    }
                  : null,
                steps: item.steps,
              };
            }),
          checked_fingerprint: suite.checkedFingerprint,
          check_result: suite.checkResult,
        },
      ];
    });
  }

  /**
   * Save a new version of the module's suite: the latest version's cases plus
   * the returned delta. Then keep only MAX_SUITE_VERSIONS versions.
   */
  async createVersion(
    stores: Stores,
    input: {
      workspacePath: string;
      conversationId: string;
      moduleKey: string;
      moduleName: string;
      feature: string;
      prdId: string | null;
      cases: NewSuiteCase[];
    },
  ): Promise<SuiteDetail> {
    const module = await this.store.upsertModule(stores.database, {
      workspacePath: input.workspacePath,
      moduleKey: input.moduleKey,
      name: input.moduleName || input.feature,
    });
    const existing = await this.store.listSuitesForModule(
      stores.database,
      module.id,
    );
    const base = existing[0] ?? null;
    const baseCases = base
      ? await this.store.listCases(stores.database, [base.id])
      : [];
    const merged = mergeCases(baseCases, input.cases);
    const baseTitles = new Set(baseCases.map((item) => titleKey(item.title)));
    const changed = input.cases.filter((item) =>
      baseTitles.has(titleKey(item.title)),
    ).length;
    const added = input.cases.length - changed;

    let suite: TestSuite | null = null;
    let version = (base?.version ?? 0) + 1;
    // A concurrent save can take the same version number; retry with the next one.
    for (let attempt = 0; attempt < 3 && !suite; attempt += 1) {
      try {
        suite = await this.store.insertSuite(stores.database, {
          moduleId: module.id,
          workspacePath: input.workspacePath,
          conversationId: input.conversationId,
          prdId: input.prdId ?? base?.prdId ?? null,
          version,
          feature: input.feature,
        });
      } catch (err) {
        if (attempt === 2) throw err;
        version += 1;
      }
    }
    if (!suite) {
      throw new Error('Could not save the new suite version.');
    }
    const cases = await this.store.insertCases(
      stores.database,
      suite.id,
      merged,
    );
    this.panelLog({
      category: 'suite',
      level: 'success',
      message: base
        ? `Saved ${module.name || module.moduleKey} v${suite.version}: ${cases.length} cases ` +
          `(${baseCases.length - changed} carried over from v${base.version}, ${changed} changed, ${added} added).`
        : `Saved ${module.name || module.moduleKey} v${suite.version}: ${cases.length} cases (new suite).`,
      meta: {
        suiteId: suite.id,
        moduleKey: module.moduleKey,
        version: suite.version,
        carried: baseCases.length - changed,
        changed,
        added,
      },
    });
    await this.purgeOldVersions(stores, module, input.workspacePath);
    return {
      suite,
      module,
      cases: cases.map((item) => ({ ...item, runs: [] })),
    };
  }

  /** Delete versions beyond the newest MAX_SUITE_VERSIONS: rows, screenshots, reports. */
  async purgeOldVersions(
    stores: Stores,
    module: TestModule,
    workspacePath: string,
  ): Promise<string[]> {
    const suites = await this.store.listSuitesForModule(
      stores.database,
      module.id,
    );
    const stale = suites.slice(MAX_SUITE_VERSIONS);
    if (stale.length === 0) return [];
    const staleIds = stale.map((suite) => suite.id);
    const runs = await this.store.listRuns(stores.database, {
      suiteIds: staleIds,
    });
    const folders = [...new Set(runs.map((run) => run.runFolder))];
    const reportPaths = await this.store.listReportPaths(
      stores.database,
      staleIds,
    );
    try {
      await this.screenshots.removeRunFolders(stores.bucket, folders);
      await this.screenshots.removeObjects(stores.bucket, reportPaths);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Storage cleanup for purged versions failed: ${detail}`);
    }
    this.localShots.removeRunFolders(workspacePath, folders);
    await this.store.deleteSuites(stores.database, staleIds);
    const purged = stale.map((suite) => `v${suite.version}`).join(', ');
    this.logger.log(
      `Purged ${stale.length} old version(s) of ${module.moduleKey}: ${purged}`,
    );
    this.panelLog({
      category: 'suite',
      level: 'info',
      message:
        `Kept the newest ${MAX_SUITE_VERSIONS} versions of ${module.name || module.moduleKey}; ` +
        `purged ${purged} with ${runs.length} run(s), ${folders.length} screenshot folder(s), ` +
        `and ${reportPaths.length} report(s).`,
      meta: { moduleKey: module.moduleKey, purged: staleIds },
    });
    return staleIds;
  }

  /** Rank 1 is the newest version of the module, MAX_SUITE_VERSIONS the oldest kept. */
  async versionRank(
    database: WorkspaceSupabaseDatabaseConfig,
    suite: TestSuite,
  ): Promise<number> {
    const suites = await this.store.listSuitesForModule(
      database,
      suite.moduleId,
    );
    const index = suites.findIndex((item) => item.id === suite.id);
    return index === -1 ? 1 : index + 1;
  }
}
