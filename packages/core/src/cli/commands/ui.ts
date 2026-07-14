import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { resolveConfigPath } from "../../config/loader.ts";
import {
  createFileSystemStaticAssetProvider,
  createRollUiRuntimeController,
  startRollUiServer,
  type RollUiServerHandle,
} from "../../ui/index.ts";
import { log } from "../utils/output.ts";

interface RunRollUiOptions {
  readonly configPath?: string;
  readonly open: boolean;
}

interface RunRollUiDependencies {
  readonly assetsDirectory?: string;
  readonly openExternalUrl?: (url: string) => Promise<void>;
  readonly waitForShutdown?: () => Promise<NodeJS.Signals>;
}

interface ExternalOpenCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export default defineCommand({
  meta: { description: "启动本地 Web 配置台" },
  args: {
    config: {
      type: "string",
      description: "配置文件路径（默认按 roll.config.yaml 发现链查找）",
      required: false,
    },
    open: {
      type: "boolean",
      description: "自动在默认浏览器打开（可用 --no-open 跳过）",
      default: true,
    },
  },
  async run({ args }) {
    try {
      await runRollUi({
        ...(args.config !== undefined ? { configPath: args.config } : {}),
        open: args.open,
      });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },
});

export async function runRollUi(
  options: RunRollUiOptions,
  dependencies: RunRollUiDependencies = {},
): Promise<void> {
  const configPath = resolveRollUiConfigPath(options.configPath);
  const assetsDirectory = dependencies.assetsDirectory ?? resolveRollUiAssetsDirectory();
  assertRollUiAssetsAvailable(assetsDirectory);

  const server = await startRollUiServer({
    controller: createRollUiRuntimeController({ configPath }),
    staticAssets: createFileSystemStaticAssetProvider(assetsDirectory),
    onError: (error) => {
      log.error(`配置台请求失败：${error instanceof Error ? error.message : String(error)}`);
    },
  });

  try {
    log.info(`配置文件：${configPath}`);
    await presentLaunchUrl(server, options.open, dependencies.openExternalUrl ?? openExternalUrl);
    log.info("配置台仅监听 127.0.0.1；按 Ctrl+C 停止。");
    await (dependencies.waitForShutdown ?? waitForShutdownSignal)();
  } finally {
    await server.close();
    log.success("Roll 配置台已停止。");
  }
}

export function resolveRollUiConfigPath(explicitPath?: string): string {
  const discovered = resolveConfigPath({
    ...(explicitPath !== undefined ? { configPath: explicitPath } : {}),
  });
  return resolve(discovered ?? resolve(homedir(), "roll.config.yaml"));
}

export function resolveRollUiAssetsDirectory(moduleUrl = import.meta.url): string {
  const commandDirectory = dirname(fileURLToPath(moduleUrl));
  return moduleUrl.endsWith(".ts")
    ? resolve(commandDirectory, "../../../dist/ui-assets")
    : resolve(commandDirectory, "../../ui-assets");
}

export function getExternalOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): ExternalOpenCommand {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

async function presentLaunchUrl(
  server: RollUiServerHandle,
  shouldOpen: boolean,
  openUrl: (url: string) => Promise<void>,
): Promise<void> {
  if (shouldOpen) {
    try {
      await openUrl(server.url);
      log.success(`配置台已在默认浏览器打开：${server.origin}`);
      return;
    } catch (error) {
      log.warn(`无法自动打开浏览器：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The fragment contains a one-time bootstrap credential. Emit it only when manual opening is
  // required; a successful automatic launch logs the non-sensitive origin instead.
  console.log(server.url);
  log.info("请打开上方一次性链接；认证完成后 URL 中的 token 会立即移除并失效。");
}

function assertRollUiAssetsAvailable(assetsDirectory: string): void {
  if (existsSync(resolve(assetsDirectory, "index.html"))) return;
  throw new Error(
    `Roll UI 静态资源不存在：${assetsDirectory}。请先运行 \`pnpm --filter @roll-agent/core build\`。`,
  );
}

function openExternalUrl(url: string): Promise<void> {
  const command = getExternalOpenCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.command} 退出码：${String(code)}`));
    });
  });
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
