import type { CdpStepDefinition } from '../cdp/cdp-step.types';

export type SuiteCaseKind = 'success' | 'failure' | 'edge';

export type TestRunStatus = 'running' | 'passed' | 'failure';

/** At most this many versions of one module are kept; older ones are purged. */
export const MAX_SUITE_VERSIONS = 5;

export type TestModule = {
  id: string;
  workspacePath: string;
  moduleKey: string;
  name: string;
};

export type TestSuite = {
  id: string;
  moduleId: string;
  workspacePath: string;
  conversationId: string | null;
  prdId: string | null;
  version: number;
  feature: string;
  createdAt: string;
  checkedFingerprint: string;
  checkResult: Record<string, unknown> | null;
};

export type TestCase = {
  id: string;
  suiteId: string;
  previousCaseId: string | null;
  position: number;
  kind: SuiteCaseKind;
  title: string;
  explanation: string;
  steps: CdpStepDefinition[];
  requirementIds: string[];
};

export type TestRun = {
  id: string;
  caseId: string;
  suiteId: string;
  batchId: string | null;
  conversationId: string | null;
  status: TestRunStatus;
  statusMessage: string;
  failedStep: string;
  runFolder: string;
  screenshots: string[];
  startedAt: string;
  finishedAt: string | null;
};

/** A suite version with its module, cases, and (optionally) every run of each case. */
export type SuiteDetail = {
  suite: TestSuite;
  module: TestModule;
  cases: Array<TestCase & { runs: TestRun[] }>;
};

export type NewSuiteCase = {
  kind: SuiteCaseKind;
  title: string;
  explanation: string;
  steps: CdpStepDefinition[];
  requirementIds: string[];
};

export type PrdRequirement = {
  id: string;
  text: string;
  status: 'implemented' | 'partial' | 'missing';
  evidence: string;
  gap: string;
};

export type Prd = {
  id: string;
  workspacePath: string;
  conversationId: string | null;
  title: string;
  verdict: 'aligned' | 'gaps';
  requirements: PrdRequirement[];
};

export type SuiteReport = {
  id: string;
  suiteId: string;
  format: 'md' | 'pdf';
  filename: string;
  storagePath: string;
  url: string;
  createdAt: string;
};
