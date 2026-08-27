# Supabase Setup for Tursor

Tursor uses **one Supabase project** per workspace, configured in `{workspace}/.tursor/config.json`. Supabase provides two capabilities Tursor needs:

| Capability | Config block | Used by |
|------------|--------------|---------|
| **Postgres** (chat persistence) | `supabase.database` | Backend `SupabaseChatService` |
| **Storage** (CDP screenshots) | `supabase.bucket` | Backend `SupabaseScreenshotService` |

Credentials come **only** from workspace config — not from Backend `.env`.

---

## 1. Create a Supabase project

1. Go to [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. **New project** → pick org, name, region, database password
3. Wait for provisioning (~2 minutes)

You will need:

- **Project URL** — Settings → API → `Project URL`  
  Example: `https://piysajazhxfqrysbifhv.supabase.co`
- **Service role key** — Settings → API → `service_role` (secret)  
  Used server-side by Tursor Backend only. **Never commit to git or expose in the Extension.**

---

## 2. Create database tables (chat)

Tursor stores conversations in Postgres. Run the schema once per Supabase project.

### Option A — SQL Editor (recommended)

1. Supabase Dashboard → **SQL Editor** → **New query**
2. Paste the contents of:

   `Tursor-Backend/scripts/supabase-chat-schema.sql`

3. Click **Run**

### Option B — Supabase CLI

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push --file Tursor-Backend/scripts/supabase-chat-schema.sql
```

### Tables created

| Table | Purpose |
|-------|---------|
| `conversations` | One row per chat session (`status`, `summary`, `workspace_path`) |
| `conversation_messages` | User/assistant messages + metadata (`testFlow`, etc.) |
| `generated_tests` | Playwright code after flow approval |

The Backend connects with the **service role key**, which bypasses Row Level Security. No RLS policies are required for Tursor's server-side usage.

### Verify tables

SQL Editor:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('conversations', 'conversation_messages', 'generated_tests');
```

---

## 3. Create storage bucket (screenshots)

CDP runs upload JPEG screenshots to Supabase Storage.

### Dashboard

1. **Storage** → **New bucket**
2. Name: `Tursor-Screenshots` (or your choice — must match config)
3. **Public bucket**: ON (so the Extension can display screenshot URLs)
4. Create

### Optional — SQL (storage schema)

Buckets are usually created via UI. If you prefer API/CLI:

```bash
curl -X POST "https://YOUR_PROJECT.supabase.co/storage/v1/bucket" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tursor-Screenshots","public":true}'
```

### Verify bucket

Dashboard → Storage → bucket listed as **Public**.

Test upload (replace values):

```bash
echo 'test' | curl -X POST \
  "https://YOUR_PROJECT.supabase.co/storage/v1/object/Tursor-Screenshots/test/hello.txt" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: text/plain" \
  --data-binary @-
```

---

## 4. Workspace config (`.tursor/config.json`)

All Supabase settings are read from the **workspace** config file.

### Required shape (nested `bucket` + `database`)

```json
{
  "project": { "name": "my-app" },
  "include": { "patterns": ["src/**"] },
  "supabase": {
    "bucket": {
      "url": "https://YOUR_PROJECT.supabase.co",
      "serviceRoleKey": "eyJhbGci...",
      "name": "Tursor-Screenshots"
    },
    "database": {
      "url": "https://YOUR_PROJECT.supabase.co",
      "serviceRoleKey": "eyJhbGci...",
      "schema": "public"
    }
  },
  "ai": {
    "generationModel": "gpt-5.6",
    "apiKey": "sk-..."
  }
}
```

### Field reference

| Field | Required | Purpose |
|-------|----------|---------|
| `supabase.bucket.url` | Yes (CDP) | Supabase project URL for Storage API |
| `supabase.bucket.serviceRoleKey` | Yes (CDP) | Upload screenshots |
| `supabase.bucket.name` | Yes (CDP) | Storage bucket name |
| `supabase.database.url` | Yes (chat) | Supabase project URL for PostgREST |
| `supabase.database.serviceRoleKey` | Yes (chat) | Insert/select chat rows |
| `supabase.database.schema` | No (default `public`) | Postgres schema for chat tables |

Same project URL and service role key are typically duplicated in both blocks. Splitting them allows future use of different projects for storage vs database.

### Legacy flat config (still supported)

```json
"supabase": {
  "url": "...",
  "serviceRoleKey": "...",
  "storageBucket": "Tursor-Screenshots"
}
```

The validator maps this to `bucket` + `database` automatically.

---

## 5. How Backend reads config

```text
Extension / curl
    → Backend WorkspaceConfigValidator.validate(workspacePath)
    → reads .tursor/config.json
    → returns { bucket, database, ai }

Chat APIs     → supabase.database  → SupabaseChatService
CDP runs      → supabase.bucket    → SupabaseScreenshotService
```

Code paths:

- `Tursor-Backend/src/context/workspace-config.validator.ts` — parsing
- `Tursor-Backend/src/chat/supabase-chat.service.ts` — Postgres
- `Tursor-Backend/src/cdp/supabase-screenshot.service.ts` — Storage

---

## 6. End-to-end verification

### Chat (database)

```bash
# Backend running on :9090, schema applied, ai block in config
curl -s -X POST http://127.0.0.1:9090/chat/intro \
  -H 'Content-Type: application/json' \
  -d '{"workspacePath":"/path/to/workspace"}' | jq '.conversation.id'
```

Success → UUID returned; row in `conversations` table.

### CDP (bucket)

Start a CDP run from the Extension Run page. Each step should emit a public screenshot URL. Check Storage → `Tursor-Screenshots` → `runs/` prefix.

---

## 7. Security notes

- **Service role key** = full admin access. Keep in `.tursor/config.json` only; add `.tursor/` to `.gitignore`.
- Never return `serviceRoleKey` or `ai.apiKey` in HTTP responses.
- Public bucket is intentional for screenshot URLs; do not store secrets in that bucket.

---

## 8. Troubleshooting

| Error | Fix |
|-------|-----|
| `Supabase createConversation failed: relation "conversations" does not exist` | Run `supabase-chat-schema.sql` |
| `Supabase upload failed: Bucket not found` | Create bucket; match `supabase.bucket.name` |
| `Supabase public URL missing` | Set bucket to **Public** |
| `Missing supabase.bucket` | Use nested config or legacy flat keys |
| JWT / invalid API key | Copy fresh `service_role` from Supabase Settings → API |
