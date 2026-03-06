import { chunkText } from "../../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.js";

type DirectSendOptions = {
  accountId?: string | null;
  replyToId?: string | null;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  buffer?: Buffer | string;
  contentType?: string;
  filename?: string;
};

type DirectSendResult = { messageId: string; [key: string]: unknown };

type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (
  to: string,
  text: string,
  opts: TOpts,
) => Promise<TResult>;

type SendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
type SendPayloadResult = Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>;
type SendPayloadAdapter = Pick<
  ChannelOutboundAdapter,
  "sendMedia" | "sendText" | "chunker" | "textChunkLimit"
>;

export async function sendTextMediaPayload(params: {
  channel: string;
  ctx: SendPayloadContext;
  adapter: SendPayloadAdapter;
}): Promise<SendPayloadResult> {
  const text = params.ctx.payload.text ?? "";
  const urls = params.ctx.payload.mediaUrls?.length
    ? params.ctx.payload.mediaUrls
    : params.ctx.payload.mediaUrl
      ? [params.ctx.payload.mediaUrl]
      : [];
  // Check for buffer-based attachment (buffer + contentType + filename)
  const buffer = params.ctx.payload.buffer;
  const contentType = params.ctx.payload.contentType;
  const filename = params.ctx.payload.filename;
  const hasBuffer =
    typeof buffer === "string" &&
    buffer.length > 0 &&
    typeof contentType === "string" &&
    contentType.length > 0;
  if (!text && urls.length === 0 && !hasBuffer) {
    return { channel: params.channel, messageId: "" };
  }
  // Handle buffer-based media upload if available
  if (hasBuffer) {
    const bufferData = Buffer.from(buffer, "base64");
    return await params.adapter.sendMedia!({
      ...params.ctx,
      text,
      mediaUrl: "", // Empty since we're using buffer
      buffer: bufferData,
      contentType,
      filename: filename ?? "attachment",
    });
  }
  if (urls.length > 0) {
    let lastResult = await params.adapter.sendMedia!({
      ...params.ctx,
      text,
      mediaUrl: urls[0],
    });
    for (let i = 1; i < urls.length; i++) {
      lastResult = await params.adapter.sendMedia!({
        ...params.ctx,
        text: "",
        mediaUrl: urls[i],
      });
    }
    return lastResult;
  }
  const limit = params.adapter.textChunkLimit;
  const chunks = limit && params.adapter.chunker ? params.adapter.chunker(text, limit) : [text];
  let lastResult: Awaited<ReturnType<NonNullable<typeof params.adapter.sendText>>>;
  for (const chunk of chunks) {
    lastResult = await params.adapter.sendText!({ ...params.ctx, text: chunk });
  }
  return lastResult!;
}

export function resolveScopedChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
}): number | undefined {
  return resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: params.resolveChannelLimitMb,
    accountId: params.accountId,
  });
}

export function createScopedChannelMediaMaxBytesResolver(channel: "imessage" | "signal") {
  return (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveScopedChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.[channel]?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.[channel]?.mediaMaxMb,
    });
}

export function createDirectTextMediaOutbound<
  TOpts extends Record<string, unknown>,
  TResult extends DirectSendResult,
>(params: {
  channel: "imessage" | "signal";
  resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
  resolveMaxBytes: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => number | undefined;
  buildTextOptions: (params: DirectSendOptions) => TOpts;
  buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter {
  const sendDirect = async (sendParams: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    deps?: OutboundSendDeps;
    replyToId?: string | null;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    buffer?: Buffer | string;
    contentType?: string;
    filename?: string;
    buildOptions: (params: DirectSendOptions) => TOpts;
  }) => {
    const send = params.resolveSender(sendParams.deps);
    const maxBytes = params.resolveMaxBytes({
      cfg: sendParams.cfg,
      accountId: sendParams.accountId,
    });
    const result = await send(
      sendParams.to,
      sendParams.text,
      sendParams.buildOptions({
        mediaUrl: sendParams.mediaUrl,
        mediaLocalRoots: sendParams.mediaLocalRoots,
        accountId: sendParams.accountId,
        replyToId: sendParams.replyToId,
        maxBytes,
        buffer: sendParams.buffer,
        contentType: sendParams.contentType,
        filename: sendParams.filename,
      }),
    );
    return { channel: params.channel, ...result };
  };

  const outbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendPayload: async (ctx) =>
      await sendTextMediaPayload({ channel: params.channel, ctx, adapter: outbound }),
    sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
      return await sendDirect({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        buildOptions: params.buildTextOptions,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      buffer,
      contentType,
      filename,
    }) => {
      return await sendDirect({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        buffer,
        contentType,
        filename,
        buildOptions: params.buildMediaOptions,
      });
    },
  };
  return outbound;
}
