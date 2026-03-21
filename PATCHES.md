# Local Patches

Custom patches applied on top of upstream openclaw. When merging upstream updates,
re-check these files for conflicts and re-apply any that are clobbered.

**Last fully audited against:** `upstream/main` @ v2026.3.12 (merged 2026-03-12)
**Next merge target:** upstream HEAD post-2026.3.12

---

## Patch 1 — ACP Model Selection — DROPPED (2026-03-12)

**Status:** Dropped. Use native `/acp model <id>` or `~/.claude/settings.json` instead.

**Root cause:** `~/.claude/settings.json` had `"model": "sonnet"` which claude-agent-acp reads
at session init (`getAvailableModels` → `query.setModel`) and overrides ANY model set via
`_meta.claudeCode.options.model`. Removing that key fixed the issue. No code patches needed.

**Important:** `~/.claude/settings.json` must NOT contain a `"model"` key — it overrides all
per-session model selection.

---

## Patch 2 — Discord Text Attachment Inlining

**Purpose:** When an inbound Discord message has a text-based file attachment (`.txt`, `.md`,
`.json`, `.py`, etc.), automatically read the file from disk and prepend its contents into the
agent prompt so agents see the actual text rather than just a file path.

**Files:**

| File                                    | Change                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `src/auto-reply/media-note.ts`          | Added `inlineTextAttachments()` async function + helpers (~110 lines)  |
| `src/auto-reply/reply/get-reply-run.ts` | Call `inlineTextAttachments` before building prompt body               |
| `src/auto-reply/types.ts`               | Added `MediaPaths?: string[]`, `MediaTypes?: string[]` to `MsgContext` |

**Key snippet — `media-note.ts`:**

```typescript
const TEXT_INLINE_CONTENT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/css",
  "text/xml",
  "text/javascript",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/yaml",
  "application/x-yaml",
]);
const TEXT_INLINE_EXTENSIONS = new Set([
  ".txt",
  ".csv",
  ".md",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".sh",
  ".bash",
  ".log",
  ".ini",
  ".toml",
  ".cfg",
  ".conf",
  ".env",
  ".sql",
  ".graphql",
  ".svg",
]);
const TEXT_INLINE_MAX_CHARS = 50_000;

export async function inlineTextAttachments(ctx: MsgContext): Promise<string | undefined> {
  // reads ctx.MediaPaths or ctx.MediaPath
  // checks content type or extension for text types
  // reads each file (fs/promises), truncates at 50k chars
  // returns formatted blocks with filename headers
}
```

**Key snippet — `get-reply-run.ts`:**

```typescript
const inlineAttachmentText = await inlineTextAttachments(msgCtx);
if (inlineAttachmentText) {
  promptBody = inlineAttachmentText + "\n\n" + promptBody;
}
```

**Merge risk (2026.3.8):** HIGH — upstream removed our entire `inlineTextAttachments` from
`media-note.ts` (reduced to 2-line stub). `get-reply-run.ts` and `types.ts` also changed.
Must re-add the function and its call site after merge.

---

## Patch 3 — Discord Messaging Improvements

**Purpose:** Multiple enhancements to Discord outbound messaging:

1. **Typing indicator fix** — disabled the 60-second TTL timer causing delivery blockage
   (`maxDurationMs: 0` on the typing callback)
2. **Buffer-based attachment uploads** — agents can upload binary data (base64 buffer +
   contentType + filename) directly without needing a public URL
3. **Enhanced discord-actions tool** — poll options, voice/silent flags, reaction management,
   channel history listing, voice message support, buffer upload support

**Files:**

| File                                                    | Change                                                  |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `src/discord/monitor/message-handler.process.ts`        | `maxDurationMs: 0` on typing indicator                  |
| `src/discord/send.outbound.ts`                          | Outbound send improvements                              |
| `src/discord/send.shared.ts`                            | Shared send utilities                                   |
| `src/discord/send.components.ts`                        | Component helpers                                       |
| `src/channels/plugins/outbound/direct-text-media.ts`    | Buffer-based upload support                             |
| `src/channels/plugins/outbound/discord.ts`              | Discord outbound plugin                                 |
| `src/channels/plugins/types.adapters.ts`                | Added `buffer?`, `contentType?`, `filename?` to adapter |
| `src/channels/plugins/actions/discord/handle-action.ts` | Handle-action improvements                              |
| `src/agents/tools/discord-actions-messaging.ts`         | Extended discord messaging tools                        |

