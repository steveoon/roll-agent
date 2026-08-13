import type { ToolSet } from "ai";
import type { ToolRegistry } from "../naming.ts";
import type { ToolBridgeContext } from "../build-tools.ts";
import { FileStateTracker } from "./file-state-tracker.ts";
import { resolveFileToolsSettings, type SessionFileToolsSettings } from "./settings.ts";
import { buildReadFileTool } from "./read-file-tool.ts";
import { buildListDirTool } from "./list-dir-tool.ts";
import { buildEditFileTool } from "./edit-file-tool.ts";
import { buildWriteFileTool } from "./write-file-tool.ts";

export type { SessionFileToolsSettings } from "./settings.ts";
export { READ_FILE_TOOL_NAME } from "./read-file-tool.ts";
export { LIST_DIR_TOOL_NAME } from "./list-dir-tool.ts";
export { EDIT_FILE_TOOL_NAME } from "./edit-file-tool.ts";
export { WRITE_FILE_TOOL_NAME } from "./write-file-tool.ts";

export interface BuiltFileToolset {
  readonly readTools: ToolSet;
  readonly editTools: ToolSet;
}

export function buildFileToolset(
  settings: SessionFileToolsSettings,
  registry: ToolRegistry,
  ctx: ToolBridgeContext,
): BuiltFileToolset {
  const resolved = resolveFileToolsSettings(settings);
  const tracker = new FileStateTracker();
  return {
    readTools: {
      ...buildReadFileTool(resolved, tracker, registry, ctx),
      ...buildListDirTool(resolved, registry, ctx),
    },
    editTools: {
      ...buildEditFileTool(resolved, tracker, registry, ctx),
      ...buildWriteFileTool(resolved, tracker, registry, ctx),
    },
  };
}
