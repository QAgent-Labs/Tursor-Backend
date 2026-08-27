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
