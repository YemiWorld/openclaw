# Local Patches

Custom patches applied on top of upstream openclaw. When merging upstream updates,
re-check these files for conflicts.

---

## 1. ACP Dynamic Model Selection

**Files:**

- `src/config/types.acp.ts` — added `defaultClaudeModel?: string` to `AcpConfig`
- `src/config/zod-schema.ts` — added `defaultClaudeModel` to acp zod schema
- `src/acp/control-plane/manager.types.ts` — added `model?: string` to `AcpInitializeSessionInput`
- `src/acp/control-plane/manager.core.ts` — resolve model from input or config default in `initializeSession`
- `src/acp/control-plane/runtime-options.ts` — removed `model` from `buildRuntimeConfigOptionPairs` (acpx `set model` command not supported; model is tracked in session meta but not applied via control command)
- `src/agents/acp-spawn.ts` — added `model?: string` to `SpawnAcpParams`, passed to `initializeSession`
- `src/agents/tools/sessions-spawn-tool.ts` — pass `modelOverride` through to `spawnAcpDirect`

**Config:** `~/.openclaw/openclaw.json` → `acp.defaultClaudeModel: "claude-sonnet-4-6"`

**Note:** `acpx set model` exits with code 1 (unsupported). Model is stored in session meta
only. Dynamic model selection via `sessions_spawn model=` is wired but has no runtime effect
until acpx supports the `set model` control command or a `--model` prompt flag is added.

---

## 2. Discord Text Attachment Inlining

**Files:**

- `src/auto-reply/media-note.ts` — added `inlineTextAttachments()` async function; reads
  text-based attachments (`.txt`, `.md`, `.json`, etc.) and inlines content into agent prompt
- `src/auto-reply/reply/get-reply-run.ts` — calls `inlineTextAttachments` before building
  prompt body; inlined text prepended to message so agent sees file contents
- `src/auto-reply/types.ts` — related type additions

---

## 3. Discord Messaging Improvements

**Files:**

- `src/discord/send.outbound.ts` — outbound send improvements
- `src/discord/send.shared.ts` — shared send utilities
- `src/discord/send.components.ts` — component helpers
- `src/discord/monitor/message-handler.process.ts` — added `maxDurationMs: 0` to typing
  indicator callback (disables 60s TTL timer that was causing blockage)
- `src/channels/plugins/outbound/direct-text-media.ts` — direct text/media send improvements
- `src/channels/plugins/outbound/discord.ts` — discord outbound plugin
- `src/channels/plugins/types.adapters.ts` — adapter type additions
- `src/channels/plugins/actions/discord/handle-action.ts` — discord action handler
- `src/agents/tools/discord-actions-messaging.ts` — discord actions messaging tool

---

## 4. ACP Turn Idle Timeout

**Files:**

- `extensions/acpx/src/config.ts` — added `turnIdleTimeoutSeconds?: number` to `AcpxPluginConfig` and `ResolvedAcpxPluginConfig`; validation, JSON schema, and resolution wired through
- `extensions/acpx/src/runtime.ts` — added output-idle kill timer in `runTurn`; resets on every stdout line; kills child process if silent for `turnIdleTimeoutSeconds`

**Config:** `~/.openclaw/openclaw.json` → `plugins.entries.acpx.config.turnIdleTimeoutSeconds: 1200` (20 min)

**Why:** Without this, if a Claude subprocess hangs mid-turn (e.g. a shell command that never returns), the `for await` readline loop on acpx stdout waits forever. The typing indicator keeps refreshing, the actor queue slot is held indefinitely, and all subsequent messages on that session are blocked.

---

## 5. Gateway Nested Lane Concurrency

**File:** `src/gateway/server-lanes.ts`

Added `setCommandLaneConcurrency(CommandLane.Nested, resolveSubagentMaxConcurrent(cfg))` so
the Nested command lane respects the configured subagent concurrency limit.

---

## Upstream Merge Strategy

```
git fetch upstream
git diff upstream/main..HEAD --name-only   # see what upstream changed
git merge upstream/main                    # or: git rebase upstream/main
# resolve conflicts in the patched files listed above
pnpm build
```

If upstream changes any patched file, check the diff carefully before accepting theirs.
