import { defineCommand } from "citty";
import { log } from "../utils/output.ts";
import { createCompanionCliApplication, runCompanionCommand } from "./companion-command-utils.ts";

export default defineCommand({
  meta: { description: "检查 Companion enrollment、凭据、Workspace、服务和 bundled Runtime" },
  args: {
    json: { type: "boolean", description: "以 JSON 输出到 stdout", default: false },
  },
  async run({ args }) {
    await runCompanionCommand(async () => {
      const result = await createCompanionCliApplication().doctor();
      if (args.json === true) {
        console.log(JSON.stringify(result));
      } else {
        for (const check of result.checks) {
          (check.ok ? log.success : log.error)(`${check.name}: ${check.detail}`);
        }
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  },
});
