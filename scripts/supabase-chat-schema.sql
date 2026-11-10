-- Tursor chat persistence (run in Supabase SQL Editor)
-- Credentials: workspace .tursor/config.json → supabase.database
-- See: Tursor-Backend/docs/SUPABASE_SETUP.md

create extension if not exists "pgcrypto";

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_path text not null,
  status text not null default 'NORMAL',
  title text,
  summary text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_workspace_path_idx
  on conversations (workspace_path);

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  message_type text not null default 'chat',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversation_messages_conversation_id_idx
  on conversation_messages (conversation_id, created_at);

create table if not exists generated_tests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  workspace_path text not null,
  test_name text,
  language text not null default 'typescript',
  framework text not null default 'playwright',
  code text not null,
  version int not null default 1,
  status text not null default 'generated',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists generated_tests_conversation_id_idx
  on generated_tests (conversation_id);

create table if not exists cdp_plans (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  workspace_path text not null,
  title text not null default '',
  steps jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists cdp_plans_conversation_id_idx
  on cdp_plans (conversation_id);

-- ---------------------------------------------------------------------------
-- Versioned test suites (module -> suite version -> test case -> runs)
-- Every table carries workspace_path (directly or through its parent) so one
-- Supabase project can hold several workspaces without their data mixing.
-- ---------------------------------------------------------------------------

create table if not exists test_modules (
  id uuid primary key default gen_random_uuid(),
  workspace_path text not null,
  module_key text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_path, module_key)
);

create table if not exists prds (
  id uuid primary key default gen_random_uuid(),
  workspace_path text not null,
  conversation_id uuid references conversations(id) on delete set null,
  title text not null default '',
  content text not null,
  verdict text not null default 'gaps' check (verdict in ('aligned', 'gaps')),
  created_at timestamptz not null default now()
);

create index if not exists prds_workspace_path_idx on prds (workspace_path);

create table if not exists prd_requirements (
  id uuid primary key default gen_random_uuid(),
  prd_id uuid not null references prds(id) on delete cascade,
  req_key text not null,
  text text not null,
  status text not null check (status in ('implemented', 'partial', 'missing')),
  evidence text not null default '',
  gap text not null default '',
  position int not null default 0,
  unique (prd_id, req_key)
);

-- One row per version. version only ever grows; "1 = latest" is computed on read.
create table if not exists test_suites (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references test_modules(id) on delete cascade,
  workspace_path text not null,
  conversation_id uuid references conversations(id) on delete set null,
  prd_id uuid references prds(id) on delete set null,
  version int not null,
  feature text not null default '',
  created_at timestamptz not null default now(),
  unique (module_id, version)
);

create index if not exists test_suites_workspace_path_idx on test_suites (workspace_path);

create table if not exists test_cases (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references test_suites(id) on delete cascade,
  previous_case_id uuid references test_cases(id) on delete set null,
  position int not null default 0,
  kind text not null check (kind in ('success', 'failure', 'edge')),
  title text not null,
  explanation text not null default '',
  steps jsonb not null,
  requirement_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists test_cases_suite_id_idx on test_cases (suite_id, position);

create table if not exists test_runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references test_cases(id) on delete cascade,
  suite_id uuid not null references test_suites(id) on delete cascade,
  batch_id uuid,
  conversation_id uuid references conversations(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'passed', 'failure')),
  status_message text not null default '',
  failed_step text not null default '',
  run_folder text not null,
  screenshots jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists test_runs_case_id_idx on test_runs (case_id, started_at);
create index if not exists test_runs_suite_id_idx on test_runs (suite_id);

create table if not exists suite_reports (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references test_suites(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  format text not null check (format in ('md', 'pdf')),
  filename text not null,
  storage_path text not null,
  url text not null,
  created_at timestamptz not null default now()
);

create index if not exists suite_reports_suite_id_idx on suite_reports (suite_id);

-- The backend uses the service-role key, which bypasses RLS. Enabling RLS with no
-- policies keeps the anon key from reading or writing these tables.
alter table test_modules enable row level security;
alter table prds enable row level security;
alter table prd_requirements enable row level security;
alter table test_suites enable row level security;
alter table test_cases enable row level security;
alter table test_runs enable row level security;
alter table suite_reports enable row level security;

-- Last check of a suite version against the code. Reused while the fingerprint of the
-- flow's files is unchanged, so a suite is only re-reviewed after its code changes.
alter table test_suites add column if not exists checked_fingerprint text not null default '';
alter table test_suites add column if not exists check_result jsonb;