**Key snippet — `message-handler.process.ts` (most critical):**

```typescript
// maxDurationMs: 0 disables the 60s TTL that was blocking delivery
typingIndicator.start({ maxDurationMs: 0 });
```

**Key snippet — `types.adapters.ts` additions:**

```typescript
// In ChannelOutboundAdapter sendMedia params:
buffer?: Buffer | string;
contentType?: string;
filename?: string;
```

**Merge risk (2026.3.8):** HIGH — all discord send files and `message-handler.process.ts`
changed upstream. The `maxDurationMs: 0` single-line fix is the most critical to preserve.

---

## Patch 4 — ACP Turn Idle Timeout

**Purpose:** Kill hung acpx turns (Claude subprocess silent for N seconds) so the actor
queue slot is not held indefinitely. Without this, a stuck shell command blocks all subsequent
messages on that ACP session forever.

**Files:**

| File                             | Change                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `extensions/acpx/src/config.ts`  | Added `turnIdleTimeoutSeconds?: number` to types, validation, JSON schema            |
| `extensions/acpx/src/runtime.ts` | Output-idle kill timer in `runTurn`; resets on stdout; kills after N seconds silence |

**Key snippet — `runtime.ts` idle kill timer (insert inside `runTurn`):**

```typescript
let lastOutputAt = Date.now();
let idleKillTimer: ReturnType<typeof setInterval> | null = null;
const turnIdleTimeoutMs =
  this.config.turnIdleTimeoutSeconds != null && this.config.turnIdleTimeoutSeconds > 0
    ? this.config.turnIdleTimeoutSeconds * 1000
    : null;
if (turnIdleTimeoutMs != null) {
  const checkIntervalMs = Math.min(turnIdleTimeoutMs, 30_000);
  idleKillTimer = setInterval(() => {
    if (Date.now() - lastOutputAt >= turnIdleTimeoutMs) {
      child.kill();
    }
  }, checkIntervalMs);
}
// In the stdout readline `for await` loop, add:
lastOutputAt = Date.now();
// In finally block, add:
if (idleKillTimer != null) clearInterval(idleKillTimer);
```

**Key snippet — `config.ts` additions (add alongside upstream `mcpServers`):**

```typescript
// In AcpxPluginConfig and ResolvedAcpxPluginConfig:
turnIdleTimeoutSeconds?: number;

// In parseAcpxPluginConfig allowed keys:
"turnIdleTimeoutSeconds",

// In parseAcpxPluginConfig validation:
const turnIdleTimeoutSeconds = value.turnIdleTimeoutSeconds;
if (turnIdleTimeoutSeconds !== undefined && (
  typeof turnIdleTimeoutSeconds !== "number" ||
  !Number.isFinite(turnIdleTimeoutSeconds) ||
  turnIdleTimeoutSeconds <= 0
)) {
  return { ok: false, message: "turnIdleTimeoutSeconds must be a positive number" };
}

// In createAcpxPluginConfigSchema JSON schema:
turnIdleTimeoutSeconds: { type: "number", minimum: 1 },
```

**Config:** `~/.openclaw/openclaw.json`:

```json
"plugins": { "entries": { "acpx": { "config": { "turnIdleTimeoutSeconds": 1200 } } } }
```

**Merge risk (2026.3.8):** CRITICAL — upstream replaced `turnIdleTimeoutSeconds` with a new
`mcpServers` feature. Both `config.ts` and `runtime.ts` were substantially refactored. Must
re-add `turnIdleTimeoutSeconds` alongside the new `mcpServers` block after merge.

**Note on new upstream `mcpServers` feature:** Allows injecting MCP servers (e.g.
`sequential-thinking`) directly into acpx sessions via plugin config. Keep this — it's additive
and very useful. Our `turnIdleTimeoutSeconds` is orthogonal and must be re-added alongside it.

---

## Patch 5 — Gateway Nested Lane Concurrency

**Purpose:** The `Nested` command lane (sub-agents) was not respecting the configured subagent
concurrency limit. This wires the config through so sub-agents obey `agents.defaults.maxConcurrent`.

**File:** `src/gateway/server-lanes.ts`

**Key snippet (one line, add after other `setCommandLaneConcurrency` calls):**

