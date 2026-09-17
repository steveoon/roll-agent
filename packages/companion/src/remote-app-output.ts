import { jsonValueSchema, type JsonValue } from "@roll-agent/protocol";

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    typeof value === "object" && value !== null && value !== undefined && !Array.isArray(value)
  );
}

/** Producer metadata is never a grant: recompute host authorization for every query. */
export async function projectRemoteAppOutputCapabilities(
  value: unknown,
  supported: boolean,
  policy: (agentName: string, toolName: string) => boolean | Promise<boolean>,
): Promise<unknown> {
  const result = jsonValueSchema.parse(value);
  if (!isObject(result) || !isObject(result.manifest)) return result;
  const manifest = result.manifest;
  if (!isObject(manifest)) return result;
  const tools = manifest.tools;
  if (!Array.isArray(tools)) {
    return { ...result, manifest: { ...manifest, appOutput: { supported } } };
  }
  const projected = await Promise.all(
    tools.map(async (tool) => {
      if (!isObject(tool) || !isObject(tool.appOutput)) return tool;
      const declaration = tool.appOutput;
      if (!isObject(declaration)) return tool;
      let granted = false;
      if (
        supported &&
        declaration.remoteReadable === true &&
        typeof tool.agentName === "string" &&
        typeof tool.toolName === "string"
      ) {
        try {
          granted = await policy(tool.agentName, tool.toolName);
        } catch {
          /* deny */
        }
      }
      return { ...tool, appOutput: { ...declaration, remoteReadable: granted } };
    }),
  );
  return { ...result, manifest: { ...manifest, tools: projected, appOutput: { supported } } };
}
