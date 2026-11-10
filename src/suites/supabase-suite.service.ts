import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkspaceSupabaseDatabaseConfig } from '../context/workspace-config.types';
import type { CdpStepDefinition } from '../cdp/cdp-step.types';
import type {
  NewSuiteCase,
  Prd,
  PrdRequirement,
  SuiteCaseKind,
  SuiteReport,
  TestCase,
  TestModule,
  TestRun,
  TestRunStatus,
  TestSuite,
} from './suite.types';

type ModuleRow = {
  id: string;
  workspace_path: string;
  module_key: string;
  name: string;
};

type SuiteRow = {
  id: string;
  module_id: string;
  workspace_path: string;
  conversation_id: string | null;
  prd_id: string | null;
  version: number;
  feature: string;
  created_at: string;
  checked_fingerprint: string | null;
  check_result: Record<string, unknown> | null;
};

type CaseRow = {
  id: string;
  suite_id: string;
  previous_case_id: string | null;
  position: number;
  kind: SuiteCaseKind;
  title: string;
  explanation: string;
  steps: CdpStepDefinition[] | null;
  requirement_ids: string[] | null;
};

type RunRow = {
  id: string;
  case_id: string;
  suite_id: string;
  batch_id: string | null;
  conversation_id: string | null;
  status: TestRunStatus;
  status_message: string;
  failed_step: string;
  run_folder: string;
  screenshots: unknown;
  started_at: string;
  finished_at: string | null;
};

type RequirementRow = {
  req_key: string;
  text: string;
  status: PrdRequirement['status'];
  evidence: string;
  gap: string;
  position: number;
};

type ReportRow = {
  id: string;
  suite_id: string;
  format: 'md' | 'pdf';
  filename: string;
  storage_path: string;
  url: string;
  created_at: string;
};

