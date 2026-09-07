# pai-cli

Multi-session host for the pi coding agent: **one process, many conversations**, JSONL over stdio. The Electron (or any) client spawns this CLI and renders; all agent state lives here.

```
Electron app                         pai-cli
├── windows (render only)   stdin→   thread/start | prompt | ui_response ...
└── dialogs/routing         stdout←  response | event{threadId} | ui_request | heartbeat
```

## Run

```bash
# From this repo (zero install; resolves the workspace package):
bun src/cli.ts

# Standalone (outside the repo):
npm install && npm start

# Debug without a UI:
echo '{"id":"1","type":"thread/start","cwd":"/tmp"}' | bun src/cli.ts
```

Requires pi auth (`~/.pi/agent/auth.json` via `pi` + `/login`, or provider API keys in the environment) for actual prompts.

## Protocol

JSONL, LF-delimited only (strip optional trailing `\r`; do not use Node `readline`, it splits on U+2028/U+2029 inside JSON strings). Input lines are capped at 16 MiB; oversized lines are dropped with a parse failure. `thread/resume` without `cwd` uses the session header's recorded cwd.

### Commands (stdin)

| Command                                      | Fields                                                                                                    | Notes                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `thread/start`                               | `cwd?`, `provider?`+`modelId?`, `trusted?`                                                                | New conversation; response carries `threadId` (= pi session id) and `sessionPath`                |
| `thread/resume`                              | `sessionPath`, `cwd?`, `trusted?`                                                                         | Reopen a saved conversation; rejected if already open in this hub (two writers corrupt the file) |
| `thread/stop`                                | `threadId`                                                                                                | Dispose; the session file remains for later `thread/resume`                                      |
| `thread/list`                                |                                                                                                           | Live threads with `isStreaming`                                                                  |
| `thread/list_saved`                          | `cwd?`                                                                                                    | Saved sessions for a cwd (history list UI)                                                       |
| `prompt`                                     | `threadId`, `message`, `streamingBehavior?` (`"steer"`/`"followUp"`, required while streaming), `images?` | Fire-and-accept; reply streams as `event` frames                                                 |
| `steer` / `follow_up`                        | `threadId`, `message`                                                                                     | Queue mid-stream / post-run messages                                                             |
| `abort`                                      | `threadId`                                                                                                | Stop the thread's current run                                                                    |
| `compact`                                    | `threadId`, `customInstructions?`                                                                         | Manual compaction                                                                                |
| `get_state` / `get_messages`                 | `threadId`                                                                                                | State / full history                                                                             |
| `set_model` / `get_models`                   | `provider`+`modelId`                                                                                      | Per-thread model, shared catalog                                                                 |
| `set_thinking_level` / `get_thinking_levels` | `threadId`, `level?`                                                                                      |                                                                                                  |
| `ui_response`                                | `requestId`, `payload`                                                                                    | Answer a dialog; always acked (late/unknown ids ignored)                                         |

### Frames (stdout)

- `response` `{ id?, command, success, data? | error }` — correlated by `id`; `prompt` responds at acceptance time (preflight), later failures ride the event stream
- `event` `{ threadId, event }` — every `AgentSessionEvent`, tagged; `message_update` frames strip cumulative snapshots (`message`, `partial`) so per-delta frame size stays constant
- `ui_request` `{ requestId, threadId, method, ... }` — `confirm`/`select`/`input`/`editor` need a `ui_response` with `{ confirmed }` / `{ value }` / `{ cancelled: true }`; `notify`/`setStatus` are fire-and-forget. Dialogs carry a timeout (see permission gate): on expiry the hub resolves the default (deny) itself, so an unattended client cannot block the agent.
- `heartbeat` — 1 Hz; absence means the event loop is blocked (client should kill + `thread/resume` everything)
- `hub_error` — uncaught exception / rejection report; process stays alive

## Permissions

Every thread runs the built-in permission gate (inline extension). Rules in `~/.pi/agent/permission-rules.json`, re-read per tool call, so a settings UI can edit it live:

```json
{
  "mode": "ask",
  "bash": {
    "allowPatterns": ["git status", "git diff*", "npm run *"],
    "blockPatterns": ["sudo *", "rm -rf /*"]
  }
}
```

`mode`: `"ask"` (confirm unmatched via dialog), `"allow-all"`, `"block-all"`. Extend the gate in `src/permission-gate.ts` for `write`/`edit` path rules.

## Security model

- Extensions are arbitrary code. Threads default to `trusted: false`: project `.pi` extensions are **not** loaded; only the built-in gate runs. Pass `trusted: true` per thread when the user has approved the project. Skills, prompt templates, and context files (AGENTS.md) are data and always load.
- Sessions persist under `~/.pi/agent/sessions/` (pi's standard layout), one file per thread.

## Reliability contract for clients

- Hub death: session files are durable; restart the hub and `thread/resume` each `{ sessionPath, cwd }`.
- Hub hang (sync code stuck): heartbeat stops; SIGKILL and recover as above.
- Client death: hub exits on stdin end (EOF) after flushing session files.

## Test

```bash
bun test/smoke.mjs
```

## Client integration

Full external interface guide — every command, frame type, the dialog
sub-protocol, and permission rules: **[docs/api.md](docs/api.md)**.

## Toolchain

Fully independent from the pi repo: bun (run/test/build), oxlint, oxfmt, TypeScript. `npm run ci` runs every gate (lint + format check + typecheck + build + unit + smoke). See AGENTS.md for the development rules.

## Known limitations / TODO

- `bun build --compile` single-binary distribution not yet wired (needs asset handling: photon wasm, themes; and a check that jiti user-extension loading works in a compiled binary).
- Under plain Bun, `console.log` from third-party code may bypass the `process.stdout.write` takeover (Bun fast path). Protocol frames always use the captured raw handle, so frames stay clean, but stray logs could still land on stdout — verify before depending on stdout purity under Bun; Node has no such gap.
- Login flow is out of scope: run `pi` once interactively to populate auth.
- Images in `prompt`/`steer` are passed through but untested.