```typescript
setCommandLaneConcurrency(CommandLane.Nested, resolveSubagentMaxConcurrent(cfg));
```

**Merge risk (2026.3.8):** MEDIUM — `server-lanes.ts` changed upstream. Verify the line
survives or re-add it.

---

## Patch 6 — Judah Dispatch Channel Plugin (UNTRACKED — NOT YET COMMITTED)

**Purpose:** Custom outbound-only channel plugin for agent-to-agent messaging via the
`judah-dispatch` stack. Agents send messages to other agents via POST `/dm-send`.

**Status:** File exists at `src/channels/plugins/outbound/dispatch.ts` but has never been
committed to git. Must be committed after merge (no conflict risk).

**File:** `src/channels/plugins/outbound/dispatch.ts` (117 lines)

**Design:**

- Outbound-only (`deliveryMode: "direct"`) — no gateway adapter
- Inbound DMs arrive via api.js WS bridge → openclaw gateway HTTP/WS API (Telegram pattern)
- Env vars: `DISPATCH_API_URL` (default `http://127.0.0.1:3010`), `DISPATCH_AGENT_ID`
- `sendText` and `sendMedia` via `POST /dm-send`
- Plugin ID: `"dispatch"`, label: `"Judah Dispatch"`
- Export: `dispatchChannelPlugin`

**Merge risk:** NONE (untracked file, no conflict possible — just commit after merge).

---

## Upstream Merge Conflict Resolution Guide

### For each conflicted file:

**`extensions/acpx/src/config.ts`**
Accept upstream's full rewrite (keep `mcpServers`). Then add `turnIdleTimeoutSeconds`
alongside `mcpServers` in all four places: type definition, validation, allowed keys, JSON schema.

**`extensions/acpx/src/runtime.ts`**
Accept upstream's refactored `runTurn`. Find the `for await` stdout readline loop, insert
the idle kill timer block around it (see Patch 4 snippet).

**`src/acp/control-plane/manager.core.ts`**
Accept upstream's `initializeSession` refactor. Find `validateRuntimeOptionPatch({ cwd: ... })`,
replace with the 4-line model-resolution snippet (see Patch 1 snippet).

**`src/auto-reply/media-note.ts`**
Accept upstream's file as-is, then append the full `inlineTextAttachments` function + constants.
Re-export the function.

**`src/auto-reply/reply/get-reply-run.ts`**
Accept upstream's version, locate prompt body assembly, re-insert the `inlineTextAttachments`
call (see Patch 2 snippet).

**`src/discord/monitor/message-handler.process.ts`**
Accept upstream's version. Find `DISCORD_TYPING_MAX_DURATION_MS` and set to `240 * 60_000` (Patch 3). Find the typing indicator start call, ensure `maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS`.

**`src/gateway/server-lanes.ts`**
Accept upstream's version, verify `CommandLane.Nested` concurrency line is present.

### Commands

```bash
git checkout -b backup/pre-upstream-merge
git checkout main
git merge upstream/main
# resolve conflicts per guide above
pnpm build
openclaw doctor
```

---

## Patch 7 — Discord Typing Indicator Duration (4 hours)

**Purpose:** ACP turns can run 1.5–2+ hours. The upstream constant `DISCORD_TYPING_MAX_DURATION_MS = 20 * 60_000`
(20 minutes) stops the typing indicator mid-turn, making the bot appear dead to the user.
The typing indicator is the only visual signal that a session is alive and working.

**Files:**

| File                                                | Change                                   |
| --------------------------------------------------- | ---------------------------------------- |
| `src/discord/monitor/message-handler.process.ts:61` | `20 * 60_000` → `240 * 60_000` (4 hours) |

**Code:**

```typescript
// line 61
const DISCORD_TYPING_MAX_DURATION_MS = 240 * 60_000; // 4 hours — supports long-running ACP turns
```

**Merge risk:** LOW — single constant change, easy to reapply.

---

## Patch 8 — Discord Gateway Connect Stagger

**Purpose:** With 19+ Discord bots all connecting simultaneously on startup, Discord's IDENTIFY
rate limit (1/5s) causes exponential backoff — resulting in 40-minute reconnect delays and
event loop pressure that causes `Unknown interaction` errors (code 10062, >3s response time).
Staggering connections 6s apart keeps each IDENTIFY within rate limits.

