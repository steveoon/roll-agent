import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RUNTIME_ERROR_CODES,
  RUNTIME_METHODS,
  RUNTIME_PROTOCOL_VERSION,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  parseRuntimeMethodResultForVersion,
} from "./index.ts";

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const DOCS = {
  "docs/runtime-protocol-v1-reference.md": readRepoFile(
    "../../../docs/runtime-protocol-v1-reference.md",
  ),
  "docs/client-node-reference.md": readRepoFile("../../../docs/client-node-reference.md"),
  "docs/runtime-protocol-architecture.md": readRepoFile(
    "../../../docs/runtime-protocol-architecture.md",
  ),
  "docs/tutorial-runtime-ui-quickstart.md": readRepoFile(
    "../../../docs/tutorial-runtime-ui-quickstart.md",
  ),
  "packages/protocol/README.md": readRepoFile("../README.md"),
  "packages/client-node/README.md": readRepoFile("../../client-node/README.md"),
} as const;

type DocName = keyof typeof DOCS;

const LATEST_VERSION_CLAIMS: ReadonlyArray<{ readonly doc: DocName; readonly pattern: RegExp }> = [
  {
    doc: "docs/runtime-protocol-v1-reference.md",
    pattern: /\| 最新 Wire protocol \| `"([0-9.]+)"` \|/u,
  },
  {
    doc: "docs/client-node-reference.md",
    pattern: /\| 最新协议 \| Roll Runtime Protocol `"([0-9.]+)"` \|/u,
  },
  {
    doc: "docs/runtime-protocol-architecture.md",
    pattern: /当前最新版本为 `"([0-9.]+)"`/u,
  },
];

const LEGACY_LIST_HEADS: ReadonlySet<string> = new Set(["1.1", "1.0"]);
const VERSION_LIST_LITERAL = /\[\s*['"]1\.\d+['"](?:\s*,\s*['"]1\.\d+['"])*\s*\]/gu;
const VERSION_COMPARISON = /(?:!==|===)\s*['"](1\.\d+)['"]/gu;
const RUNTIME_LIMIT_KEYS = [
  "maxFrameBytes",
  "maxPageSize",
  "eventReplay",
  "idempotencyCacheEntries",
  "maxAttachmentBytes",
  "maxAttachmentChunkBytes",
  "maxTurnAttachments",
  "maxStagedAttachments",
] as const;

test("docs declare RUNTIME_PROTOCOL_VERSION as the latest wire version", () => {
  for (const { doc, pattern } of LATEST_VERSION_CLAIMS) {
    const match = pattern.exec(DOCS[doc]);
    assert.ok(match, `${doc} 缺少最新版本声明`);
    assert.equal(match[1], RUNTIME_PROTOCOL_VERSION, doc);
  }
});

test("docs version list literals start with the latest version unless they depict a legacy client", () => {
  for (const [doc, text] of Object.entries(DOCS)) {
    for (const literal of text.match(VERSION_LIST_LITERAL) ?? []) {
      const head = (literal.match(/1\.\d+/u) ?? [])[0];
      if (head !== undefined && !LEGACY_LIST_HEADS.has(head)) {
        assert.equal(head, RUNTIME_PROTOCOL_VERSION, `${doc}: ${literal}`);
      }
    }
  }
});

test("reference doc initialize example advertises every supported version in order", () => {
  const expected = `"protocolVersions": ["${SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.join('", "')}"]`;
  assert.ok(DOCS["docs/runtime-protocol-v1-reference.md"].includes(expected), expected);
});

test("reference doc lists every method, rollCode and latest limits field", () => {
  const reference = DOCS["docs/runtime-protocol-v1-reference.md"];
  for (const method of Object.values(RUNTIME_METHODS)) {
    assert.ok(reference.includes(`\`${method}\``), method);
  }
  for (const code of Object.values(RUNTIME_ERROR_CODES)) {
    assert.ok(reference.includes(`\`${code}\``), code);
  }
  const probe = Object.fromEntries(
    RUNTIME_LIMIT_KEYS.map((key) => [key, key === "eventReplay" ? true : 1]),
  );
  const initialized = parseRuntimeMethodResultForVersion(
    RUNTIME_PROTOCOL_VERSION,
    RUNTIME_METHODS.initialize,
    {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: "00000000-0000-4000-8000-000000000001",
      server: { name: "docs-sync", version: "0.0.0", runtimeVersion: "0.0.0" },
      features: [],
      limits: probe,
    },
  );
  assert.deepEqual(Object.keys(initialized.limits).sort(), [...RUNTIME_LIMIT_KEYS].sort());
  for (const key of RUNTIME_LIMIT_KEYS) {
    assert.ok(reference.includes(`\`${key}\``), key);
  }
});

test("reference doc compat row lists every non-latest supported version in order", () => {
  const compat = SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.slice(1)
    .map((version) => `\`"${version}"\``)
    .join("、");
  assert.ok(
    DOCS["docs/runtime-protocol-v1-reference.md"].includes(`| 兼容 Wire protocol | ${compat} |`),
    compat,
  );
});

test("docs never gate on a hand-written version comparison chain that excludes the latest version", () => {
  for (const [doc, text] of Object.entries(DOCS)) {
    for (const [index, line] of text.split("\n").entries()) {
      const compared = [...line.matchAll(VERSION_COMPARISON)]
        .map((match) => match[1])
        .filter((version): version is string => version !== undefined);
      const modern = compared.filter((version) => !LEGACY_LIST_HEADS.has(version));
      if (modern.length > 0) {
        assert.ok(
          modern.includes(RUNTIME_PROTOCOL_VERSION),
          `${doc}:${String(index + 1)} compares against ${modern.join(", ")} but not ${RUNTIME_PROTOCOL_VERSION}: ${line.trim()}`,
        );
      }
    }
  }
});
