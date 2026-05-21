import { defineCommand } from "citty";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { loadConfig } from "../../config/loader.ts";
import { getAgentPid } from "../../registry/process-manager.ts";
import { log } from "../utils/output.ts";
import type { BrowserConfig } from "../../config/schema.ts";

const BROWSER_USE_AGENT_NAME = "browser-use-agent";
const DEFAULT_BROWSER_SESSIONS_ROOT = join(homedir(), ".roll-agent", "browser", "sessions");
const BROWSER_DATA_KINDS = ["profiles", "sessions"] as const;

type BrowserDataKind = (typeof BROWSER_DATA_KINDS)[number];

export interface BrowserDataClearTarget {
  readonly instanceId: string;
  readonly kind: BrowserDataKind;
  readonly path: string;
  readonly exists: boolean;
}

export interface BrowserDataClearResult extends BrowserDataClearTarget {
  readonly status: "deleted" | "missing" | "skipped" | "failed";
  readonly message?: string;
}

interface BrowserDataClearOptions {
  readonly instanceId?: string;
  readonly kinds: readonly BrowserDataKind[];
}

interface BrowserDataClearSafetyOptions {
  readonly protectedSubtreeRoots?: readonly string[];
}

export default defineCommand({
  meta: { description: "清理 browser.instances 声明的 Chrome profile / Roll session 数据" },
  args: {
    instance: {
      type: "positional",
      description: "可选 browserInstance；不传则处理所有已声明实例",
      required: false,
    },
    profiles: {
      type: "boolean",
      description: "只清理 Chrome profile 目录（browser.instances[*].user-data-dir）",
      default: false,
    },
    sessions: {
      type: "boolean",
      description: "只清理 Roll session 快照目录（browser.instances[*].sessions-dir）",
      default: false,
    },
    all: {
      type: "boolean",
      description: "清理 profile + sessions；未指定 --profiles/--sessions 时默认就是 all",
      default: false,
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "确认执行删除；不加时只输出 dry-run 计划",
      default: false,
    },
    force: {
      type: "boolean",
      description: "browser-use-agent 仍在运行时也继续删除（不建议）",
      default: false,
    },
    json: {
      type: "boolean",
      description: "JSON 格式输出",
      default: false,
    },
  },
  async run({ args }) {
    try {
      const { config } = loadConfig();
      const instanceId = parseOptionalStringArgument(args.instance, "instance");
      const kinds = resolveBrowserDataKinds({
        all: args.all === true,
        profiles: args.profiles === true,
        sessions: args.sessions === true,
      });
      const targets = buildBrowserDataClearPlan(config.browser, {
        ...(instanceId !== undefined ? { instanceId } : {}),
        kinds,
      });
      const shouldDelete = args.yes === true;

      if (shouldDelete) {
        const pid = getAgentPid(config.agents.dataDir, BROWSER_USE_AGENT_NAME);
        if (pid !== undefined && args.force !== true) {
          const message =
            `${BROWSER_USE_AGENT_NAME} 仍在运行 (PID: ${String(pid)})，` +
            "请先运行 `roll agent stop browser-use-agent`，或确认风险后加 --force";
          if (args.json) {
            console.log(JSON.stringify({ ok: false, message, targets }, null, 2));
          } else {
            log.error(message);
          }
          process.exitCode = 1;
          return;
        }

        const results = clearBrowserDataTargets(targets, {
          protectedSubtreeRoots: [config.agents.dataDir],
        });
        if (args.json) {
          console.log(
            JSON.stringify(
              { ok: results.every((result) => result.status !== "failed"), results },
              null,
              2,
            ),
          );
        } else {
          printBrowserDataClearResults(results);
        }
        if (results.some((result) => result.status === "failed")) {
          process.exitCode = 1;
        }
        return;
      }

      if (args.json) {
        console.log(JSON.stringify({ dryRun: true, targets }, null, 2));
      } else {
        printBrowserDataClearPlan(targets);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) {
        console.log(JSON.stringify({ ok: false, message }, null, 2));
      } else {
        log.error(message);
      }
      process.exitCode = 1;
    }
  },
});

export function resolveBrowserDataKinds(input: {
  readonly all: boolean;
  readonly profiles: boolean;
  readonly sessions: boolean;
}): readonly BrowserDataKind[] {
  if (input.all || (!input.profiles && !input.sessions)) {
    return BROWSER_DATA_KINDS;
  }

  return [
    ...(input.profiles ? (["profiles"] as const) : []),
    ...(input.sessions ? (["sessions"] as const) : []),
  ];
}