**Account priority** is determined by the order of `channels.discord.accounts` in `openclaw.json`.
Accounts listed first connect first (no delay). Reorder to prioritize critical bots.

**Files:**

| File                                         | Change                                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| `src/channels/plugins/types.adapters.ts:281` | Add `connectStaggerMs?: number` to `ChannelGatewayAdapter`      |
| `extensions/discord/src/channel.ts:416`      | Set `connectStaggerMs: 6_000` on gateway object                 |
| `src/gateway/server-channels.ts:168`         | Apply `idx * connectStaggerMs` delay before each `startAccount` |

**Code (server-channels.ts):**

```typescript
const connectStaggerMs = plugin.gateway?.connectStaggerMs ?? 0;
await Promise.all(
  accountIds.map(async (id, idx) => {
    if (connectStaggerMs > 0 && idx > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, idx * connectStaggerMs));
    }
    // ... existing per-account logic
```

**Merge risk:** LOW — additive change to adapter type + one line per file.

---

## Patch 9 — Uncaught Exception Guard for Carbon Gateway

**Purpose:** Carbon's `GatewayPlugin.handleReconnectionAttempt` throws `Error("Max reconnect attempts")`
directly instead of emitting it as an event. Openclaw's lifecycle code expects this as an emitted event.
The uncaught throw hits the process-level handler which calls `process.exit(1)`, crashing the entire
gateway and all 19+ Discord bots when a single bot's WebSocket closes during shutdown/restart.

**Files:**

