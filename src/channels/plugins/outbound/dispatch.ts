// dispatch.ts — OpenClaw channel plugin for Judah Dispatch comms
//
// OUTBOUND ONLY — sends agent messages to other agents via POST /dm-send
// Inbound DMs are handled by api.js's WS bridge → openclaw gateway HTTP/WS API
// (same pattern as Telegram: external webhook → gateway, not plugin → internals)

import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { ChannelOutboundAdapter } from "../types.js";
import type { ChannelPlugin } from "../types.plugin.js";

const _log = createSubsystemLogger("channel/dispatch");

// ── Configuration ─────────────────────────────────────────
const DISPATCH_API_URL = process.env.DISPATCH_API_URL || "http://127.0.0.1:3010";
const DISPATCH_AGENT_ID =
  process.env.DISPATCH_AGENT_ID || process.env.OPENCLAW_AGENT_ID || process.env.AGENT_ID || "";

// ── Agent IDs from openclaw config ────────────────────────
function getAgentIdsFromConfig(cfg?: unknown): string[] {
  const root = cfg as Record<string, unknown> | undefined;
  const agents = root?.agents as { list?: Array<{ id?: string }> } | undefined;
  if (agents?.list?.length) {
    return agents.list.map((a) => a.id).filter((id): id is string => Boolean(id));
  }
  return [];
}

// ── Outbound: POST to /dm-send ────────────────────────────
async function postDmSend(params: {
  from: string;
  to: string;
  content: string;
  autoRoute?: boolean;
}): Promise<{ ok: boolean; channelId: string; ts: number; messageId?: string }> {
  const url = `${DISPATCH_API_URL}/dm-send`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`dispatch dm-send failed (${res.status}): ${body}`);
  }
  return (await res.json()) as { ok: boolean; channelId: string; ts: number; messageId?: string };
}

function resolveFrom(accountId?: string | null): string {
  return accountId || DISPATCH_AGENT_ID || "dispatch";
}

const dispatchOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,

  sendText: async ({ to, text, accountId }) => {
    const from = resolveFrom(accountId);
    const result = await postDmSend({ from, to, content: text });
    return {
      channel: "dispatch" as const,
      messageId: result.messageId || `${result.channelId}:${result.ts}`,
      chatId: result.channelId,
    };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    const from = resolveFrom(accountId);
    const content = mediaUrl ? `${text}\n\n📎 ${mediaUrl}` : text;
    const result = await postDmSend({ from, to, content });
    return {
      channel: "dispatch" as const,
      messageId: result.messageId || `${result.channelId}:${result.ts}`,
      chatId: result.channelId,
    };
  },
};

// ── Channel Plugin Definition ─────────────────────────────
// Outbound only — no gateway adapter. Inbound handled by api.js WS bridge.
export const dispatchChannelPlugin: ChannelPlugin<string> = {
  id: "dispatch",
  meta: {
    id: "dispatch",
    label: "Judah Dispatch",
    selectionLabel: "Dispatch (Agent-to-Agent)",
    docsPath: "dispatch",
    blurb: "Agent-to-agent messaging via Judah Dispatch comms",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    threads: false,
    polls: false,
  },
  config: {
    listAccountIds: (cfg) => {
      if (DISPATCH_AGENT_ID) {
        return [DISPATCH_AGENT_ID];
      }
      const ids = getAgentIdsFromConfig(cfg);
      if (ids.length) {
        return ids;
      }
      return ["default"];
    },
    resolveAccount: (_cfg, accountId) => {
      return accountId || DISPATCH_AGENT_ID || "default";
    },
    isConfigured: () => true,
    isEnabled: () => true,
  },
  outbound: dispatchOutbound,
  // No gateway adapter — inbound DMs arrive via api.js WS bridge → gateway HTTP/WS API
};
