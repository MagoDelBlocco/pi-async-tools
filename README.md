# async-tools

Pi extension: asynchronous execution for tool calls. Long-running shell
commands no longer block the agent's turn — and the agent decides nothing.

## Design: automatic handoff only

A `bash` call always starts synchronously. If it has not finished after a
threshold (default 5000 ms), it is handed off to a background job:

1. The model receives a placeholder: *"Call moved to background as job-N …
   you may proceed with outstanding work that is NOT dependent on this call."*
2. The job keeps running detached from the turn's abort signal.
3. On completion the real result is delivered automatically:
   - **agent mid-run** → delivered as steering: after the current assistant
     turn's tool calls, before its next LLM call;
   - **agent idle** → delivered as a new turn, so no result is orphaned.

   The notification is a safety net, never a duplicate: if the model already
   consumed the result through `async_tools wait` (or ended it with `kill`),
   the delivery is claimed and no notice is injected. An abandoned wait
   (timeout or interruption) restores the automatic delivery. A failed
   `sendMessage` call is retried with backoff while the session remains open.

The model manages a job only when it chooses to, through two operations:
`wait` (block for the result) and `kill` (terminate it). There is no explicit
`async` argument anywhere: an earlier "Strategy A" was excised because it
burdens the model with an orchestration decision it should not own.

For extensions that track side effects, the handoff placeholder carries
`details.asyncJob.id`. Automatic completion arrives as a custom message with
`customType: "async-tools:job-result"` and `details.jobId`; a claimed result
returned by `async_tools wait` or `kill` carries `details.asyncJobCompletion`
with the job id and final state. Timeout and interrupted waits carry no
completion marker.

## Scope: bash only — MCP calls remain synchronous

The extension introduces **no new tool names** beyond `async_tools`:

- `bash` is overridden **under its existing name** — the model's tool list is
  otherwise untouched. Built-in implementation and renderers are preserved
  verbatim via `createBashToolDefinition()`.
- **MCP server tool calls remain synchronous (blocking).** A transparent
  all-tools interceptor is not achievable with the Pi extension API (see
  limitations), and no delegation tool is introduced to work around it.

## What it adds

| Surface | Purpose |
|---|---|
| `bash` (override, same name) | Built-in bash with automatic handoff. |
| `async_tools` | Minimal job control — exactly two actions: `wait` (block until a job settles, return its full result; capped at 300 s, abort-aware) and `kill` (terminate a running job). |
| `/async_jobs` | Human-facing job overview (list with status, elapsed time, results). |
| Footer status item | `async: N running` badge, **green** while jobs run — same liturgy as `guardrails: active` / `oculus: clean`: `ui.setStatus("async", ui.theme.bg("toolSuccessBg", ui.theme.fg("success", label)))`. Hidden (`setStatus(key, undefined)`) when nothing runs; plain label on unthemed UIs. Reads the job registry at render time (single source of truth); repaints on every settle via the registry's observer channel (independent of the notification path, so a fast synchronous call cannot leave a stale "1 running"), on spawn, and on `async_tools` actions. No below-editor widget — one compact slot like the sibling extensions. |

Flags:

- `--async-tools-timeout <ms>` — handoff threshold, default `5000`.
- `--no-async-bash` — keep the built-in bash tool untouched.

## Behavior summary

| Call | Finishes ≤ threshold | Exceeds threshold |
|---|---|---|
| top-level bash | real result returned **unchanged** (default stays synchronous; no job, no notice) | handoff: placeholder now, real result steered in on completion |
| nested call (`ctx.executeTool` from another tool, detected via `parentToolCallId`) | real result | always waits for the real result — the caller would consume a placeholder as truth |
| MCP tools / all other tools | unchanged (synchronous) | unchanged (synchronous) |

Abort semantics: while the model waits synchronously, the call is tied to the
turn's abort signal (Escape cancels it). At handoff the job detaches and
survives turn aborts — that is the point of backgrounding; kill explicitly
via `async_tools`. `session_shutdown` cancels all jobs.

Delivery nuances: Pi's default steering mode is `one-at-a-time` — with
several queued steering messages, one is delivered per completed assistant
turn. Results are never fabricated or previewed: the model only ever sees
the real, final result.

## API limitations encountered (tool interception & async handling)

