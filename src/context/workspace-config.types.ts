/** Supabase Storage settings (maps to SUPABASE_* backend env vars). */
export type WorkspaceSupabaseConfig = {
  url: string;
  serviceRoleKey: string;
  storageBucket: string;
};

export type WorkspaceTursorConfig = {
  excluded?: string[];
  supabase: WorkspaceSupabaseConfig;
};