export function buildBrowserDataClearPlan(
  browserConfig: BrowserConfig,
  options: BrowserDataClearOptions,
): readonly BrowserDataClearTarget[] {
  const instanceEntries = Object.entries(browserConfig.instances);
  if (instanceEntries.length === 0) {
    return [];
  }

  const selectedEntries = selectBrowserInstances(browserConfig, options.instanceId);
  return selectedEntries.flatMap(([instanceId, instance]) => {
    const targets: BrowserDataClearTarget[] = [];
    if (options.kinds.includes("profiles")) {
      targets.push(createClearTarget(instanceId, "profiles", instance.userDataDir));
    }
    if (options.kinds.includes("sessions")) {
      targets.push(
        createClearTarget(
          instanceId,
          "sessions",
          instance.sessionsDir ?? join(DEFAULT_BROWSER_SESSIONS_ROOT, instanceId),
        ),
      );
    }
    return targets;
  });
}

export function clearBrowserDataTargets(
  targets: readonly BrowserDataClearTarget[],
  options: BrowserDataClearSafetyOptions = {},
): readonly BrowserDataClearResult[] {
  const deletedPaths = new Set<string>();

  return targets.map((target) => {
    try {
      assertSafeBrowserDataPath(target.path, options);
      if (deletedPaths.has(target.path)) {
        return {
          ...target,
          status: "skipped",
          message: "同一路径已在本次命令中处理",
        };
      }
      deletedPaths.add(target.path);

      if (!existsSync(target.path)) {
        return { ...target, status: "missing" };
      }

      const stat = lstatSync(target.path);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(`拒绝删除非目录路径: ${target.path}`);
      }

      rmSync(target.path, { recursive: true, force: true });
      return { ...target, exists: false, status: "deleted" };
    } catch (error) {
      return {
        ...target,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function assertSafeBrowserDataPath(
  path: string,
  options: BrowserDataClearSafetyOptions = {},
): void {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const rollRoot = resolve(homedir(), ".roll-agent");
  const browserRoot = resolve(rollRoot, "browser");
  const protectedContainerPaths = [
    root,
    resolve(homedir()),
    resolve(process.cwd()),
    rollRoot,
    browserRoot,
    resolve(browserRoot, "profiles"),
    resolve(browserRoot, "sessions"),
  ];

  for (const protectedPath of protectedContainerPaths) {
    if (isSameOrAncestor(normalized, protectedPath)) {
      throw new Error(`拒绝删除危险路径: ${normalized}`);
    }
  }

  for (const protectedRoot of options.protectedSubtreeRoots ?? []) {
    if (isSameOrInside(normalized, resolve(protectedRoot))) {
      throw new Error(`拒绝删除受保护数据目录下的路径: ${normalized}`);
    }
  }
}

function isSameOrAncestor(candidate: string, target: string): boolean {
  return isSameOrInside(target, candidate);
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function selectBrowserInstances(
  browserConfig: BrowserConfig,
  instanceId: string | undefined,
): ReadonlyArray<readonly [string, BrowserConfig["instances"][string]]> {
  if (instanceId === undefined) {
    return Object.entries(browserConfig.instances);
  }

  const instance = browserConfig.instances[instanceId];
  if (instance === undefined) {
    const available = Object.keys(browserConfig.instances);
    throw new Error(
      `browserInstance "${instanceId}" 未声明` +
        (available.length > 0 ? `；可用实例: ${available.join(", ")}` : ""),
    );
  }

  return [[instanceId, instance]];
}

function createClearTarget(
  instanceId: string,
  kind: BrowserDataKind,
  rawPath: string,
): BrowserDataClearTarget {
  const path = resolve(rawPath);
  return {
    instanceId,
    kind,
    path,
    exists: existsSync(path),
  };
}

function parseOptionalStringArgument(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} 必须是字符串`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function printBrowserDataClearPlan(targets: readonly BrowserDataClearTarget[]): void {
  if (targets.length === 0) {
    log.warn("未配置 browser.instances，没有可清理的 browser 数据目录。");
    return;
  }

  log.info("Browser data clear plan (dry-run, 未删除任何文件):");
  for (const target of targets) {
    log.info(formatTargetLine(target));
  }
  log.info("确认无误后追加 --yes 执行删除；运行中的 browser-use-agent 建议先 stop。");
}

function printBrowserDataClearResults(results: readonly BrowserDataClearResult[]): void {
  if (results.length === 0) {
    log.warn("未配置 browser.instances，没有可清理的 browser 数据目录。");
    return;
  }

  for (const result of results) {
    const line = `${formatTargetLine(result)} -> ${result.status}${
      result.message !== undefined ? ` (${result.message})` : ""
    }`;
    if (result.status === "failed") {
      log.error(line);
    } else {
      log.info(line);
    }
  }

  const failedCount = results.filter((result) => result.status === "failed").length;
  if (failedCount === 0) {
    log.success("Browser 数据清理完成。");
  }
}

function formatTargetLine(target: BrowserDataClearTarget): string {
  return `${target.instanceId} ${target.kind}: ${target.path} [${
    target.exists ? "exists" : "missing"
  }]`;
}
