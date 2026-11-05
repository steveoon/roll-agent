import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { loadRuntime } from "../../runtime-host/engine-factory.ts";
import {
  captureSessionLibraryBinding,
  migrateOwnedThreadLibrary,
} from "../../runtime-host/session-ownership.ts";
import { log } from "../utils/output.ts";

export default defineCommand({
  meta: { description: "显式备份并升级会话库（需先退出使用此库的所有新旧客户端）" },
  args: {
    "threads-dir": {
      type: "string",
      description: "会话库目录；默认使用当前项目配置的 runtime.threads-dir",
    },
    "confirm-stopped-clients": {
      type: "boolean",
      description: "确认所有新旧客户端已停止使用此库，并同意备份升级",
      default: false,
    },
    json: { type: "boolean", description: "输出迁移结果与备份路径 JSON", default: false },
  },
  async run({ args }) {
    try {
      captureSessionLibraryBinding();
      const dir = args["threads-dir"] ?? loadConfig().config.runtime.threadsDir;
      if (dir.trim().length === 0) throw new Error("--threads-dir 不能为空");
      const runtime = await loadRuntime();
      // Inspection and refusal must not create a Store, claim or backup.
      const preflight = runtime.inspectThreadLibrary(dir);
      if (preflight.status === "unsupported") {
        throw new runtime.ThreadLibraryMigrationRequiredError(preflight);
      }
      if (preflight.status === "needs_migration" && !args["confirm-stopped-clients"]) {
        throw new Error(
          `会话库 ${preflight.databasePath} 需要从 v${String(preflight.schemaVersion)} 升级到 v${String(preflight.supportedSchemaVersion)}。` +
            "请先退出使用此库的所有 CLI、桌面客户端和调度进程；旧客户端不遵守占用锁。" +
            "确认停止后，在相同工作目录和配置下重新执行本命令并添加 --confirm-stopped-clients，或用 --threads-dir 指定该库。升级前会创建并校验备份。",
        );
      }
      const result =
        preflight.status === "needs_migration"
          ? migrateOwnedThreadLibrary(runtime, dir, true)
          : { backupPath: null, preflight };
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.backupPath !== null) {
        log.success(`会话库已升级：${result.preflight.databasePath}`);
        log.info(`升级前备份：${result.backupPath}`);
      } else {
        log.info(
          preflight.status === "new"
            ? "会话库尚不存在，无需迁移。"
            : "会话库已是当前版本，无需迁移。",
        );
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },
});
