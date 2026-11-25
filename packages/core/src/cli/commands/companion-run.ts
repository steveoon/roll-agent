import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import {
  createCompanionCliApplication,
  createProcessAbortController,
  parseCliCompanionRelayProtocolVersion,
  runCompanionCommand,
} from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "在前台运行 Companion Host（服务管理器使用的正式入口）" },
  args: {
    foreground: {
      type: "boolean",
      description: "明确以前台模式运行",
      default: false,
    },
    "relay-protocol-version": {
      type: "string",
      description: "可选覆盖本次运行的 Relay Wire 协议版本（1.2、1.3 或 1.4）",
    },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      if (args.foreground !== true) {
        throw new Error("Use `roll companion run --foreground`");
      }
      const relayProtocolVersion = parseCliCompanionRelayProtocolVersion(args.relayProtocolVersion);
      const processSignal = createProcessAbortController();
      log.info("Roll Companion 正以前台模式运行。");
      try {
        await createCompanionCliApplication(
          relayProtocolVersion === undefined ? undefined : { relayProtocolVersion },
        ).runForeground(processSignal.controller.signal);
      } finally {
        processSignal.release();
      }
    });
  },
});