1. **`ExtensionContext` (event handlers) has no `executeTool`.** Only
   `ExtensionToolContext` (a tool's `execute()`) can run other tools. A
   `tool_call` handler that blocks a call therefore cannot re-run the work
   itself — blocking with a reason only discards the call.
2. **Validation precedes interception.** Model-issued calls are validated
   against the tool's parameter schema before `tool_call` handlers see them;
   handlers may mutate validated input but cannot rescue arguments the schema
   rejects. Argument-driven async control therefore requires schema changes on
   a registered tool.
3. **No detach point for in-flight calls.** `tool_execution_update` carries
   partial results but cannot finalize a call; `tool_result` fires only after
   the promise settles. The only way to answer the model earlier than the
   work finishes is for the tool itself to return early while keeping the
   promise. Hence the handoff lives in tool `execute()`.
4. **The generic middleware exists but is spoken for.** `pi-agent-core`
   offers `beforeToolCall`/`afterToolCall` for all calls, but AgentSession
   wires them internally to the `tool_call`/`tool_result` events
   (`agent-session.js:323-324`), and `beforeToolCall` can only block, never
   substitute a result. Extensions cannot install their own.
5. **No transparent path to MCP tools.** Same-name override requires
   reconstructing the implementation: built-ins are all constructible via
   SDK exports, MCP tools are not (`ToolInfo` exposes no `execute`,
   `outputSchema`, or renderers; `ctx.executeTool` on a wrapper name
   self-resolves; first-registration-per-name wins across extensions, and
   MCP tool names are unknown until servers connect). Covering MCP would
   require duplicating server connections or an explicit delegation tool —
   both rejected to keep the tool list untouched. MCP stays synchronous.
6. **`onUpdate` after settle is ignored by Pi** (documented behavior). A
   handed-off bash call stops live-streaming at handoff; background jobs
   render no partial output, only the final result.
7. **Results cannot be rewritten retroactively.** An async result delivered
   later is necessarily a *new* message (`pi.sendMessage`), so context grows
   by one message per completed job (content truncated to 6 KB) — unless the
   model consumed it directly via `async_tools wait`/`kill`, which claims the
   delivery and suppresses the notice. `wait` returns the stored tool result,
   including its original output, error flag, and structured content.
8. **Steering boundaries are Pi's, not the extension's.** A steered result
   lands after the current tool batch; if the agent finishes before the job
   settles, delivery falls back to a new triggered turn.
9. **Job state is in-memory only.** Reload, session switch, or fork loses
   the registry view (processes may keep running; shutdown cancels them).
10. **Placeholder results lack `structuredContent`.** The bash tool declares
    an `outputSchema` for programmatic callers (codemode); a handoff
    placeholder cannot carry the command's final structured output. Scripts
    needing structured output should poll `async_tools wait`.

## Files

- `index.ts` — entry point: flags, registration, nested-call tracking, lifecycle.
- `engine.ts` — managed execution: spawn, threshold race, signal linking, handoff placeholder, steered notification injection, footer status item (guardrails/oculus styling).
- `jobs.ts` — dependency-free job registry (spawn/settle/cancel/notify, `onObserve` lifecycle channel, `awaitWithHandoff`).
- `util.ts` — flag parsing, abort-aware race.
- `tools/async-bash.ts` — `bash` override.
- `tools/job-control.ts` — `async_tools` (`wait` / `kill` only).
- `test/engine.test.mjs` — engine unit trials (pure Node).
- `test/loader.test.mjs` — loads `index.ts` against a simulated ExtensionAPI and drives real bash execution, guards, kill, and the footer status badge.
- `test/comprehensive.test.mjs` — full battery: S1 `jobs.ts` unit (registry, transitions, notifications, observers, formatters), S2 `util.ts` unit, S3 `engine.ts` unit (handoff race, nested mode, signal linking/detach, delivery modes, footer status styling + stale-status regression), S4 integration (registration, bash override incl. exit codes and `timeout`, `wait`/`kill` matrix, `/async_jobs`, status lifecycle, nested-call tracking, shutdown, flag effects, concurrency, abort-during-wait).

## Verification

```bash
node test/engine.test.mjs         # 8 engine trials
node test/loader.test.mjs         # 6 integration trials
node test/comprehensive.test.mjs  # 50 trials (unit + integration + edge cases)

# Live rites (run from a clean directory without local .pi state):
pi --extension ./index.ts --async-tools-timeout 1200 -p 'long bash + independent calls + wait/kill'
pi --extension ./index.ts --no-async-bash -p 'echo TOKEN'   # untouched bash
```

## Usage examples

```
# Model calls bash normally; slow commands background themselves:
bash { "command": "cargo build --release" }
→ "Call moved to background as job-1 ... proceed with outstanding work
   that is NOT dependent on this call ..."
→ (later, between tool calls) "[async-tools] Background job job-1 completed
   (bash: cargo build --release, 184.2s)." + full output

# Need the result in this turn:
async_tools { "action": "wait", "job": "job-1", "timeout": 120 }

# Wrong turn — end the work:
async_tools { "action": "kill", job: "job-1" }

# Human: /async_jobs
```
