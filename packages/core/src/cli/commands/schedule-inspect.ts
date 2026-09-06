import { defineCommand } from "citty";
import { loadConfig } from "../../config/loader.ts";
import {
  createScheduleBrowserPort,
  parseScheduleAttempt,
} from "../../scheduler-host/schedule-history.ts";
import { scheduleDetailText } from "../chat/schedule-browser.ts";
import { loadRuntime, printJson, runScheduleCommand } from "./schedule-command-utils.ts";

export default defineCommand({
  meta: { description: "只读查看一次定时运行及其完整执行对话" },
  args: {
    id: { type: "positional", description: "运行 invocation ID", required: true },
    attempt: { type: "string", description: "尝试序号（默认最新有关联的尝试）" },
    json: { type: "boolean", description: "JSON 格式输出", default: false },
  },
  async run({ args }) {
    await runScheduleCommand(async () => {
      const attempt = parseScheduleAttempt(args.attempt);
      const { config } = loadConfig();
      const port = createScheduleBrowserPort({ config, runtime: await loadRuntime() });
      const detail = await port.inspect(args.id, attempt);
      const transcript: string[] = [];
      if (!args.json) console.log(scheduleDetailText(detail));
      if (detail.canContinue) {
        let cursor: string | undefined;
        do {
          const page = await port.readTranscript(args.id, {
            attempt: detail.attempt,
            limit: 20,
            ...(cursor ? { cursor } : {}),
          });
          if (args.json) transcript.push(page.text);
          else console.log(`\n${page.text}`);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      }
      if (args.json) printJson({ ...detail, transcript });
    });
  },
});
