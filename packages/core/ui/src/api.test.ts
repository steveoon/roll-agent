import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RollUiApi, RollUiApiError } from "./api.ts";

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

interface BrowserHarness {
  readonly calls: FetchCall[];
  readonly replacedUrls: string[];
  readonly location: { hash: string };
  readonly navigateToHash: (hash: string) => void;
  readonly restore: () => void;
}

describe("RollUiApi bootstrap authentication", () => {
  it("falls back to the existing cookie session when the fragment token is stale", async () => {
    const browser = installBrowserHarness([
      jsonResponse(
        { error: { code: "invalid_bootstrap_token", message: "Invalid bootstrap token." } },
        401,
      ),
      jsonResponse({ data: { bootstrap: { csrfToken: "cookie-csrf" } } }),
    ]);
    try {
      const result = await new RollUiApi().bootstrap();

      assert.equal(result.csrfToken, "cookie-csrf");
      assert.deepEqual(
        browser.calls.map((call) => call.init?.method),
        ["POST", "GET"],
      );
      assert.equal(
        new Headers(browser.calls[0]?.init?.headers).get("X-Roll-Bootstrap-Token"),
        "stale-token",
      );
      assert.deepEqual(browser.replacedUrls, ["/ui/"]);
      assert.equal(browser.location.hash, "");
    } finally {
      browser.restore();
    }
  });

  it("clears a bootstrap fragment added by hash-only navigation after authentication", async () => {
    const browser = installBrowserHarness(
      [jsonResponse({ data: { bootstrap: { csrfToken: "cookie-csrf" } } })],
      "",
    );
    try {
      const api = new RollUiApi();
      await Promise.all([api.bootstrap(), api.bootstrap()]);

      assert.deepEqual(
        browser.calls.map((call) => call.init?.method),
        ["GET"],
      );
      assert.deepEqual(browser.replacedUrls, []);

      browser.navigateToHash("#token=already-consumed");

      assert.deepEqual(browser.replacedUrls, ["/ui/"]);
      assert.equal(browser.location.hash, "");
    } finally {
      browser.restore();
    }
  });

  it("keeps the fragment and surfaces a failed cookie-session fallback", async () => {
    const browser = installBrowserHarness([
      jsonResponse(
        { error: { code: "invalid_bootstrap_token", message: "Invalid bootstrap token." } },
        401,
      ),
      jsonResponse({ error: { code: "invalid_session", message: "Session expired." } }, 403),
    ]);
    try {
      await assert.rejects(
        new RollUiApi().bootstrap(),
        (error: unknown) => error instanceof RollUiApiError && error.status === 403,
      );
      assert.equal(browser.calls.length, 2);
      assert.deepEqual(browser.replacedUrls, []);
      assert.equal(browser.location.hash, "#token=stale-token");
    } finally {
      browser.restore();
    }
  });

  it("does not retry or clear the fragment for non-authentication failures", async () => {
    const browser = installBrowserHarness([
      jsonResponse({ error: { code: "internal_error", message: "Unavailable." } }, 500),
    ]);
    try {
      await assert.rejects(
        new RollUiApi().bootstrap(),
        (error: unknown) => error instanceof RollUiApiError && error.status === 500,
      );
      assert.equal(browser.calls.length, 1);
      assert.deepEqual(browser.replacedUrls, []);
      assert.equal(browser.location.hash, "#token=stale-token");
    } finally {
      browser.restore();
    }
  });

  it("clears the fragment only after the fallback returns a valid bootstrap shape", async () => {
    const browser = installBrowserHarness([
      jsonResponse(
        { error: { code: "invalid_bootstrap_token", message: "Invalid bootstrap token." } },
        401,
      ),
      jsonResponse({ data: {} }),
    ]);
    try {
      await assert.rejects(
        new RollUiApi().bootstrap(),
        (error: unknown) => error instanceof RollUiApiError && error.code === "invalid_response",
      );
      assert.deepEqual(browser.replacedUrls, []);
      assert.equal(browser.location.hash, "#token=stale-token");
    } finally {
      browser.restore();
    }
  });
});

describe("RollUiApi config mutation serialization", () => {
  it("maps the form editor mode to the structured HTTP contract", async () => {
    const browser = installBrowserHarness([configPreviewResponse()], "");
    try {
      await new RollUiApi().previewConfig({
        mode: "form",
        expectedRevision: "revision-1",
        persisted: { runtime: { turnTimeoutMs: 310_000 } },
      });

      const requestBody = JSON.parse(String(browser.calls[0]?.init?.body)) as Record<
        string,
        unknown
      >;
      assert.deepEqual(requestBody, {
        mode: "structured",
        expectedRevision: "revision-1",
        persisted: { runtime: { turnTimeoutMs: 310_000 } },
      });
    } finally {
      browser.restore();
    }
  });
});

function installBrowserHarness(
  responses: readonly Response[],
  initialHash = "#token=stale-token",
): BrowserHarness {
  const calls: FetchCall[] = [];
  const replacedUrls: string[] = [];
  const location = {
    href: `http://127.0.0.1:3456/ui/${initialHash}`,
    hash: initialHash,
    pathname: "/ui/",
    search: "",
  };
  const eventTarget = new EventTarget();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const queuedResponses = [...responses];

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      history: {
        replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
          replacedUrls.push(String(url ?? ""));
          location.hash = "";
        },
      },
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    } as unknown as Window,
  });
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
    const response = queuedResponses.shift();
    if (response === undefined) throw new Error("Unexpected fetch call");
    return response;
  }) as typeof fetch;

  return {
    calls,
    replacedUrls,
    location,
    navigateToHash: (hash: string) => {
      location.hash = hash;
      location.href = `http://127.0.0.1:3456/ui/${hash}`;
      eventTarget.dispatchEvent(new Event("hashchange"));
    },
    restore: () => {
      globalThis.fetch = previousFetch;
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", previousWindow);
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function configPreviewResponse(): Response {
  return jsonResponse({
    data: {
      snapshot: {
        configPath: "/tmp/roll.config.yaml",
        existed: true,
        revision: "revision-2",
        persisted: {},
        yaml: "",
        configuredSecretPaths: [],
      },
      changed: true,
      changedPaths: [["runtime", "turnTimeoutMs"]],
      effects: [],
      diff: [],
    },
  });
}
