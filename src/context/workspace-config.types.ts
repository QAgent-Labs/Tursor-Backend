/** Supabase Storage settings (maps to SUPABASE_* backend env vars). */
export type WorkspaceSupabaseConfig = {
  url: string;
  serviceRoleKey: string;
  storageBucket: string;
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
