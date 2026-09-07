# pai-cli

Multi-session host for the pi coding agent: **a host process plus one worker process per conversation**, JSONL over stdio. The Electron (or any) client spawns this CLI and renders; worker crashes, hangs, and memory blowups are isolated per conversation.

```
Electron app                 pai-cli host                workers (1 per live conversation)
├── windows (render)  stdin→  route/auth/models   ──►    prompt/steer/bash/fork ...
└── dialogs/routing   stdout← response | event{threadId} | ui_request | heartbeat | thread_died
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

36 commands across ten groups — the canonical table with every field and
error wording is **[docs/api.md](docs/api.md)**; the highlights:

| Group                         | Commands                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Threads                       | `thread/start`, `thread/resume`, `thread/stop`, `thread/list`, `thread/list_saved`                                                   |
| Driving                       | `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `compact`                                                                    |
| State/history                 | `get_state`, `get_messages`, `get_entries`, `get_tree`, `get_session_stats`, `set_session_name`, `get_commands`, `get_fork_messages` |
| Tree/fork                     | `fork`, `clone`, `navigate_tree`                                                                                                     |
| Models                        | `get_models`, `set_model`, `set_thinking_level`, `get_thinking_levels`                                                               |
| Credentials                   | `auth/list`, `auth/set_api_key`, `auth/remove_key`                                                                                   |
| Direct exec                   | `bash`, `abort_bash`                                                                                                                 |
| Dialogs                       | `ui_response`                                                                                                                        |
| Per-thread permissions (v0.5) | `get_permission_rules`, `set_permission_rules`                                                                                       |
| Agents (v0.5)                 | `agents/list`, `subagent/steer`                                                                                                      |

### Frames (stdout)

- `response` `{ id?, command, success, data? | error }` — correlated by `id`; `prompt` responds at acceptance time (preflight), later failures ride the event stream
- `event` `{ threadId, event }` — every `AgentSessionEvent`, tagged; `message_update` frames strip cumulative snapshots (`message`, `partial`) so per-delta frame size stays constant
- `ui_request` `{ requestId, threadId, method, ... }` — `confirm`/`select`/`input`/`editor` need a `ui_response` with `{ confirmed }` / `{ value }` / `{ cancelled: true }`; `notify`/`setStatus` are fire-and-forget. Dialogs carry a timeout (see permission gate): on expiry the hub resolves the default (deny) itself, so an unattended client cannot block the agent. Requests relayed from a subagent carry `subagentId`/`agent`.
- `heartbeat` — 1 Hz (host); absence means the host is stuck (client should kill + `thread/resume` everything); carries `subagents` (in-flight count) while background tasks run
- `hub_error` — uncaught exception / rejection report; process stays alive (worker-origin errors carry a `threadId`)
- `thread_died` (v0.4) — `{threadId, reason}`: that conversation's worker died unexpectedly; the thread moves to `state:"dead"` and the next command transparently revives it (respawn + resume)
- `subagent_event` (v0.5) — `{threadId, subagentId, agent, task, event}`: a subagent's session events relayed verbatim, grouped by `subagentId` for task panels
- `subagent_message` (v0.5) — `{threadId, subagentId, agent, text, to?}`: a subagent's `report`/`send` output (`to` marks a sibling-routing request the lead mediates)

## Subagents & background tasks (v0.5)

The model-facing `task` tool delegates to agent definitions (`.md` files with
frontmatter; user-level always visible, project-level `.pi/agents` only for
`trusted` threads) by spawning one ephemeral grandchild worker per task —
depth 1, in-memory session, isolated context window. Foreground calls block
until done; `background:true` returns a receipt immediately and a
`[task-notification]` user-role message wakes the conversation when the task
settles (that turn costs tokens like any other). `task_out`/`task_wait`/
`task_stop` observe and control; `task_steer` injects guidance into a running
task; `task_send` relays to a running sibling (lead-mediated). Budgets:
<=8 tasks/call, <=4 concurrent grandchildren globally, <=8 in flight per
conversation, results retained <=16. `abort`/`thread/stop`/shutdown kill every
subagent of the conversation (foreground + background; no notification fires
for killed tasks). Grandchild permission checks re-read the parent
conversation's live ruleset on every call — tightening propagates instantly.

## Permissions (global + per-thread)

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

`mode`: `"ask"` (confirm unmatched via dialog), `"allow-all"`, `"block-all"`. The same gate covers `write`/`edit` path rules. Per-thread overrides (v0.5): `set_permission_rules {threadId, rules}` writes a sidecar file that wins over the global one until cleared with `rules:null`; fork/clone carries it to the new thread id; edits apply hot — every call re-reads, including inside running subagents.

## Security model

- Extensions are arbitrary code. Threads default to `trusted: false`: project `.pi` extensions are **not** loaded; only the built-in gate runs. Pass `trusted: true` per thread when the user has approved the project. Skills, prompt templates, and context files (AGENTS.md) are data and always load.
- Sessions persist under `~/.pi/agent/sessions/` (pi's standard layout), one file per thread.

## Reliability contract for clients

- Host death: session files are durable; restart the host and `thread/resume` each `{ sessionPath, cwd }`. Workers self-exit on host death (their stdin pipe closes).
- Host hang (sync code stuck): heartbeat stops; SIGKILL the host and recover as above.
- Worker crash or hang (one conversation): the host emits `thread_died`, that thread shows `state:"dead"` in `thread/list`, and its next command transparently revives it. Other conversations keep running.
- Idle retirement: workers idle for `PAI_IDLE_RETIRE_MS` (default 15 min) with a persisted session are retired to `state:"parked"` (zero resident memory); the next command transparently wakes them. Poll parked threads via `thread/list`, not `get_state`.
- Client death: host exits on stdin end (EOF) after flushing every session file.
- Concurrency cap: `PAI_MAX_THREADS` (default 32) live conversations.

## Test

```bash
npm run test          # unit + smoke (hermetic, no LLM)
npm run e2e           # full journey incl. worker kill/retire/orphan journeys (real LLM, .env)
npm run e2e:multi     # 4 concurrent conversations on the bundled artifact (real LLM)
npm run e2e:compile   # compiled single-binary smoke (real LLM)
```

## Client integration

Full external interface guide — every command, frame type, the dialog
sub-protocol, and permission rules: **[docs/api.md](docs/api.md)**.

## Toolchain

Fully independent from the pi repo: bun (run/test/build), oxlint, oxfmt, TypeScript. `npm run ci` runs every gate (lint + format check + typecheck + build + unit + smoke). See AGENTS.md for the development rules.

## Known limitations

- `bun build --compile` is smoke-tested end-to-end (`npm run e2e:compile`), but extension-heavy `trusted:true` projects that rely on runtime asset loading (photon wasm, themes) are not covered by that smoke.
- Under plain Bun, `console.log` from third-party code may bypass the `process.stdout.write` takeover (Bun fast path). Protocol frames always use the captured raw handle, so frames stay clean, but stray logs could still land on stdout — verify before depending on stdout purity under Bun; Node has no such gap.
- Login flow is out of scope: run `pi` once interactively to populate auth.
- Images in `prompt`/`steer` are passed through but untested.
