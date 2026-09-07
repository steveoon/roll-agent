import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getExecutionEnvironment, type ExecutionEnvironment } from "./index.ts";

const execFileAsync = promisify(execFile);
export type SelfUpdateTarget =
  | { readonly channel: "standalone" }
  | { readonly channel: "npm"; readonly prefix: string }
  | { readonly channel: "unmanaged"; readonly reason: string };

/** Prove which installation npm would replace before allowing a global install. */
export async function resolveSelfUpdateTarget(
  environment: ExecutionEnvironment = getExecutionEnvironment(),
): Promise<SelfUpdateTarget> {
  if (environment.installation.channel === "standalone") {
    return environment.installation.installRoot
      ? { channel: "standalone" }
      : { channel: "unmanaged", reason: "当前是尚未激活的独立发行包，请先通过安装器完成安装" };
  }
  if (environment.installation.channel !== "host" || !environment.npmCliPath) {
    return {
      channel: "unmanaged",
      reason: "当前是源码、未知安装或缺少宿主 npm；跳过 Roll 本体更新，保留 Agent 更新",
    };
  }
  try {
    const invocation = environment.resolveCommand("npm", ["prefix", "--global"], process.env);
    const options = { env: invocation.env, timeout: 10_000, maxBuffer: 1024 * 1024 };
    const { stdout: prefixOutput } = await execFileAsync(
      invocation.command,
      [...invocation.args],
      options,
    );
    const prefix = await realpath(prefixOutput.trim());
    const rootInvocation = environment.resolveCommand(
      "npm",
      ["root", "--global", "--prefix", prefix],
      process.env,
    );
    const { stdout: rootOutput } = await execFileAsync(
      rootInvocation.command,
      [...rootInvocation.args],
      options,
    );
    if (
      !(await isCurrentNpmInstallation(environment.installation.packageRoot, rootOutput.trim()))
    ) {
      return {
        channel: "unmanaged",
        reason: "npm 的全局目录与正在运行的 Roll 不一致；跳过本体更新，避免修改另一份安装",
      };
    }
    return { channel: "npm", prefix };
  } catch {
    return {
      channel: "unmanaged",
      reason: "无法确认当前 Roll 对应的 npm 全局目录；跳过本体更新，避免修改另一份安装",
    };
  }
}

export async function isCurrentNpmInstallation(
  packageRoot: string,
  npmRoot: string,
): Promise<boolean> {
  try {
    return (await realpath(packageRoot)) === (await realpath(join(npmRoot, "@roll-agent/core")));
  } catch {
    return false;
  }
}
