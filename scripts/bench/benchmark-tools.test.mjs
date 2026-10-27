import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { seedFixtureModelCatalog } from "./model-catalog-fixture.mjs";
import { passesBenchmarkChecks } from "./chat-heap-growth.mjs";

test("fixed work cannot pass failed tool facts when strict cleanup is disabled", () => {
  const sample = {
    workloadSteps: 2,
    slope: 100,
    maxSlope: 30,
    strictCleanup: false,
    cleanExit: false,
    toolFactsValid: false,
  };
  assert.equal(passesBenchmarkChecks(sample), false);
  assert.equal(passesBenchmarkChecks({ ...sample, toolFactsValid: true }), true);
  assert.equal(
    passesBenchmarkChecks({ ...sample, toolFactsValid: true, strictCleanup: true }),
    false,
  );
  assert.equal(
    passesBenchmarkChecks({ ...sample, workloadSteps: undefined, toolFactsValid: true }),
    false,
  );
});

for (const existing of ["report", "raw directory"]) {
  test(`heap benchmark refuses an existing ${existing} before starting work`, () => {
    const root = mkdtempSync(join(tmpdir(), "roll-output-test-"));
    const output = join(root, "result.json");
    const previous = JSON.stringify({ pass: true, previous: true });
    try {
      if (existing === "report") writeFileSync(output, previous);
      else mkdirSync(`${output}.raw`);
      const child = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "chat-heap-growth.mjs"), "--output", output],
        { env: { PATH: root }, encoding: "utf8" },
      );
      assert.equal(child.status, 2);
      assert.match(child.stderr, /输出路径已存在/u);
      if (existing === "report") assert.equal(readFileSync(output, "utf8"), previous);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("isolated catalog preserves the bundled dataset and never starts an external refresh", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-catalog-fixture-"));
  const snapshot = JSON.parse(
    readFileSync(
      new URL("../../benchmarks/chat-pty/model-catalog-fixture.json", import.meta.url),
      "utf8",
    ),
  );
  try {
    const fetchedAt = new Date(Date.now() - 1000).toISOString();
    const seeded = seedFixtureModelCatalog(home, fetchedAt);
    assert.deepEqual(seeded.data.providers, snapshot.providers);
    assert.equal(seeded.data.fetchedAt, fetchedAt);
    // Node 22.13 requires the flag even when the test entry itself is JavaScript.
    execFileSync(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        const [cachePath, moduleUrl] = process.argv.slice(1);
        const { ModelCatalog } = await import(moduleUrl);
        const snapshot = JSON.parse(readFileSync(cachePath, "utf8"));
        let requests = 0;
        const catalog = new ModelCatalog({
          snapshot, cachePath,
          fetchImpl: async () => { requests += 1; throw new Error("unexpected external request"); },
        });
        assert.deepEqual(catalog.data(), snapshot);
        assert.equal(await catalog.refreshIfStale(), "skipped");
        assert.equal(requests, 0);
      `,
      seeded.path,
      pathToFileURL(join(import.meta.dirname, "../../packages/runtime/src/engine/model-catalog.ts"))
        .href,
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalog control rejects expired and future timestamps instead of silently fetching", () => {
  const home = mkdtempSync(join(tmpdir(), "roll-catalog-invalid-"));
  try {
    for (const stamp of [
      new Date(Date.now() - 86400001).toISOString(),
      "9999-01-01T00:00:00.000Z",
    ]) {
      assert.throws(() => seedFixtureModelCatalog(home, stamp), /future-dated or expired/u);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const diagnostic of [false, true]) {
  test(`heap sampler records ${diagnostic ? "diagnostic GC" : "natural counters without GC"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "roll-sampler-test-"));
    const trace = join(root, "trace.jsonl");
    try {
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--input-type=module",
          "--eval",
          `
        let count = 0;
        const original = globalThis.gc;
        globalThis.gc = () => { count += 1; original(); };
        await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "heap-sampler.mjs")).href)});
        await new Promise(resolve => setTimeout(resolve, 180));
        if (${String(diagnostic)} ? count === 0 : count !== 0) throw new Error("GC mode violated");
      `,
        ],
        {
          env: {
            ...process.env,
            ROLL_BENCH_TRACE: trace,
            ROLL_BENCH_TRACE_MS: "50",
            ROLL_BENCH_FORCE_GC: String(diagnostic),
          },
        },
      );
      const samples = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(samples.length >= 2);
      for (const sample of samples) {
        assert.equal(sample.forcedGc, diagnostic);
        assert.ok(sample.naturalRssBytes > 0);
        assert.ok(sample.peakRssKB > 0);
        assert.equal(typeof sample.cpuMicros.user, "number");
        if (diagnostic) assert.ok(sample.retainedHeapBytes > 0);
        else assert.equal(sample.retainedHeapBytes, null);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
