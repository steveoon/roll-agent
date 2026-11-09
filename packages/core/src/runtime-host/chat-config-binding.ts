import { resolve } from "node:path";
import { loadConfig } from "../config/loader.ts";
import {
  loadRuntimeConfig,
  resolveRuntimeConfigContext,
  type RuntimeConfigOptions,
} from "../config/runtime-context.ts";

/** Pin discovery once. A deleted selected source never falls back to another file. */
export function loadChatConfigBinding(options: RuntimeConfigOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const loaded = loadRuntimeConfig({ ...options, cwd });
  const explicit = resolveRuntimeConfigContext({ ...options, cwd });
  const configPath = loaded.configPath === undefined ? undefined : resolve(loaded.configPath);
  const context =
    explicit ??
    (configPath === undefined
      ? undefined
      : {
          version: 1 as const,
          configPath,
          configWorkspace: cwd,
        });
  return {
    ...loaded,
    configPath,
    context,
    read() {
      if (explicit !== undefined) return loadRuntimeConfig(explicit).config;
      if (configPath === undefined) {
        throw new Error("当前使用内置默认配置，没有可重新加载的配置文件");
      }
      return loadConfig({ configPath, cwd }).config;
    },
  };
}