| File                     | Change                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/cli/run-main.ts:99` | Catch "Max reconnect attempts" in uncaughtException handler, log as warning instead of exiting |

**Merge risk:** LOW — additive guard, does not change normal exit behavior.

---

## Patch 10 — Uncaught Exception Guard (Gateway Entry Point)

**Purpose:** Patch 9 only covered `src/cli/run-main.ts` (CLI entry). The gateway uses
`src/index.ts` as its entry point, which has its own `uncaughtException` handler without the
Carbon crash guard. During SIGINT shutdown, Carbon throws "Max reconnect attempts" uncaught,
hitting the bare handler and calling `process.exit(1)` — crashing the entire gateway.

**Files:**

| File              | Change                                                             |
| ----------------- | ------------------------------------------------------------------ |
| `src/index.ts:84` | Same "Max reconnect attempts" guard as Patch 9, applied to gateway |

**Merge risk:** LOW — same pattern as Patch 9.

---

## Patch 11 — Typing Controller Idle TTL (4 hours)

**Purpose:** The auto-reply typing controller (`src/auto-reply/reply/typing.ts`) has its own
idle TTL separate from `DISCORD_TYPING_MAX_DURATION_MS` (Patch 7). The default is 2 minutes —
if no new output refreshes it within 2 minutes, typing stops. For ACP turns where agents think
or wait for sub-agents for extended periods with no stdout, typing dies at 2 minutes regardless
of Patch 7's 4-hour ceiling.

**Files:**

| File                                | Change                                  |
| ----------------------------------- | --------------------------------------- |
| `src/auto-reply/reply/typing.ts:28` | `2 * 60_000` → `240 * 60_000` (4 hours) |

**Code:**

```typescript
// line 28
typingTtlMs = 240 * 60_000, // 4 hours — supports long-running ACP turns with idle periods
```

**Merge risk:** LOW — single default value change.

---

## Patch 12 — Strip CLAUDECODE Env Var for ACP Agent Spawning

**Purpose:** When openclaw runs inside a Claude Code session (e.g. during development/admin),
the `CLAUDECODE=1` env var is inherited by the gateway process. This propagates through
acpx → claude-agent-acp → Claude CLI, which detects it and refuses to start with
"cannot be launched inside another Claude Code session". This makes all ACP sessions fail
silently with `ACP_SESSION_INIT_FAILED` / "Query closed before response received".

**Files:**

| File                                                       | Change                                              |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `src/index.ts:4`                                           | `delete process.env.CLAUDECODE` at gateway startup  |
| `src/cli/run-main.ts:4`                                    | `delete process.env.CLAUDECODE` at CLI startup      |
| `extensions/acpx/src/runtime-internals/process.ts:142-148` | Always strip `CLAUDECODE` from acpx child spawn env |

**Merge risk:** LOW — additive, no conflict with upstream.

---

## Patch 13 — Node.js Version Guard Lowered

**Purpose:** Upstream 2026.3.11 requires Node >=22.16.0. Local server runs Node 22.13.1.
Lowered the hard guard to allow startup.

**Files:**

| File                            | Change                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `src/infra/runtime-guard.ts:12` | `{ major: 22, minor: 16, patch: 0 }` → `{ major: 22, minor: 13, patch: 0 }` |

**Note:** Should upgrade Node to 22.16+ eventually and remove this patch.

**Merge risk:** LOW — single constant, will be clobbered on every upstream merge.

---

## Patch 14 — DROPPED (2026-03-12)

Consolidated into Patch 1, which is itself DROPPED. No model patches remain.

---

## Patch 15 — Per-Agent Model Selection via CLAUDE_CONFIG_DIR

**Purpose:** ACP agents `claude` and `claude-opus` must run different Claude models (Sonnet vs
Opus). `settings.json` `"model"` key overrides all other model selection (including
`_meta.claudeCode.options.model` and `/acp model`), so runtime model switching is ineffective.
Solution: spawn `claude-opus` agent with `CLAUDE_CONFIG_DIR` pointing to a separate config
directory (`~/.claude-opus/`) containing its own `settings.json` with `"model": "opus"`.

**Files:**

| File                                                       | Change                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `extensions/acpx/src/runtime.ts`                           | `resolveAgentExtraEnv()` method + threaded through all 8 spawn sites |
| `extensions/acpx/src/runtime-internals/process.ts:129-153` | `extraEnv?: Record<string,string>` param on spawn functions          |

**Config files (outside repo):**

| File                               | Content                               |
| ---------------------------------- | ------------------------------------- |
| `~/.claude/settings.json`          | `"model": "sonnet"` (default)         |
| `~/.claude-opus/settings.json`     | `"model": "opus"`                     |
| `~/.claude-opus/.credentials.json` | Copy of `~/.claude/.credentials.json` |

**Key snippet — `runtime.ts`:**

```typescript
private resolveAgentExtraEnv(agent: string): Record<string, string> | undefined {
  if (agent === "claude-opus") {
    return { CLAUDE_CONFIG_DIR: pathJoin(homedir(), ".claude-opus") };
  }
  return undefined;
}
```

**Key snippet — `process.ts` (`spawnWithResolvedCommand`):**

```typescript
if (params.extraEnv) {
  for (const [key, value] of Object.entries(params.extraEnv)) {
    childEnv[key] = value;
  }
}
```

**How it works:** `claude-agent-acp` reads `CLAUDE_CONFIG_DIR` (line 11 of `acp-agent.js`) to
locate `settings.json` and `.credentials.json`. By redirecting `claude-opus` to `~/.claude-opus/`,
it picks up `"model": "opus"` while `claude` uses the default `~/.claude/` with `"model": "sonnet"`.

**Merge risk:** LOW — additive `extraEnv` parameter + small method, no conflict with upstream.

---

## Patch 16 — openviking-claw Context Engine Bridge Plugin (2026-03-20)

**Purpose:** Connect openclaw's pluggable `contextEngine` slot to OpenViking's persistent semantic
memory HTTP API (port 1933). Replaces lossless-claw as the active context engine.

**Status:** ACTIVE — gateway starts clean, contextEngine slot set to `"openviking"`.

**Files:**

| File                                                          | Change                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `~/.openclaw/extensions/openviking-claw/dist/index.js`        | Plugin implementation — ContextEngine bridge                                             |
| `~/.openclaw/extensions/openviking-claw/package.json`         | Package manifest (ESM, type: module)                                                     |
| `~/.openclaw/extensions/openviking-claw/openclaw.plugin.json` | Plugin config schema                                                                     |
| `~/.openclaw/openclaw.json`                                   | `plugins.allow` + `plugins.slots.contextEngine` + `plugins.entries` + `plugins.installs` |

**What the plugin does:**

- `bootstrap`: GET `/api/v1/sessions/{id}` — creates session via POST if 404
- `ingest`: POST `/api/v1/sessions/{id}/messages` — sends each message to OpenViking
- `assemble`: POST `/api/v1/search/find` — retrieves top-K relevant memories, prepends as `systemPromptAddition`
- `compact`: POST `/api/v1/sessions/{id}/extract` then `/commit` — extracts and commits memories

**Graceful fallback:** All operations are wrapped in try/catch. If OpenViking is unreachable (ECONNREFUSED or timeout), all methods return safe no-op values — openclaw continues normally.

**openclaw.json changes:**

```json
"plugins.allow": [..., "openviking-claw"],
"plugins.slots.contextEngine": "openviking",
"plugins.entries.openviking-claw": { "enabled": true, "config": { "serviceUrl": "http://127.0.0.1:1933", "topK": 8, "fallbackOnError": true } },
"plugins.installs.openviking-claw": { "source": "path", "installPath": "C:\\Users\\Administrator\\.openclaw\\extensions\\openviking-claw" }
```

**Engine ID:** `"openviking"` (registered via `api.registerContextEngine("openviking", ...)`)

**Merge risk:** NONE — entirely external plugin + config file edit only. No openclaw source code modified.

---

## Patch 17 — Sub-agent Source Tagging (2026-03-21)

**Purpose:** Sub-agent completion messages arrive as `role: "user"` and are indistinguishable from
human messages at the model API level. The internal `inputProvenance` metadata is never visible to
the model. This causes the model to confuse sub-agent status updates with human input, leading to
ignored human messages. Solution: prepend visible `[FROM: ...]` source tags to message content.

**Files:**

| File                                      | Change                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/subagent-announce.ts`         | `formatUntrustedChildResult()` and `buildDescendantWakeMessage()` prepend `[FROM: SUB-AGENT {sessionKey} — THIS IS NOT HUMAN INPUT]`         |
| `src/agents/internal-events.ts`           | `formatTaskCompletionEvent()` prepends the same sub-agent source tag                                                                         |
| `src/agents/pi-embedded-runner/google.ts` | Added `annotateHumanUserMessages()` — tags user messages with `[FROM: HUMAN USER]`; called from `sanitizeSessionHistory()` for all providers |

