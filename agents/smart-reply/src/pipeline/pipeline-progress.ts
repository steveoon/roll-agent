import ora from "ora";
import type { Ora } from "ora";

export interface PipelineProgress {
  /** 更新 spinner 文本，首次调用自动启动 */
  update(text: string): void;
  /** 停止 spinner，显示最终摘要行 */
  succeed(text: string): void;
  /** 停止 spinner，显示失败信息 */
  fail(text: string): void;
}

export function createPipelineProgress(): PipelineProgress {
  let spinner: Ora | null = null;

  return {
    update(text: string): void {
      if (!spinner) {
        spinner = ora({ text, stream: process.stderr }).start();
      } else {
        spinner.text = text;
      }
    },
    succeed(text: string): void {
      if (spinner) {
        spinner.succeed(text);
        spinner = null;
      } else {
        console.error(`✓ ${text}`);
      }
    },
    fail(text: string): void {
      if (spinner) {
        spinner.fail(text);
        spinner = null;
      } else {
        console.error(`✗ ${text}`);
      }
    },
  };
}