function fail(action: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${action} failed: ${error?.message ?? 'unknown'}`);
}

function mapModule(row: ModuleRow): TestModule {
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    moduleKey: row.module_key,
    name: row.name,
  };
}

function mapSuite(row: SuiteRow): TestSuite {
  return {
    id: row.id,
    moduleId: row.module_id,
    workspacePath: row.workspace_path,
    conversationId: row.conversation_id,
    prdId: row.prd_id,
    version: row.version,
    feature: row.feature,
    createdAt: row.created_at,
    checkedFingerprint: row.checked_fingerprint ?? '',
    checkResult: row.check_result ?? null,
  };
}

function mapCase(row: CaseRow): TestCase {
  return {
    id: row.id,
    suiteId: row.suite_id,
    previousCaseId: row.previous_case_id,
    position: row.position,
    kind: row.kind,
    title: row.title,
    explanation: row.explanation,
    steps: Array.isArray(row.steps) ? row.steps : [],
    requirementIds: Array.isArray(row.requirement_ids)
      ? row.requirement_ids
      : [],
  };
}

function mapRun(row: RunRow): TestRun {
  return {
    id: row.id,
    caseId: row.case_id,
    suiteId: row.suite_id,
    batchId: row.batch_id,
    conversationId: row.conversation_id,
    status: row.status,
    statusMessage: row.status_message,
    failedStep: row.failed_step,
    runFolder: row.run_folder,
    screenshots: Array.isArray(row.screenshots)
      ? row.screenshots.filter(
          (url): url is string => typeof url === 'string' && url.length > 0,
        )
      : [],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Postgres access for modules, suite versions, cases, runs, PRDs, and reports. */
export class SupabaseSuiteService {
  private readonly clientCache = new Map<string, SupabaseClient>();

  private getClient(database: WorkspaceSupabaseDatabaseConfig): SupabaseClient {
    const url = database.url.trim();
    const key = database.serviceRoleKey.trim();
    const cacheKey = `${url}:${key.slice(0, 16)}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.clientCache.set(cacheKey, client);
    return client;
  }

  private table(database: WorkspaceSupabaseDatabaseConfig, name: string) {
    const client = this.getClient(database);
    const schema = database.schema?.trim() || 'public';
    if (schema === 'public') {
      return client.from(name);
    }
    return client.schema(schema).from(name);
  }

  async upsertModule(
    database: WorkspaceSupabaseDatabaseConfig,
    input: { workspacePath: string; moduleKey: string; name: string },
  ): Promise<TestModule> {
    const { data, error } = await this.table(database, 'test_modules')
      .upsert(
        {
          workspace_path: input.workspacePath,
          module_key: input.moduleKey,
          name: input.name,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_path,module_key' },
      )
      .select('*')
      .single();
    if (error || !data) fail('upsertModule', error);
    return mapModule(data as ModuleRow);
  }

  async getModule(
    database: WorkspaceSupabaseDatabaseConfig,
    moduleId: string,
  ): Promise<TestModule | null> {
    const { data, error } = await this.table(database, 'test_modules')
      .select('*')
      .eq('id', moduleId)
      .maybeSingle();
    if (error) fail('getModule', error);
    return data ? mapModule(data as ModuleRow) : null;
  }

  async listModules(
    database: WorkspaceSupabaseDatabaseConfig,
    workspacePath: string,
  ): Promise<TestModule[]> {
    const { data, error } = await this.table(database, 'test_modules')
      .select('*')
      .eq('workspace_path', workspacePath)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) fail('listModules', error);
    return (data as ModuleRow[]).map(mapModule);
  }

  async listSuitesForModule(
    database: WorkspaceSupabaseDatabaseConfig,
    moduleId: string,
  ): Promise<TestSuite[]> {
    const { data, error } = await this.table(database, 'test_suites')
      .select('*')
      .eq('module_id', moduleId)
      .order('version', { ascending: false });
    if (error) fail('listSuitesForModule', error);
    return (data as SuiteRow[]).map(mapSuite);
  }

  async listSuitesForWorkspace(
    database: WorkspaceSupabaseDatabaseConfig,
    workspacePath: string,
  ): Promise<TestSuite[]> {
    const { data, error } = await this.table(database, 'test_suites')
      .select('*')
      .eq('workspace_path', workspacePath)
      .order('version', { ascending: false })
      .limit(500);
    if (error) fail('listSuitesForWorkspace', error);
    return (data as SuiteRow[]).map(mapSuite);
  }

  async getSuite(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteId: string,
  ): Promise<TestSuite | null> {
    const { data, error } = await this.table(database, 'test_suites')
      .select('*')
      .eq('id', suiteId)
      .maybeSingle();
    if (error) fail('getSuite', error);
    return data ? mapSuite(data as SuiteRow) : null;
  }

  async insertSuite(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      moduleId: string;
      workspacePath: string;
      conversationId: string | null;
      prdId: string | null;
      version: number;
      feature: string;
    },
  ): Promise<TestSuite> {
    const { data, error } = await this.table(database, 'test_suites')
      .insert({
        module_id: input.moduleId,
        workspace_path: input.workspacePath,
        conversation_id: input.conversationId,
        prd_id: input.prdId,
        version: input.version,
        feature: input.feature,
      })
      .select('*')
      .single();
    if (error || !data) fail('insertSuite', error);
    return mapSuite(data as SuiteRow);
  }

  async saveSuiteCheck(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteId: string,
    fingerprint: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.table(database, 'test_suites')
      .update({ checked_fingerprint: fingerprint, check_result: result })
      .eq('id', suiteId);
    if (error) fail('saveSuiteCheck', error);
  }

  /** Link a PRD to a suite that has none yet (a reused suite after a spec check). */
  async linkPrd(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteId: string,
    prdId: string,
  ): Promise<boolean> {
    const { data, error } = await this.table(database, 'test_suites')
      .update({ prd_id: prdId })
      .eq('id', suiteId)
      .is('prd_id', null)
      .select('id');
    if (error) fail('linkPrd', error);
    return Array.isArray(data) && data.length > 0;
  }

  async deleteSuites(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteIds: string[],
  ): Promise<void> {
    if (suiteIds.length === 0) return;
    const { error } = await this.table(database, 'test_suites')
      .delete()
      .in('id', suiteIds);
    if (error) fail('deleteSuites', error);
  }

  async insertCases(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteId: string,
    cases: Array<NewSuiteCase & { previousCaseId: string | null }>,
  ): Promise<TestCase[]> {
    if (cases.length === 0) return [];
    const { data, error } = await this.table(database, 'test_cases')
      .insert(
        cases.map((item, index) => ({
          suite_id: suiteId,
          previous_case_id: item.previousCaseId,
          position: index,
          kind: item.kind,
          title: item.title,
          explanation: item.explanation,
          steps: item.steps,
          requirement_ids: item.requirementIds,
        })),
      )
      .select('*');
    if (error || !data) fail('insertCases', error);
    return (data as CaseRow[])
      .map(mapCase)
      .sort((a, b) => a.position - b.position);
  }

  async listCases(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteIds: string[],
  ): Promise<TestCase[]> {
    if (suiteIds.length === 0) return [];
    const { data, error } = await this.table(database, 'test_cases')
      .select('*')
      .in('suite_id', suiteIds)
      .order('position', { ascending: true });
    if (error) fail('listCases', error);
    return (data as CaseRow[]).map(mapCase);
  }

  async getCases(
    database: WorkspaceSupabaseDatabaseConfig,
    caseIds: string[],
  ): Promise<TestCase[]> {
    if (caseIds.length === 0) return [];
    const { data, error } = await this.table(database, 'test_cases')
      .select('*')
      .in('id', caseIds);
    if (error) fail('getCases', error);
    return (data as CaseRow[]).map(mapCase);
  }

  async listRuns(
    database: WorkspaceSupabaseDatabaseConfig,
    filter: { suiteIds?: string[]; caseIds?: string[] },
  ): Promise<TestRun[]> {
    let query = this.table(database, 'test_runs').select('*');
    if (filter.suiteIds) {
      if (filter.suiteIds.length === 0) return [];
      query = query.in('suite_id', filter.suiteIds);
    }
    if (filter.caseIds) {
      if (filter.caseIds.length === 0) return [];
      query = query.in('case_id', filter.caseIds);
    }
    const { data, error } = await query.order('started_at', {
      ascending: true,
    });
    if (error) fail('listRuns', error);
    return (data as RunRow[]).map(mapRun);
  }

  async insertRun(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      caseId: string;
      suiteId: string;
      batchId: string | null;
      conversationId: string | null;
      runFolder: string;
    },
  ): Promise<TestRun> {
    const { data, error } = await this.table(database, 'test_runs')
      .insert({
        case_id: input.caseId,
        suite_id: input.suiteId,
        batch_id: input.batchId,
        conversation_id: input.conversationId,
        run_folder: input.runFolder,
        status: 'running',
      })
      .select('*')
      .single();
    if (error || !data) fail('insertRun', error);
    return mapRun(data as RunRow);
  }

  async finishRun(
    database: WorkspaceSupabaseDatabaseConfig,
    runId: string,
    input: {
      status: 'passed' | 'failure';
      statusMessage: string;
      failedStep: string;
      screenshots: string[];
    },
  ): Promise<void> {
    const { error } = await this.table(database, 'test_runs')
      .update({
        status: input.status,
        status_message: input.statusMessage,
        failed_step: input.failedStep,
        screenshots: input.screenshots,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);
    if (error) fail('finishRun', error);
  }

  async insertPrd(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      workspacePath: string;
      conversationId: string;
      title: string;
      content: string;
      verdict: 'aligned' | 'gaps';
      requirements: PrdRequirement[];
    },
  ): Promise<Prd> {
    const { data, error } = await this.table(database, 'prds')
      .insert({
        workspace_path: input.workspacePath,
        conversation_id: input.conversationId,
        title: input.title,
        content: input.content,
        verdict: input.verdict,
      })
      .select('id')
      .single();
    if (error || !data) fail('insertPrd', error);
    const prdId = (data as { id: string }).id;
    if (input.requirements.length > 0) {
      const { error: reqError } = await this.table(
        database,
        'prd_requirements',
      ).insert(
        input.requirements.map((item, index) => ({
          prd_id: prdId,
          req_key: item.id,
          text: item.text,
          status: item.status,
          evidence: item.evidence,
          gap: item.gap,
          position: index,
        })),
      );
      if (reqError) fail('insertPrdRequirements', reqError);
    }
    return {
      id: prdId,
      workspacePath: input.workspacePath,
      conversationId: input.conversationId,
      title: input.title,
      verdict: input.verdict,
      requirements: input.requirements,
    };
  }

  async getPrd(
    database: WorkspaceSupabaseDatabaseConfig,
    prdId: string,
  ): Promise<Prd | null> {
    const { data, error } = await this.table(database, 'prds')
      .select('id, workspace_path, conversation_id, title, verdict')
      .eq('id', prdId)
      .maybeSingle();
    if (error) fail('getPrd', error);
    if (!data) return null;
    const row = data as {
      id: string;
      workspace_path: string;
      conversation_id: string | null;
      title: string;
      verdict: 'aligned' | 'gaps';
    };
    const { data: reqs, error: reqError } = await this.table(
      database,
      'prd_requirements',
    )
      .select('req_key, text, status, evidence, gap, position')
      .eq('prd_id', prdId)
      .order('position', { ascending: true });
    if (reqError) fail('getPrdRequirements', reqError);
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      conversationId: row.conversation_id,
      title: row.title,
      verdict: row.verdict,
      requirements: (reqs as RequirementRow[]).map((item) => ({
        id: item.req_key,
        text: item.text,
        status: item.status,
        evidence: item.evidence,
        gap: item.gap,
      })),
    };
  }

  async insertReport(
    database: WorkspaceSupabaseDatabaseConfig,
    input: {
      suiteId: string;
      conversationId: string | null;
      format: 'md' | 'pdf';
      filename: string;
      storagePath: string;
      url: string;
    },
  ): Promise<SuiteReport> {
    const { data, error } = await this.table(database, 'suite_reports')
      .insert({
        suite_id: input.suiteId,
        conversation_id: input.conversationId,
        format: input.format,
        filename: input.filename,
        storage_path: input.storagePath,
        url: input.url,
      })
      .select('*')
      .single();
    if (error || !data) fail('insertReport', error);
    const row = data as ReportRow;
    return {
      id: row.id,
      suiteId: row.suite_id,
      format: row.format,
      filename: row.filename,
      storagePath: row.storage_path,
      url: row.url,
      createdAt: row.created_at,
    };
  }

  async listReportPaths(
    database: WorkspaceSupabaseDatabaseConfig,
    suiteIds: string[],
  ): Promise<string[]> {
    if (suiteIds.length === 0) return [];
    const { data, error } = await this.table(database, 'suite_reports')
      .select('storage_path')
      .in('suite_id', suiteIds);
    if (error) fail('listReportPaths', error);
    return (data as Array<{ storage_path: string }>).map(
      (row) => row.storage_path,
    );
  }
}