**Key details:**

- `<<<UNTRUSTED>>>` markers preserved for backward compat — `[FROM:]` tags are added above them
- `annotateHumanUserMessages()` runs for ALL providers (called from `sanitizeSessionHistory()`)
- Only modifies model-facing transcript at send time, not stored session data
- Idempotent: checks for existing prefix before prepending

**Merge risk:** LOW — additive text annotation changes only. No structural modifications.

---

## Patch 18 — Dispatch Bootstrap Path (2026-03-21)

**Purpose:** Load per-agent context files from judah-dispatch `nodes/` directories into
openclaw's bootstrap pipeline. Each agent's `dispatchDir` contains custom identity (SPOOL.md),
memory, and context files that get injected into the system prompt alongside or overriding
workspace bootstrap files.

**Config field:** `dispatchDir` on `AgentEntrySchema` — optional path to a dispatch node dir.

**File mapping:**

| Dispatch File | Maps To     | Behavior                     |
| ------------- | ----------- | ---------------------------- |
| `SPOOL.md`    | `SOUL.md`   | Replaces workspace SOUL.md   |
| `user.md`     | `USER.md`   | Replaces workspace USER.md   |
| `MEMORY.md`   | `MEMORY.md` | Replaces workspace MEMORY.md |

**Extra context (injected via `extraSystemPrompt`):**

| File                  | Header                  |
| --------------------- | ----------------------- |
| `evergreen_memory.md` | `[EVERGREEN MEMORY]`    |
| `living_memory.md`    | `[LIVING MEMORY]`       |
| `command_que.md`      | `[COMMAND QUEUE]`       |
| `cabinet/*.md`        | `[CABINET: {filename}]` |

**Files:**

| File                                           | Change                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/config/zod-schema.agent-runtime.ts`       | Added `dispatchDir` to `AgentEntrySchema`                                           |
| `src/agents/agent-scope.ts`                    | Added `dispatchDir` to `ResolvedAgentConfig`, added `resolveAgentDispatchDir()`     |
| `src/agents/workspace.ts`                      | Added `loadDispatchBootstrapFiles()`, `buildDispatchExtraContextString()`           |
| `src/agents/bootstrap-files.ts`                | Wired dispatch into `resolveBootstrapFilesForRun` / `resolveBootstrapContextForRun` |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Resolve dispatchDir, pass to bootstrap, merge with extraSystemPrompt                |
| `src/agents/bootstrap-files.test.ts`           | Updated for new return type                                                         |

**Merge risk:** LOW — all changes are additive. No behavior change when `dispatchDir` is unset.
