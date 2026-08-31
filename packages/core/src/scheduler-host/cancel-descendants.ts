export const KILL_RESULTS = {
  confirmed: "confirmed",
  treeKillFailed: "tree-kill-failed",
  stillAlive: "still-alive",
  unverifiable: "unverifiable",
} as const;
export type KillResult = (typeof KILL_RESULTS)[keyof typeof KILL_RESULTS];

export function descendantsUnverified(input: {
  readonly killResult: KillResult | undefined;
  readonly killed: boolean;
  readonly platform: NodeJS.Platform;
}): boolean {
  return (
    input.killResult === KILL_RESULTS.unverifiable || (input.killed && input.platform === "win32")
  );
}
