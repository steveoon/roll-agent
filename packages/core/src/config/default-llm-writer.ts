import {
  ConfigApplicationService,
  createConfigPatches,
  type ConfigApplicationServiceOptions,
} from "./application-service.ts";

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function writeDefaultLlm(
  choice: { readonly provider: string; readonly model: string },
  options: ConfigApplicationServiceOptions = {},
): { readonly configPath: string } {
  const service = new ConfigApplicationService(options);
  const snapshot = service.readForRepair();
  const current = snapshot.persisted;
  const llm = isPlainRecord(current.llm) ? current.llm : {};
  const next = {
    ...current,
    llm: { ...llm, defaultProvider: choice.provider, defaultModel: choice.model },
  };
  service.savePatches(createConfigPatches(current, next), snapshot.revision);
  return { configPath: snapshot.configPath };
}
