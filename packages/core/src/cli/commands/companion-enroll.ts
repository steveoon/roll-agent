import { defineCommand } from "citty";
import { readPairingCodeFromStdin } from "../../companion-host/enrollment.ts";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "使用标准输入中的一次性配对码绑定官方 Relay 和本机 Workspace" },
  args: {
    "code-stdin": {
      type: "boolean",
      description: "仅从标准输入读取配对码（不会进入 argv、日志或配置）",
      default: false,
    },
    workspace: {
      type: "string",
      description: "本机 Workspace 的绝对路径",
      required: true,
    },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      if (args.codeStdin !== true) {
        throw new Error("Enrollment requires --code-stdin");
      }
      if (process.stdin.isTTY) {
        throw new Error("Pipe the one-time pairing code to stdin; interactive echo is not allowed");
      }
      const pairingCode = await readPairingCodeFromStdin(process.stdin);
      const app = createCompanionCliApplication();
      await app.enroll({ pairingCode, workspace: args.workspace });
      log.success("Roll Companion 已完成设备绑定；配对码未写入配置或日志。");
    });
  },
});
