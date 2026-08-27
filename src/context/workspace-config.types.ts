/** Supabase Storage bucket settings (CDP run screenshots). */
export type WorkspaceSupabaseBucketConfig = {
  url: string;
  serviceRoleKey: string;
  name: string;
};

/** Supabase Postgres settings (chat conversation persistence). */
export type WorkspaceSupabaseDatabaseConfig = {
  url: string;
  serviceRoleKey: string;
  schema: string;
};

/** Supabase settings from workspace `.tursor/config.json`. */
export type WorkspaceSupabaseConfig = {
  bucket: WorkspaceSupabaseBucketConfig;
  database: WorkspaceSupabaseDatabaseConfig;
};

/** LLM settings for chat / test generation (from workspace config). */
export type WorkspaceAiConfig = {
  generationModel: string;
  apiKey: string;
};

export type WorkspaceTursorConfig = {
  project?: { name?: string };
  include?: { patterns?: string[] };
  excluded?: string[];
  supabase: WorkspaceSupabaseConfig;
  ai?: WorkspaceAiConfig;
};
