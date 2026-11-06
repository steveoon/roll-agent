import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { expandTilde, loadConfig, type LoadConfigOptions } from "./loader.ts";

const absolutePath = z.string().min(1).refine(isAbsolute, "Expected an absolute path");
/** Path references only: never persist effective configuration or credentials. */
export const runtimeConfigContextSchema = z
  .object({
    version: z.literal(1),
    configPath: absolutePath,
    configWorkspace: absolutePath,
  })
  .strict();
export type RuntimeConfigContext = z.infer<typeof runtimeConfigContextSchema>;
export type RuntimeConfigOptions = LoadConfigOptions & { readonly configWorkspace?: string };

export function resolveRuntimeConfigContext(
  options: RuntimeConfigOptions = {},
): RuntimeConfigContext | undefined {
  if (options.configPath === undefined && options.configWorkspace === undefined) return undefined;
  if (options.configPath === undefined || options.configPath.trim().length === 0) {
    throw new Error("Explicit config must be a nonempty file path");
  }
  if (
    options.configWorkspace !== undefined &&
    (!isAbsolute(options.configWorkspace) || !isAbsolute(options.configPath))
  ) {
    throw new Error("An absolute config and config-workspace are required together");
  }
  const configWorkspace = resolve(options.configWorkspace ?? options.cwd ?? process.cwd());
  try {
    if (!statSync(configWorkspace).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Configuration workspace must be an existing directory: ${configWorkspace}`);
  }
  return runtimeConfigContextSchema.parse({
    version: 1,
    configPath: resolve(options.cwd ?? process.cwd(), expandTilde(options.configPath)),
    configWorkspace,
  });
}

/** Opt-in resource projection. Ordinary CLI discovery and execution cwd remain unchanged. */
export function loadRuntimeConfig(
  options: RuntimeConfigOptions = {},
): ReturnType<typeof loadConfig> {
  const context = resolveRuntimeConfigContext(options);
  if (context === undefined) return loadConfig(options);
  const source = statSync(context.configPath, { throwIfNoEntry: false });
  if (source === undefined) throw new Error(`Config file not found: ${context.configPath}`);
  if (!source.isFile()) {
    throw new Error(`Config source must be a regular file: ${context.configPath}`);
  }
  const loaded = loadConfig({ configPath: context.configPath });
  const { config } = loaded;
  const path = (value: string): string => resolve(context.configWorkspace, expandTilde(value));
  return {
    ...loaded,
    config: {
      ...config,
      agents: { ...config.agents, dataDir: path(config.agents.dataDir) },
      runtime: { ...config.runtime, threadsDir: path(config.runtime.threadsDir) },
      skills: { ...config.skills, dirs: config.skills.dirs.map(path) },
      chat: {
        ...config.chat,
        instructions: ["auto", "off"].includes(config.chat.instructions)
          ? config.chat.instructions
          : path(config.chat.instructions),
      },
      browser: {
        ...config.browser,
        instances: Object.fromEntries(
          Object.entries(config.browser.instances).map(([id, instance]) => [
            id,
            {
              ...instance,
              ...(instance.executablePath === undefined
                ? {}
                : { executablePath: path(instance.executablePath) }),
              userDataDir: path(instance.userDataDir),
              ...(instance.sessionsDir === undefined
                ? {}
                : { sessionsDir: path(instance.sessionsDir) }),
            },
          ]),
        ),
      },
    },
  };
}
