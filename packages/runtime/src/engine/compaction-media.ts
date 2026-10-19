import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

/** A summary-only descriptor, not a replacement for durable media or a visual observation. */
function omittedMedia(value: string | Uint8Array | ArrayBuffer) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return {
    omitted: "inline media not inspected by the summary model",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength,
    encoding: typeof bytes === "string" ? "source-string-utf8" : "bytes",
  };
}

function projectMediaData(value: unknown): unknown {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return omittedMedia(value);
  if (value instanceof URL) {
    return value.protocol === "data:" ? omittedMedia(value.href) : value;
  }
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? value : omittedMedia(value);
  }
  // AI SDK tagged file data: keep text and provider references verbatim.
  if (typeof value === "object" && value !== null && "type" in value) {
    if (value.type === "data" && "data" in value) {
      return { ...value, data: projectMediaData(value.data) };
    }
    if (value.type === "url" && "url" in value) {
      return { ...value, url: projectMediaData(value.url) };
    }
  }
  return value;
}

/**
 * Traverse SDK content boundaries only. Never recursively strip media-shaped objects
 * from tool arguments or JSON results: they may be ordinary business data.
 * The projection is for summary JSON, not a valid replacement ModelMessage history.
 */
export function projectSummaryMedia(messages: readonly ModelMessage[]): readonly unknown[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "image") return { ...part, image: projectMediaData(part.image) };
        if (part.type === "file" || part.type === "reasoning-file") {
          return { ...part, data: projectMediaData(part.data) };
        }
        if (part.type !== "tool-result" || part.output.type !== "content") return part;
        return {
          ...part,
          output: {
            ...part.output,
            value: part.output.value.map((item) => {
              if (item.type === "file" || item.type === "file-data" || item.type === "image-data") {
                return { ...item, data: projectMediaData(item.data) };
              }
              if (item.type === "file-url" || item.type === "image-url") {
                return { ...item, url: projectMediaData(item.url) };
              }
              return item;
            }),
          },
        };
      }),
    };
  });
}
