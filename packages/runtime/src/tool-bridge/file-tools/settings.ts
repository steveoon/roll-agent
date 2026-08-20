export const FILE_TOOLS_AGENT_NAME = "roll";

export interface SessionFileToolsSettings {
  readonly workdir: string;
  readonly maxFileBytes?: number;
  readonly maxImageFileBytes?: number;
  readonly maxOutputChars?: number;
}

export interface ResolvedFileToolsSettings {
  readonly workdir: string;
  readonly maxFileBytes: number;
  readonly maxImageFileBytes: number;
  readonly maxOutputChars: number;
}

export function resolveFileToolsSettings(
  input: SessionFileToolsSettings,
): ResolvedFileToolsSettings {
  return {
    workdir: input.workdir,
    maxFileBytes: input.maxFileBytes ?? 2 * 1024 * 1024,
    maxImageFileBytes: input.maxImageFileBytes ?? 5 * 1024 * 1024,
    maxOutputChars: input.maxOutputChars ?? 40_000,
  };
}
