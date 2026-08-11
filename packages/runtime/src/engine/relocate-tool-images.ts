import type { ModelMessage } from "ai";

const RELOCATED_IMAGE_MARKER = "[图像内容已随后作为用户消息提供]";

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
          { type: "text", text: `以下图像来自工具 ${firstTool} 的返回结果：` },
          ...collected.map(({ part }) => ({
            type: "file" as const,
            data: part.data.data,
            mediaType: part.mediaType,
          })),
        ],
      });
    }
  }
  return out;
}
