import fs from "node:fs/promises";
import type { MsgContext } from "./templating.js";

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

/** Maximum chars to inline per text attachment. */
const TEXT_INLINE_MAX_CHARS = 50_000;

function isTextContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return TEXT_INLINE_CONTENT_TYPES.has(base) || base.startsWith("text/");
}

function isTextExtension(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? TEXT_INLINE_EXTENSIONS.has(ext) : false;
}

/**
 * For text-based inbound attachments, reads file content and returns inline
 * blocks so agents see the actual text rather than just a file path.
 */
export async function inlineTextAttachments(ctx: MsgContext): Promise<string | undefined> {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return undefined;
  }

  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;

  const blocks: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const filePath = paths[i] ?? "";
    if (!filePath) {
      continue;
    }
    const contentType = types?.[i] ?? ctx.MediaType;
    if (!isTextContentType(contentType) && !isTextExtension(filePath)) {
      continue;
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const trimmed =
        content.length > TEXT_INLINE_MAX_CHARS
          ? content.slice(0, TEXT_INLINE_MAX_CHARS) + "\n... (truncated)"
          : content;
      const filename = filePath.split(/[/\\]/).pop() ?? "file";
      blocks.push(`[attached file: ${filename}]\n${trimmed}\n[/attached file]`);
    } catch {
      // File unreadable — fall through to normal media note path
    }
  }

  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function formatMediaAttachedLine(params: {
  path: string;
  url?: string;
  type?: string;
  index?: number;
  total?: number;
}): string {
  const prefix =
    typeof params.index === "number" && typeof params.total === "number"
      ? `[media attached ${params.index}/${params.total}: `
      : "[media attached: ";
  const typePart = params.type?.trim() ? ` (${params.type.trim()})` : "";
  const urlRaw = params.url?.trim();
  const urlPart = urlRaw ? ` | ${urlRaw}` : "";
  return `${prefix}${params.path}${typePart}${urlPart}]`;
}

// Common audio file extensions for transcription detection
const AUDIO_EXTENSIONS = new Set([
  ".ogg",
  ".opus",
  ".mp3",
  ".m4a",
  ".wav",
  ".webm",
  ".flac",
  ".aac",
  ".wma",
  ".aiff",
  ".alac",
  ".oga",
]);

function isAudioPath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  const lower = path.toLowerCase();
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

export function buildInboundMediaNote(ctx: MsgContext): string | undefined {
  // Attachment indices follow MediaPaths/MediaUrls ordering as supplied by the channel.
  const suppressed = new Set<number>();
  const transcribedAudioIndices = new Set<number>();
  if (Array.isArray(ctx.MediaUnderstanding)) {
    for (const output of ctx.MediaUnderstanding) {
      suppressed.add(output.attachmentIndex);
      if (output.kind === "audio.transcription") {
        transcribedAudioIndices.add(output.attachmentIndex);
      }
    }
  }
  if (Array.isArray(ctx.MediaUnderstandingDecisions)) {
    for (const decision of ctx.MediaUnderstandingDecisions) {
      if (decision.outcome !== "success") {
        continue;
      }
      for (const attachment of decision.attachments) {
        if (attachment.chosen?.outcome === "success") {
          suppressed.add(attachment.attachmentIndex);
          if (decision.capability === "audio") {
            transcribedAudioIndices.add(attachment.attachmentIndex);
          }
        }
      }
    }
  }
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : ctx.MediaPath?.trim()
        ? [ctx.MediaPath.trim()]
        : [];
  if (paths.length === 0) {
    return undefined;
  }

  const urls =
    Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length === paths.length
      ? ctx.MediaUrls
      : undefined;
  const types =
    Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length === paths.length
      ? ctx.MediaTypes
      : undefined;
  const hasTranscript = Boolean(ctx.Transcript?.trim());
  // Transcript alone does not identify an attachment index; only use it as a fallback
  // when there is a single attachment to avoid stripping unrelated audio files.
  const canStripSingleAttachmentByTranscript = hasTranscript && paths.length === 1;

  const entries = paths
    .map((entry, index) => ({
      path: entry ?? "",
      type: types?.[index] ?? ctx.MediaType,
      url: urls?.[index] ?? ctx.MediaUrl,
      index,
    }))
    .filter((entry) => {
      if (suppressed.has(entry.index)) {
        return false;
      }
      // Strip audio attachments when transcription succeeded - the transcript is already
      // available in the context, raw audio binary would only waste tokens (issue #4197)
      // Note: Only trust MIME type from per-entry types array, not fallback ctx.MediaType
      // which could misclassify non-audio attachments (greptile review feedback)
      const hasPerEntryType = types !== undefined;
      const isAudioByMime = hasPerEntryType && entry.type?.toLowerCase().startsWith("audio/");
      const isAudioEntry = isAudioPath(entry.path) || isAudioByMime;
      if (!isAudioEntry) {
        return true;
      }
      if (
        transcribedAudioIndices.has(entry.index) ||
        (canStripSingleAttachmentByTranscript && entry.index === 0)
      ) {
        return false;
      }
      return true;
    });
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    return formatMediaAttachedLine({
      path: entries[0]?.path ?? "",
      type: entries[0]?.type,
      url: entries[0]?.url,
    });
  }

  const count = entries.length;
  const lines: string[] = [`[media attached: ${count} files]`];
  for (const [idx, entry] of entries.entries()) {
    lines.push(
      formatMediaAttachedLine({
        path: entry.path,
        index: idx + 1,
        total: count,
        type: entry.type,
        url: entry.url,
      }),
    );
  }
  return lines.join("\n");
}
