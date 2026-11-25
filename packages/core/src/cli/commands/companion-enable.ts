import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import {
  createCompanionCliApplication,
  parseCliCompanionRelayProtocolVersion,
  runCompanionCommand,
} from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "启用 Companion；已安装的用户服务会同步启动" },
  args: {
    "relay-protocol-version": {
      type: "string",
      description: "可选切换并持久化的 Relay Wire 协议版本（1.2、1.3 或 1.4）",
    },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      const relayProtocolVersion = parseCliCompanionRelayProtocolVersion(args.relayProtocolVersion);
      await createCompanionCliApplication().enable(
        relayProtocolVersion === undefined ? undefined : { relayProtocolVersion },
      );
      log.success("Roll Companion 已启用。");
    });
  },
});
