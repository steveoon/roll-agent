import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCatalogSearchMatches,
  getCatalogSearchResults,
  resolveValidationIssueTarget,
  resolveVisibleNavigationTarget,
} from "./catalog-search.ts";
import type { RollConfigCatalog } from "../types.ts";

const base = {
  path: [],
  title: "",
  effectiveRequired: false,
  persistedRequired: false,
  widget: "text",
  secret: false,
} as const;

const catalog: RollConfigCatalog = {
  schemaVersion: 1,
  root: {
    ...base,
    kind: "object",
    widget: "object",
    fields: {
      runtime: {
        ...base,
        kind: "object",
        widget: "object",
        title: "Runtime",
        fields: {
          turnTimeoutMs: {
            ...base,
            kind: "number",
            title: "Turn timeout",
            path: ["runtime", "turnTimeoutMs"],
            widget: "duration",
            defaultBehavior: "默认等待五分钟，适合大多数普通任务。",
            constraints: {
              minimum: 10_000,
              exclusiveMinimum: false,
              exclusiveMaximum: false,
              integer: true,
            },
          },
        },
      },
      browser: { ...base, kind: "object", widget: "object", title: "Browser", fields: {} },
    },
  },
  agents: [
    {
      name: "browser-use-agent",
      description: "Browser automation",
      ownership: "core-managed",
      fields: [
        {
          name: "BROWSER_SECURITY_JSON",
          title: "Browser security policy",
          description: "Restrict local network access",
          required: false,
          type: "json",
          widget: "textarea",
          secret: false,
          configurable: true,
        },
      ],
    },
  ],
};

describe("Roll UI catalog search", () => {
  it("returns field-level results with direct focus paths", () => {
    assert.deepEqual(getCatalogSearchResults(catalog, "五分钟"), [
      {
        target: { type: "roll", key: "runtime" },
        path: ["runtime", "turnTimeoutMs"],
        focusPath: ["runtime", "turnTimeoutMs"],
        title: "Turn timeout",
      },
    ]);
    assert.deepEqual(getCatalogSearchResults(catalog, "local network"), [
      {
        target: { type: "agent", name: "browser-use-agent" },
        path: ["agents", "env", "browser-use-agent", "BROWSER_SECURITY_JSON"],
        focusPath: ["agents", "env", "browser-use-agent", "BROWSER_SECURITY_JSON"],
        title: "Browser security policy",
        description: "Restrict local network access",
      },
    ]);
  });

  it("keeps the active target when it still matches", () => {
    const matches = getCatalogSearchMatches(catalog, "timeout");
    assert.deepEqual(resolveVisibleNavigationTarget({ type: "roll", key: "runtime" }, matches), {
      type: "roll",
      key: "runtime",
    });
  });

  it("selects the first visible target without mutating the stored navigation choice", () => {
    const matches = getCatalogSearchMatches(catalog, "local network");
    assert.deepEqual(resolveVisibleNavigationTarget({ type: "roll", key: "runtime" }, matches), {
      type: "agent",
      name: "browser-use-agent",
    });
  });

  it("returns no target for an empty search result", () => {
    const matches = getCatalogSearchMatches(catalog, "does-not-exist");
    assert.equal(
      resolveVisibleNavigationTarget({ type: "roll", key: "runtime" }, matches),
      undefined,
    );
  });

  it("maps validation paths back to their Roll or Agent module", () => {
    assert.deepEqual(resolveValidationIssueTarget(catalog, "runtime.turnTimeoutMs"), {
      type: "roll",
      key: "runtime",
    });
    assert.deepEqual(
      resolveValidationIssueTarget(catalog, "agents.env.browser-use-agent.BROWSER_SECURITY_JSON"),
      { type: "agent", name: "browser-use-agent" },
    );
  });
});
