export type BrowserInspectablePage = {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
};

type FetchCdpEndpoint = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

type NativeCdpPageClientDependencies = {
  readonly fetch: FetchCdpEndpoint;
  readonly ensureReady: () => Promise<void>;
  readonly resolveBaseUrl: () => string;
};

function toInspectablePage(value: unknown): BrowserInspectablePage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const targetId = candidate["id"];
  const type = candidate["type"];
  const url = candidate["url"];
  const title = candidate["title"];

  if (
    typeof targetId !== "string" ||
    typeof type !== "string" ||
    typeof url !== "string" ||
    typeof title !== "string"
  ) {
    return undefined;
  }

  return {
    targetId,
    type,
    url,
    title,
  };
}

export class NativeCdpPageClient {
  private readonly deps: NativeCdpPageClientDependencies;

  constructor(deps: NativeCdpPageClientDependencies) {
    this.deps = deps;
  }

  private getBaseUrl(): string {
    return this.deps.resolveBaseUrl();
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    await this.deps.ensureReady();

    const response = await this.deps.fetch(new URL(path, this.getBaseUrl()), {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(
        `Native CDP endpoint ${path} failed with ${response.status} ${response.statusText}.`,
      );
    }

    return response;
  }

  async listPages(): Promise<ReadonlyArray<BrowserInspectablePage>> {
    const response = await this.request("/json/list");
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error("Native CDP /json/list did not return an array.");
    }

    return payload
      .map((entry) => toInspectablePage(entry))
      .filter((entry): entry is BrowserInspectablePage => entry !== undefined && entry.type === "page");
  }

  async activatePage(targetId: string): Promise<void> {
    await this.request(`/json/activate/${encodeURIComponent(targetId)}`);
  }

  async openPage(url: string): Promise<BrowserInspectablePage> {
    await this.deps.ensureReady();

    const endpoint = `${new URL("/json/new", this.getBaseUrl()).toString()}?${encodeURIComponent(url)}`;
    const response = await this.deps.fetch(endpoint, {
      method: "PUT",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(
        `Native CDP endpoint /json/new failed with ${response.status} ${response.statusText}.`,
      );
    }

    const payload: unknown = await response.json().catch(() => undefined);
    const page = toInspectablePage(payload);
    if (page && page.type === "page") {
      return page;
    }

    const matchedPage = (await this.listPages()).find((candidate) => candidate.url === url);
    if (matchedPage) {
      return matchedPage;
    }

    throw new Error(`Native CDP endpoint /json/new did not return a page target for ${url}.`);
  }
}
