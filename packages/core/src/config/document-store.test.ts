import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { atomicTextFileWriter } from "../internal/config-atomic-write.ts";
import type { AtomicTextWriteRequest } from "../internal/config-atomic-write.ts";
import { readProcessStartToken } from "../registry/process-identity.ts";
import {
  ConfigRevisionConflictError,
  ConfigWriteLockError,
  YamlConfigDocumentStore,
  createConfigRevision,
} from "./document-store.ts";

const FALLBACK_CONFIG = `llm:
  default-provider: anthropic
  default-model: claude-sonnet-4-6
  providers: {}
ask: {}
agents:
  data-dir: ~/.roll-agent/agents
`;

describe("YamlConfigDocumentStore", () => {
  it("preserves unrelated comments, quotes, placeholders, ordering and tilde paths", () => {
    withTemporaryConfig(
      `# top-level comment
llm:
  default-provider: anthropic # provider comment
  default-model: "claude-sonnet-4-6"
  providers:
    anthropic:
      api-key: \${ANTHROPIC_API_KEY}
ask:
  # threshold comment
  confirm-threshold: 0.5
agents:
  data-dir: ~/.roll-agent/agents
`,
      ({ configPath, store }) => {
        const snapshot = store.read();
        const preview = store.previewPatches(
          [{ op: "set", path: ["ask", "confirm-threshold"], value: 0.7 }],
          snapshot.revision,
        );
        const result = store.commit(preview);
        const written = readFileSync(configPath, "utf-8");

        assert.match(written, /^# top-level comment/mu);
        assert.match(written, /anthropic # provider comment/u);
        assert.match(written, /default-model: "claude-sonnet-4-6"/u);
        assert.match(written, /api-key: \$\{ANTHROPIC_API_KEY\}/u);
        assert.match(written, /# threshold comment/u);
        assert.match(written, /confirm-threshold: 0\.7/u);
        assert.match(written, /data-dir: ~\/\.roll-agent\/agents/u);
        assert.ok(result.backupPath);
        assert.equal(readFileSync(result.backupPath, "utf-8"), snapshot.raw);
      },
    );
  });

  it("keeps dynamic record keys containing dots as one path segment", () => {
    withTemporaryConfig(FALLBACK_CONFIG, ({ store }) => {
      const snapshot = store.read();
      const preview = store.previewPatches(
        [
          {
            op: "set",
            path: ["runtime", "approval", "overrides", "roll.exec_command"],
            value: "auto",
          },
        ],
        snapshot.revision,
      );

      assert.match(preview.raw, /roll\.exec_command: auto/u);
      assert.doesNotMatch(preview.raw, /roll:\s*\n\s+exec_command/u);
    });
  });

  it("detects optimistic concurrency conflicts before preview and commit", () => {
    withTemporaryConfig(FALLBACK_CONFIG, ({ configPath, store }) => {
      const snapshot = store.read();
      const preview = store.previewPatches(
        [{ op: "set", path: ["ask", "confirm-threshold"], value: 0.6 }],
        snapshot.revision,
      );

      writeFileSync(configPath, `${FALLBACK_CONFIG}# external edit\n`, "utf-8");

      assert.throws(
        () => store.commit(preview),
        (error: unknown) =>
          error instanceof ConfigRevisionConflictError &&
          error.expectedRevision === snapshot.revision &&
          error.actualRevision === createConfigRevision(`${FALLBACK_CONFIG}# external edit\n`),
      );
    });
  });

  it("serializes cooperative Roll writers with a process-owned lock", () => {
    withTemporaryConfig(FALLBACK_CONFIG, ({ configPath, store }) => {
      const processStartToken = readProcessStartToken(process.pid);
      assert.ok(processStartToken);
      const snapshot = store.read();
      const preview = store.previewPatches(
        [{ op: "set", path: ["ask", "confirm-threshold"], value: 0.6 }],
        snapshot.revision,
      );
      writeFileSync(
        `${configPath}.roll-write.lock`,
        `${JSON.stringify({
          pid: process.pid,
          processStartToken,
          token: "other-writer",
          createdAtMs: Date.now(),
        })}\n`,
        "utf-8",
      );

      assert.throws(() => store.commit(preview), ConfigWriteLockError);
      assert.equal(readFileSync(configPath, "utf-8"), FALLBACK_CONFIG);
    });
  });

  it("reclaims a write lock when its live PID belongs to another process instance", () => {
    withTemporaryConfig(FALLBACK_CONFIG, ({ configPath, store }) => {
      const processStartToken = readProcessStartToken(process.pid);
      assert.ok(processStartToken);
      const replacement = processStartToken.endsWith("0") ? "1" : "0";
      const reusedPidToken = `${processStartToken.slice(0, -1)}${replacement}`;
      const snapshot = store.read();
      const preview = store.previewPatches(
        [{ op: "set", path: ["ask", "confirm-threshold"], value: 0.6 }],
        snapshot.revision,
      );
      const lockPath = `${configPath}.roll-write.lock`;
      writeFileSync(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          processStartToken: reusedPidToken,
          token: "stale-writer",
          createdAtMs: Date.now(),
        })}\n`,
        "utf-8",
      );

      store.commit(preview);

      assert.match(readFileSync(configPath, "utf-8"), /confirm-threshold: 0\.6/u);
      assert.equal(existsSync(lockPath), false);
    });
  });

  it("rechecks the revision immediately before rename and preserves a non-cooperative edit", (t) => {
    withTemporaryConfig(FALLBACK_CONFIG, ({ configPath, store }) => {
      const snapshot = store.read();
      const preview = store.previewPatches(
        [{ op: "set", path: ["ask", "confirm-threshold"], value: 0.6 }],
        snapshot.revision,
      );
      const externalRaw = `${FALLBACK_CONFIG}# external edit\n`;
      const directory = dirname(configPath);
      const fileName = basename(configPath);
      const backupPrefix = `${fileName}.bak.`;
      const temporaryPrefix = `.${fileName}.`;
      const originalWrite = atomicTextFileWriter.write.bind(atomicTextFileWriter);

      t.mock.method(atomicTextFileWriter, "write", (request: AtomicTextWriteRequest) => {
        originalWrite({
          ...request,
          verifyBeforeRename: () => {
            const entries = readdirSync(directory);
            assert.ok(entries.some((entry) => entry.startsWith(backupPrefix)));
            const temporaryName = entries.find(
              (entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"),
            );
            assert.ok(temporaryName);
            assert.equal(readFileSync(join(directory, temporaryName), "utf-8"), request.raw);

            writeFileSync(configPath, externalRaw, "utf-8");
            request.verifyBeforeRename();
          },
        });
      });

      assert.throws(
        () => store.commit(preview),
        (error: unknown) =>
          error instanceof ConfigRevisionConflictError &&
          error.expectedRevision === snapshot.revision &&
          error.actualRevision === createConfigRevision(externalRaw),
      );
      assert.equal(readFileSync(configPath, "utf-8"), externalRaw);
      assert.equal(
        readdirSync(directory).some(
          (entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"),
        ),
        false,
      );
    });
  });

  it("does not rewrite or create a backup when content is unchanged", () => {
    withTemporaryConfig(FALLBACK_CONFIG, ({ configPath, store }) => {
      const snapshot = store.read();
      const preview = store.previewObject(snapshot.persisted, snapshot.revision);
      const result = store.commit(preview);

      assert.equal(result.changed, false);
      assert.equal(result.backupPath, undefined);
      assert.equal(readFileSync(configPath, "utf-8"), FALLBACK_CONFIG);
    });
  });

  it("uses a secure fallback document for a configuration file that does not exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "roll-config-store-"));
    try {
      const configPath = join(directory, "new", "roll.config.yaml");
      const store = new YamlConfigDocumentStore(configPath, FALLBACK_CONFIG);
      const snapshot = store.read();
      assert.equal(snapshot.existed, false);

      const preview = store.previewPatches(
        [{ op: "set", path: ["ask", "confirm-threshold"], value: 0.8 }],
        snapshot.revision,
      );
      const result = store.commit(preview);

      assert.equal(result.backupPath, undefined);
      assert.match(readFileSync(configPath, "utf-8"), /confirm-threshold: 0\.8/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces an unparseable document only with a parseable recovery candidate", () => {
    const invalidRaw = "llm: [\n";
    withTemporaryConfig(invalidRaw, ({ configPath, store }) => {
      const result = store.replaceRawForRecovery(FALLBACK_CONFIG, createConfigRevision(invalidRaw));

      assert.equal(result.changed, true);
      assert.equal(readFileSync(configPath, "utf-8"), FALLBACK_CONFIG);
      assert.ok(result.backupPath);
      assert.equal(readFileSync(result.backupPath, "utf-8"), invalidRaw);
    });
  });

  it("preserves an invalid document when the recovery candidate is also invalid", () => {
    const invalidRaw = "llm: [\n";
    withTemporaryConfig(invalidRaw, ({ configPath, store }) => {
      assert.throws(
        () => store.replaceRawForRecovery("ask: [\n", createConfigRevision(invalidRaw)),
        /Invalid YAML syntax/u,
      );
      assert.equal(readFileSync(configPath, "utf-8"), invalidRaw);
    });
  });

  it("rejects recovery when the invalid document changed after confirmation", () => {
    const invalidRaw = "llm: [\n";
    withTemporaryConfig(invalidRaw, ({ configPath, store }) => {
      const expectedRevision = createConfigRevision(invalidRaw);
      writeFileSync(configPath, "ask: [\n", "utf-8");

      assert.throws(
        () => store.replaceRawForRecovery(FALLBACK_CONFIG, expectedRevision),
        ConfigRevisionConflictError,
      );
      assert.equal(readFileSync(configPath, "utf-8"), "ask: [\n");
    });
  });

  it(
    "keeps a config symlink and replaces its malformed target",
    { skip: process.platform === "win32" },
    () => {
      const directory = mkdtempSync(join(tmpdir(), "roll-config-store-symlink-"));
      try {
        const targetPath = join(directory, "target.yaml");
        const configPath = join(directory, "roll.config.yaml");
        const invalidRaw = "llm: [\n";
        writeFileSync(targetPath, invalidRaw, "utf-8");
        symlinkSync(targetPath, configPath);
        const store = new YamlConfigDocumentStore(configPath, FALLBACK_CONFIG);

        const result = store.replaceRawForRecovery(
          FALLBACK_CONFIG,
          createConfigRevision(invalidRaw),
        );

        assert.equal(lstatSync(configPath).isSymbolicLink(), true);
        assert.equal(readFileSync(targetPath, "utf-8"), FALLBACK_CONFIG);
        assert.ok(result.backupPath);
        assert.equal(readFileSync(result.backupPath, "utf-8"), invalidRaw);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not fsync the containing directory on Windows after an atomic replace", () => {
    const directory = mkdtempSync(join(tmpdir(), "roll-config-store-windows-"));
    const configPath = join(directory, "roll.config.yaml");
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const originalPath = process.env["PATH"];
    writeFileSync(configPath, "ask:\n  confirm-threshold: 0.5\n", "utf-8");

    try {
      if (process.platform !== "win32") {
        const powershellPath = join(directory, "powershell.exe");
        writeFileSync(powershellPath, "#!/bin/sh\nprintf '638000000000000000\\n'\n", {
          mode: 0o700,
        });
        process.env["PATH"] = [directory, originalPath].filter(Boolean).join(delimiter);
      }
      const store = new YamlConfigDocumentStore(configPath, "ask: {}\n");
      const preview = store.previewPatches([
        { op: "set", path: ["ask", "confirm-threshold"], value: 0.75 },
      ]);

      // Keep write/rename permission but remove directory read permission. On POSIX this makes a
      // directory fsync attempt fail, proving that the simulated Windows branch skips it.
      chmodSync(directory, 0o300);
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

      const result = store.commit(preview);
      assert.equal(result.changed, true);
      assert.match(readFileSync(configPath, "utf-8"), /confirm-threshold: 0\.75/u);
    } finally {
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function withTemporaryConfig(
  raw: string,
  callback: (context: {
    readonly configPath: string;
    readonly store: YamlConfigDocumentStore;
  }) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "roll-config-store-"));
  try {
    const configPath = join(directory, "roll.config.yaml");
    writeFileSync(configPath, raw, "utf-8");
    callback({
      configPath,
      store: new YamlConfigDocumentStore(configPath, FALLBACK_CONFIG),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
