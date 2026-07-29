import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import { log } from "../utils/output.ts";
import { runServer } from "./chat.ts";

export default defineCommand({
  meta: {
    description: "通过版本化 Runtime Protocol 提供本地 Roll Runtime",
  },
  args: {
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
    const { config } = loadConfig();
    await runServer(config);
  },
});
