import type { BrowserRuntime } from "@roll-agent/browser";
import { getRuntime } from "./runtime-holder.ts";

type ForegroundRuntime = Pick<BrowserRuntime, "getConfig" | "getNativePageWindowState">;

type ForegroundTarget = {
  readonly targetId: string;
  bringToFront(): Promise<void>;
};

function getRuntimeIfInitialized(): ForegroundRuntime | undefined {
  try {
    return getRuntime();
  } catch {
    return undefined;
  }
}

async function bringToFrontSafely(target: ForegroundTarget): Promise<void> {
  await target.bringToFront().catch(() => {});
}

export async function maybeBringToFront(
  target: ForegroundTarget,
  options: { readonly runtime?: ForegroundRuntime } = {},
): Promise<void> {
  const runtime = options.runtime ?? getRuntimeIfInitialized();
  if (runtime === undefined) {
    return;
  }

  const foregroundPolicy = runtime.getConfig().security.foregroundPolicy;
  if (foregroundPolicy === "never") {
    return;
  }
  if (foregroundPolicy === "always") {
    await bringToFrontSafely(target);
    return;
  }

  const readWindowState = runtime.getNativePageWindowState;
  if (typeof readWindowState !== "function") {
    return;
  }

  const windowState = await readWindowState.call(runtime, target.targetId).catch(() => "unknown");
  if (windowState === "minimized") {
    await bringToFrontSafely(target);
  }
}
