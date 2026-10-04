# Tursor Backend

Node server on port **9090**. It keeps the chat, stores CDP plans, and runs them in a browser. Tursor-AI does the model work. The extension only sees text and an optional plan id.

## Run

```bash
npm install
npm run start
```

Tursor-AI must be up on port **8000** (`tursorAI start`).

Workspace config is `{workspace}/.tursor/config.json` (`ai` and `supabase`). Chat tables: `scripts/supabase-chat-schema.sql`. If the project was created before CDP plans, run that file again so `cdp_plans` exists.

## Flow

```text
Extension
  |  POST /chat/intro
  |  POST /chat/message     { conversationId, message, workspacePath }
  v
Backend :9090
  |  summary { case, plans[] } + the new user message
  |  latest plan's full steps, when one exists
  v
Tursor-AI :8000   POST /v1/chat/completion
  |  { reply, case, cdp_steps | null }
  v
Backend
  |  saves the reply
  |  if cdp_steps: new row in cdp_plans, id stored on that message
  v
Extension   { conversationId, reply, cdpStepsId }

Run Test
  Extension  POST /chat/run  { cdpStepsId }
  Backend    loads that row and runs those steps (logs and screenshots over the socket)
```

The model does not receive the full transcript. After every reply the backend stores:

```json
{
  "case": "what the user is trying to test, including corrections",
  "plans": [{ "id": "uuid", "title": "Navigate to home page" }]
}
```

`case` is the narrative. `plans` lists every plan created in the conversation. The prompt includes the newest plan's steps in full so a follow-up can revise them. A revision is a new row. Older **Run Test** buttons still run the plan from that message.

## What the extension gets

```json
{
  "conversationId": "uuid",
  "reply": "Created the login steps.",
  "cdpStepsId": "uuid"
}
```

`cdpStepsId` is `null` when the reply is only an explanation. General questions get text, and the model asks before creating steps. Steps are created in that same turn when the user says yes, or asks to create the steps or start the test.

## HTTP

| Method | Path | Body |
|---|---|---|
| `POST` | `/chat/intro` | `{ "workspacePath" }` |
| `POST` | `/chat/message` | `{ "conversationId", "message", "workspacePath" }` |
| `POST` | `/chat/run` | `{ "cdpStepsId" }` |
| `GET` | `/chat/conversations/:id` | stored messages |
| `GET` | `/health` | liveness |

`POST /chat/run` returns `{ "ok": true, "cdpStepsId" }` and starts the browser run on the connected frontend port. The Play button on the Run page still runs the built-in demo plan.
