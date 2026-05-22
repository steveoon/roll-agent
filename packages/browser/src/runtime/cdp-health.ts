import type { BrowserRuntimeConfig } from "../types/index.ts";

export interface BrowserCdpHealth {
  readonly endpoint: string;
  readonly port?: number;
  readonly versionReachable: boolean;
  readonly listReachable: boolean;
}

export type FetchCdpHealth = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

export function resolveBrowserRuntimeCdpEndpoint(config: BrowserRuntimeConfig): {
  readonly endpoint: string;
  readonly port?: number;
} {
  if (config.mode === "managed-cdp") {
    return {
      endpoint: `http://${config.cdpHost}:${String(config.cdpPort)}`,
      port: config.cdpPort,
    };
  }

  const cdpUrl = config.cdpUrl;
  if (cdpUrl === undefined) {
    throw new Error(`Browser runtime mode "${config.mode}" requires cdpUrl.`);
  }

  const parsed = new URL(cdpUrl);
  const endpoint =
    parsed.protocol === "ws:"
      ? `http://${parsed.host}`
      : parsed.protocol === "wss:"
        ? `https://${parsed.host}`
        : `${parsed.protocol}//${parsed.host}`;
  if (parsed.port.length === 0) {
    return { endpoint };
  }

  const port = Number.parseInt(parsed.port, 10);
  return Number.isInteger(port) ? { endpoint, port } : { endpoint };
}

export async function probeBrowserRuntimeCdpHealth(
  config: BrowserRuntimeConfig,
  options: {
    readonly fetch?: FetchCdpHealth;
    readonly timeoutMs?: number;
  } = {},
): Promise<BrowserCdpHealth> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 1_000;
  const target = resolveBrowserRuntimeCdpEndpoint(config);
  const versionReachable = await probeCdpPath(
    fetchImpl,
    target.endpoint,
    "/json/version",
    timeoutMs,
  );
  const listReachable = await probeCdpPath(fetchImpl, target.endpoint, "/json/list", timeoutMs);
  return {
    ...target,
    versionReachable,
    listReachable,
  };
}

async function probeCdpPath(
  fetchImpl: FetchCdpHealth,
  endpoint: string,
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL(path, endpoint), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
