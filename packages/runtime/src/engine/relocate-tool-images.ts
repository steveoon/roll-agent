import type { ModelMessage } from "ai";

const RELOCATED_IMAGE_MARKER = "[图像内容已随后作为用户消息提供]";
const RELOCATED_IMAGE_PREFIX = "以下图像来自工具 ";
const DROPPED_IMAGE_MARKER = "[历史工具图像已省略]";
const MAX_RETAINED_IMAGE_MESSAGES = 2;
const RELOCATED_PROVIDER_NAMESPACE = "rollRuntime";
const RELOCATED_PROVIDER_KEY = "relocatedToolImages";

type ToolImageFilePart = {
  readonly type: "file";
  readonly data: { readonly type: "data"; readonly data: string };
  readonly mediaType: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolImageFilePart(value: unknown): value is ToolImageFilePart {
  if (!isRecord(value) || value["type"] !== "file") {
    return false;
  }
  const mediaType = value["mediaType"];
  if (typeof mediaType !== "string" || !mediaType.startsWith("image/")) {
    return false;
  }
  const data = value["data"];
  return isRecord(data) && data["type"] === "data" && typeof data["data"] === "string";
}

export function relocateToolImagesToUserMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    const collected: Array<{ readonly part: ToolImageFilePart; readonly toolName: string }> = [];
    const content = (message.content as readonly unknown[]).map((rawPart: unknown) => {
      if (!isRecord(rawPart) || rawPart["type"] !== "tool-result") {
        return rawPart;
      }
      const output = rawPart["output"];
      if (!isRecord(output) || output["type"] !== "content" || !Array.isArray(output["value"])) {
        return rawPart;
      }
      const kept: unknown[] = [];
      let extracted = 0;
      for (const value of output["value"] as readonly unknown[]) {
        if (isToolImageFilePart(value)) {
          collected.push({
            part: value,
            toolName: typeof rawPart["toolName"] === "string" ? rawPart["toolName"] : "tool",
          });
          extracted += 1;
        } else {
          kept.push(value);
        }
      }
      if (extracted === 0) {
        return rawPart;
      }
      kept.push({ type: "text", text: RELOCATED_IMAGE_MARKER });
      return { ...rawPart, output: { ...output, value: kept } };
    });

    out.push({ ...message, content } as unknown as ModelMessage);
    if (collected.length > 0) {
      const firstTool = collected[0]?.toolName ?? "tool";
      out.push({
        role: "user",
        content: [
          { type: "text", text: `${RELOCATED_IMAGE_PREFIX}${firstTool} 的返回结果：` },
          ...collected.map(({ part }) => ({
            type: "file" as const,
            data: part.data.data,
            mediaType: part.mediaType,
          })),
        ],
        providerOptions: { [RELOCATED_PROVIDER_NAMESPACE]: { [RELOCATED_PROVIDER_KEY]: true } },
      });
    }
  }
  return dropStaleRelocatedImages(out);
}

function isRelocatedImageUserMessage(message: ModelMessage): boolean {
  if (message.role !== "user") {
    return false;
  }
  const namespace = message.providerOptions?.[RELOCATED_PROVIDER_NAMESPACE];
  return isRecord(namespace) && namespace[RELOCATED_PROVIDER_KEY] === true;
}

function dropStaleRelocatedImages(messages: ModelMessage[]): ModelMessage[] {
  const relocatedIndexes = messages.flatMap((message, index) =>
    isRelocatedImageUserMessage(message) ? [index] : [],
  );
  const staleCount = relocatedIndexes.length - MAX_RETAINED_IMAGE_MESSAGES;
  if (staleCount <= 0) {
    return messages;
  }

  for (const index of relocatedIndexes.slice(0, staleCount)) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const parts = message.content as readonly unknown[];
    const kept = parts.filter((part) => !(isRecord(part) && part["type"] === "file"));
    if (kept.length === parts.length) {
      continue;
    }
    messages[index] = {
      ...message,
      content: [...kept, { type: "text", text: DROPPED_IMAGE_MARKER }],
    } as unknown as ModelMessage;
  }
  return messages;
}
