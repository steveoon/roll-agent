import { defineCommand } from "citty";
import { loadRuntimeConfig, resolveRuntimeConfigContext } from "../../config/runtime-context.ts";
import { log } from "../utils/output.ts";
import { runServer } from "./chat.ts";

export default defineCommand({
  meta: {
    description: "通过版本化 Runtime Protocol 提供本地 Roll Runtime",
  },
  args: {
    config: { type: "string", description: "明确指定配置文件" },
    "config-workspace": { type: "string", description: "配置内相对资源路径的绝对基准目录" },
    stdio: {
      type: "boolean",
      description: "使用 NDJSON JSON-RPC over stdio transport",
      default: false,
    },
  },
  async run({ args }) {
    if (!args.stdio) {
      log.error("当前仅支持 stdio transport；请使用 `roll runtime serve --stdio`");
      process.exitCode = 1;
      return;
    }
    const options = {
      ...(args.config === undefined ? {} : { configPath: args.config }),
      ...(args["config-workspace"] === undefined
        ? {}
        : { configWorkspace: args["config-workspace"] }),
    };
    const { config } = loadRuntimeConfig(options);
    await runServer(config, resolveRuntimeConfigContext(options));
  },
});
