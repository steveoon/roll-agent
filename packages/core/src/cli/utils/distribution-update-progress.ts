import type {
  DistributionDownloadNetworkError,
  DistributionDownloadTimeoutError,
} from "../../execution-environment/distribution.ts";
import {
  DISTRIBUTION_UPDATE_PHASES,
  type DistributionDownloadProgress,
  type DistributionUpdateEvent,
} from "../../execution-environment/distribution-progress.ts";
import { createSpinner, log } from "./output.ts";

const MIB = 1024 * 1024;
interface ProgressSpinner {
  text: string;
  readonly isEnabled?: boolean;
  start(): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
}
const phaseLabels = {
  [DISTRIBUTION_UPDATE_PHASES.verify]: "校验发行包",
  [DISTRIBUTION_UPDATE_PHASES.extract]: "解压发行包",
  [DISTRIBUTION_UPDATE_PHASES.check]: "验证启动",
} satisfies Record<
  Exclude<DistributionUpdateEvent["phase"], typeof DISTRIBUTION_UPDATE_PHASES.download>,
  string
>;

export function formatDistributionDownloadProgress(
  version: string,
  progress: DistributionDownloadProgress,
): string {
  const { downloadedBytes, totalBytes, elapsedMs } = progress;
  const percent = Math.floor((downloadedBytes / totalBytes) * 100);
  const speed = elapsedMs > 0 ? downloadedBytes / (elapsedMs / 1000) : 0;
  const speedText =
    speed >= MIB ? `${(speed / MIB).toFixed(1)} MiB/s` : `${Math.round(speed / 1024)} KiB/s`;
  const remaining =
    speed > 0
      ? `预计剩余 ${formatRemainingTime(Math.ceil((totalBytes - downloadedBytes) / speed))}`
      : "预计剩余时间估算中";
  return `下载 Roll v${version}：${(downloadedBytes / MIB).toFixed(1)} / ${(totalBytes / MIB).toFixed(1)} MiB（${percent}%），${speedText}，${remaining}`;
}

function formatRemainingTime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

export function formatDistributionDownloadTimeout(error: DistributionDownloadTimeoutError): string {
  const { downloadedBytes, totalBytes, elapsedMs } = error.progress;
  const advice =
    downloadedBytes === 0
      ? "尚未收到发行包数据，请检查网络、代理及 roll.duliday.com 的连通性后重试。"
      : "可调大 install.distribution-download-timeout-ms 后重试。";
  return `下载超时：已下载 ${(downloadedBytes / MIB).toFixed(1)} / ${(totalBytes / MIB).toFixed(1)} MiB，耗时 ${Math.round(elapsedMs / 1000)} 秒（下载时限 ${error.timeoutMs / 1000} 秒）。${advice}`;
}

export function formatDistributionDownloadNetworkError(
  error: DistributionDownloadNetworkError,
): string {
  const { downloadedBytes, totalBytes, elapsedMs } = error.progress;
  const cause =
    error.cause instanceof Error && error.cause.cause instanceof Error
      ? error.cause.cause
      : error.cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? `（${cause.code}）`
      : "";
  return `下载网络错误：已下载 ${(downloadedBytes / MIB).toFixed(1)} / ${(totalBytes / MIB).toFixed(1)} MiB，耗时 ${Math.round(elapsedMs / 1000)} 秒。原因：${reason}${code}。请检查网络、代理及 roll.duliday.com 的连通性后重试。`;
}

/** Keep byte notifications cheap; render at a bounded rate, including while a download stalls. */
export function createDistributionUpdateReporter(
  version: string,
  options: {
    readonly isTTY?: boolean;
    readonly now?: () => number;
    readonly write?: (text: string) => void;
    readonly spinner?: ProgressSpinner;
  } = {},
) {
  const isTTY = options.isTTY ?? process.stderr.isTTY === true;
  const now = options.now ?? (() => performance.now());
  const write = options.write ?? ((text: string) => log.info(text));
  const initialText = `获取 Roll v${version} 发行信息...`;
  const candidate: ProgressSpinner | undefined = isTTY
    ? (options.spinner ?? createSpinner(initialText))
    : undefined;
  const spinner = candidate?.isEnabled === false ? undefined : candidate;
  if (spinner) {
    spinner.text = initialText;
    spinner.start();
  } else {
    write(initialText);
  }
  let progress: DistributionDownloadProgress | undefined;
  let receivedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const clearTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const render = (text: string) => {
    if (spinner) spinner.text = text;
    else write(text);
  };
  const renderProgress = () => {
    if (!progress || stopped) return;
    render(
      formatDistributionDownloadProgress(version, {
        ...progress,
        elapsedMs: progress.elapsedMs + Math.max(0, now() - receivedAt),
      }),
    );
  };
  const stop = () => {
    stopped = true;
    clearTimer();
    spinner?.stop();
  };
  return {
    onEvent(event: DistributionUpdateEvent): void {
      if (stopped) return;
      if (event.phase === DISTRIBUTION_UPDATE_PHASES.download) {
        progress = event.progress;
        receivedAt = now();
        if (!timer) {
          renderProgress();
          timer = setInterval(renderProgress, spinner ? 1000 : 5000);
          timer.unref();
        } else if (progress.downloadedBytes === progress.totalBytes) {
          renderProgress();
        }
      } else {
        clearTimer();
        progress = undefined;
        render(`${phaseLabels[event.phase]} Roll v${version}...`);
      }
    },
    succeed(text: string): void {
      stop();
      if (spinner) spinner.succeed(text);
      else log.success(text);
    },
    fail(text: string): void {
      stop();
      if (spinner) spinner.fail(text);
      else log.error(text);
    },
    stop,
  };
}
