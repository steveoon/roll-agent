/** Independent of npm installation and the small release manifest request. */
export const DEFAULT_DISTRIBUTION_DOWNLOAD_TIMEOUT_MS = 900_000;

export const DISTRIBUTION_UPDATE_PHASES = {
  download: "download",
  verify: "verify",
  extract: "extract",
  check: "check",
} as const;

export interface DistributionDownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly elapsedMs: number;
}

export type DistributionUpdateEvent =
  | {
      readonly phase: typeof DISTRIBUTION_UPDATE_PHASES.download;
      readonly progress: DistributionDownloadProgress;
    }
  | {
      readonly phase: Exclude<
        (typeof DISTRIBUTION_UPDATE_PHASES)[keyof typeof DISTRIBUTION_UPDATE_PHASES],
        typeof DISTRIBUTION_UPDATE_PHASES.download
      >;
    };
