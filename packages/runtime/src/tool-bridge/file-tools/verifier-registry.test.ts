import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERIFIER_LEVELS,
  verifiersForFile,
  runVerifier,
  outcomeFromExecution,
  isBinaryOnPath,
  type Verifier,
} from "./verifier-registry.ts";

function fixtureWorkdir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function fakeVerifier(id: string): Verifier {
  return {
    id,
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "true", args: [] }),
    timeoutMs: 1000,
  };
}

test("verifiersForFile 对 .ts 依次返回 eslint 与 tsc", () => {
  assert.deepEqual(
    verifiersForFile("/proj/src/a.ts").map((v) => v.id),
    ["eslint", "tsc"],
  );
});

test("verifiersForFile 对 .js 只返回 eslint", () => {
  assert.deepEqual(
    verifiersForFile("/proj/src/a.js").map((v) => v.id),
    ["eslint"],
  );
});

test("verifiersForFile 对 .py 依次返回 ruff 与 py-compile 兜底", () => {
  assert.deepEqual(
    verifiersForFile("/proj/a.py").map((v) => v.id),
    ["ruff", "py-compile"],
  );
});

test("verifiersForFile 对 .json 只返回内建 json 验证器", () => {
  assert.deepEqual(
    verifiersForFile("/proj/a.json").map((v) => v.id),
    ["json"],
  );
});

test("verifiersForFile 对 .yaml 与 .yml 均返回内建 yaml 验证器", () => {
  assert.deepEqual(
    verifiersForFile("/proj/a.yaml").map((v) => v.id),
    ["yaml"],
  );
  assert.deepEqual(
    verifiersForFile("/proj/a.yml").map((v) => v.id),
    ["yaml"],
  );
});

test("verifiersForFile 对 .sh 与 .bash 均返回 bash-syntax", () => {
  assert.deepEqual(
    verifiersForFile("/proj/a.sh").map((v) => v.id),
    ["bash-syntax"],
  );
  assert.deepEqual(
    verifiersForFile("/proj/a.bash").map((v) => v.id),
    ["bash-syntax"],
  );
});

test("verifiersForFile 对 .go 依次返回 gofmt 与 go-vet", () => {
  assert.deepEqual(
    verifiersForFile("/proj/main.go").map((v) => v.id),
    ["gofmt", "go-vet"],
  );
});

test("verifiersForFile 对 .rs 只返回 cargo-check", () => {
  assert.deepEqual(
    verifiersForFile("/proj/main.rs").map((v) => v.id),
    ["cargo-check"],
  );
});

test("verifiersForFile 对未知扩展名返回空数组", () => {
  assert.deepEqual(verifiersForFile("/proj/a.xyz"), []);
});

test("builtin-json：合法 JSON 判定为 pass", async () => {
  const workdir = fixtureWorkdir("verifier-json-ok-");
  const filePath = join(workdir, "a.json");
  writeFileSync(filePath, '{"a":1}', "utf8");
  const verifier = verifiersForFile(filePath).find((v) => v.id === "json");
  assert.ok(verifier);
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.deepEqual(outcome, { id: "json", status: "pass" });
});

test("builtin-json：非法 JSON 判定为 fail 且带错误信息", async () => {
  const workdir = fixtureWorkdir("verifier-json-bad-");
  const filePath = join(workdir, "a.json");
  writeFileSync(filePath, "{not valid json", "utf8");
  const verifier = verifiersForFile(filePath).find((v) => v.id === "json");
  assert.ok(verifier);
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.ok(outcome.output.length > 0);
  }
});

test("yaml 验证器 detect 在本仓依赖下可用", () => {
  const verifier = verifiersForFile("a.yaml").find((v) => v.id === "yaml");
  assert.ok(verifier);
  assert.equal(verifier.detect("/any/workdir", "/any/a.yaml"), true);
});

test("builtin-yaml：合法 YAML 判定为 pass", async () => {
  const workdir = fixtureWorkdir("verifier-yaml-ok-");
  const filePath = join(workdir, "a.yaml");
  writeFileSync(filePath, "a: 1\nb: 2\n", "utf8");
  const verifier = verifiersForFile(filePath).find((v) => v.id === "yaml");
  assert.ok(verifier);
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.deepEqual(outcome, { id: "yaml", status: "pass" });
});

test("builtin-yaml：非法 YAML 判定为 fail 且带错误信息", async () => {
  const workdir = fixtureWorkdir("verifier-yaml-bad-");
  const filePath = join(workdir, "a.yaml");
  writeFileSync(filePath, "a: [1, 2\nb: broken\n", "utf8");
  const verifier = verifiersForFile(filePath).find((v) => v.id === "yaml");
  assert.ok(verifier);
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.ok(outcome.output.length > 0);
  }
});

test("bash-syntax 验证器 detect 在 CI 环境下可用", () => {
  const verifier = verifiersForFile("a.sh").find((v) => v.id === "bash-syntax");
  assert.ok(verifier);
  assert.equal(verifier.detect("/any/workdir", "/any/a.sh"), true);
});

test("bash-syntax：合法脚本判定为 pass", async () => {
  const workdir = fixtureWorkdir("verifier-bash-ok-");
  const filePath = join(workdir, "a.sh");
  writeFileSync(filePath, "echo hi\n", "utf8");
  const verifier = verifiersForFile(filePath).find((v) => v.id === "bash-syntax");
  assert.ok(verifier);
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.deepEqual(outcome, { id: "bash-syntax", status: "pass" });
});

test("bash-syntax：语法错误脚本判定为 fail", async () => {
  const workdir = fixtureWorkdir("verifier-bash-bad-");
  const filePath = join(workdir, "a.sh");
  writeFileSync(filePath, "if [ 1 -eq 1 ]; then echo hi\n", "utf8");
  const verifier = verifiersForFile(filePath).find((v) => v.id === "bash-syntax");
  assert.ok(verifier);
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.ok(outcome.output.length > 0);
  }
});

test("eslint detect：临时目录无 node_modules 时返回 false", () => {
  const workdir = fixtureWorkdir("verifier-eslint-nodep-");
  const verifier = verifiersForFile("a.ts").find((v) => v.id === "eslint");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.ts")), false);
});

test("eslint detect：有本地二进制但无配置文件时返回 false", () => {
  const workdir = fixtureWorkdir("verifier-eslint-nocfg-");
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workdir, "node_modules", ".bin", "eslint"), "", "utf8");
  const verifier = verifiersForFile("a.ts").find((v) => v.id === "eslint");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.ts")), false);
});

test("eslint detect：本地二进制与 flat config 均存在时返回 true", () => {
  const workdir = fixtureWorkdir("verifier-eslint-flat-");
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workdir, "node_modules", ".bin", "eslint"), "", "utf8");
  writeFileSync(join(workdir, "eslint.config.js"), "export default [];\n", "utf8");
  const verifier = verifiersForFile("a.ts").find((v) => v.id === "eslint");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.ts")), true);
});

test("eslint detect：本地二进制与 legacy .eslintrc 均存在时返回 true", () => {
  const workdir = fixtureWorkdir("verifier-eslint-legacy-");
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workdir, "node_modules", ".bin", "eslint"), "", "utf8");
  writeFileSync(join(workdir, ".eslintrc.json"), "{}", "utf8");
  const verifier = verifiersForFile("a.ts").find((v) => v.id === "eslint");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.ts")), true);
});

test("tsc detect：缺少 tsconfig.json 时返回 false", () => {
  const workdir = fixtureWorkdir("verifier-tsc-nocfg-");
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workdir, "node_modules", ".bin", "tsc"), "", "utf8");
  const verifier = verifiersForFile("a.ts").find((v) => v.id === "tsc");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.ts")), false);
});

test("tsc detect：本地二进制与 tsconfig.json 均存在时返回 true", () => {
  const workdir = fixtureWorkdir("verifier-tsc-ok-");
  mkdirSync(join(workdir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(workdir, "node_modules", ".bin", "tsc"), "", "utf8");
  writeFileSync(join(workdir, "tsconfig.json"), "{}", "utf8");
  const verifier = verifiersForFile("a.ts").find((v) => v.id === "tsc");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.ts")), true);
});

test("go-vet detect：缺少 go.mod 时返回 false（不依赖 PATH 是否装了 go）", () => {
  const workdir = fixtureWorkdir("verifier-govet-nomod-");
  const verifier = verifiersForFile("a.go").find((v) => v.id === "go-vet");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.go")), false);
});

test("cargo-check detect：缺少 Cargo.toml 时返回 false（不依赖 PATH 是否装了 cargo）", () => {
  const workdir = fixtureWorkdir("verifier-cargo-nomanifest-");
  const verifier = verifiersForFile("a.rs").find((v) => v.id === "cargo-check");
  assert.ok(verifier);
  assert.equal(verifier.detect(workdir, join(workdir, "a.rs")), false);
});

test("isBinaryOnPath：注入的 probe 返回 true 时结果为 true", () => {
  assert.equal(
    isBinaryOnPath("fixture-bin-available-1", () => true),
    true,
  );
});

test("isBinaryOnPath：注入的 probe 返回 false 时结果为 false", () => {
  assert.equal(
    isBinaryOnPath("fixture-bin-missing-1", () => false),
    false,
  );
});

test("isBinaryOnPath：同一 bin 名的探测结果按模块级缓存复用，不重复调用 probe", () => {
  let callCount = 0;
  const probe = (bin: string) => {
    callCount += 1;
    return bin.endsWith("-cached");
  };
  const first = isBinaryOnPath("fixture-bin-cached", probe);
  const second = isBinaryOnPath("fixture-bin-cached", probe);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(callCount, 1);
});

test("ruff 验证器 detect 与 isBinaryOnPath('ruff') 结果一致", () => {
  const verifier = verifiersForFile("a.py").find((v) => v.id === "ruff");
  assert.ok(verifier);
  assert.equal(verifier.detect("/any/workdir", "/any/a.py"), isBinaryOnPath("ruff"));
});

test("gofmt 验证器 detect 与 isBinaryOnPath('gofmt') 结果一致", () => {
  const verifier = verifiersForFile("a.go").find((v) => v.id === "gofmt");
  assert.ok(verifier);
  assert.equal(verifier.detect("/any/workdir", "/any/a.go"), isBinaryOnPath("gofmt"));
});

test("py-compile 验证器 detect 遵循「ruff 不可用且 python3 可用」的兜底公式", () => {
  const verifier = verifiersForFile("a.py").find((v) => v.id === "py-compile");
  assert.ok(verifier);
  const expected = !isBinaryOnPath("ruff") && isBinaryOnPath("python3");
  assert.equal(verifier.detect("/any/workdir", "/any/a.py"), expected);
});

test("eslint command 构造使用本地二进制与 --no-fix", () => {
  const workdir = "/proj";
  const filePath = "/proj/src/a.ts";
  const verifier = verifiersForFile(filePath).find((v) => v.id === "eslint");
  assert.ok(verifier);
  assert.deepEqual(verifier.command(workdir, filePath), {
    bin: join(workdir, "node_modules", ".bin", "eslint"),
    args: ["--no-fix", filePath],
  });
});

test("tsc command 构造使用本地二进制与 --noEmit，不带 filePath", () => {
  const workdir = "/proj";
  const filePath = "/proj/src/a.ts";
  const verifier = verifiersForFile(filePath).find((v) => v.id === "tsc");
  assert.ok(verifier);
  assert.deepEqual(verifier.command(workdir, filePath), {
    bin: join(workdir, "node_modules", ".bin", "tsc"),
    args: ["--noEmit"],
  });
});

test("ruff command 构造为 check --no-fix <filePath>", () => {
  const filePath = "/proj/a.py";
  const verifier = verifiersForFile(filePath).find((v) => v.id === "ruff");
  assert.ok(verifier);
  assert.deepEqual(verifier.command("/proj", filePath), {
    bin: "ruff",
    args: ["check", "--no-fix", filePath],
  });
});

test("py-compile command 构造为 -m py_compile <filePath>", () => {
  const filePath = "/proj/a.py";
  const verifier = verifiersForFile(filePath).find((v) => v.id === "py-compile");
  assert.ok(verifier);
  assert.deepEqual(verifier.command("/proj", filePath), {
    bin: "python3",
    args: ["-m", "py_compile", filePath],
  });
});

test("json command 返回 builtin-json 字面量", () => {
  const verifier = verifiersForFile("/proj/a.json").find((v) => v.id === "json");
  assert.ok(verifier);
  assert.equal(verifier.command("/proj", "/proj/a.json"), "builtin-json");
});

test("yaml command 返回 builtin-yaml 字面量", () => {
  const verifier = verifiersForFile("/proj/a.yaml").find((v) => v.id === "yaml");
  assert.ok(verifier);
  assert.equal(verifier.command("/proj", "/proj/a.yaml"), "builtin-yaml");
});

test("bash-syntax command 构造为 -n <filePath>", () => {
  const filePath = "/proj/a.sh";
  const verifier = verifiersForFile(filePath).find((v) => v.id === "bash-syntax");
  assert.ok(verifier);
  assert.deepEqual(verifier.command("/proj", filePath), { bin: "bash", args: ["-n", filePath] });
});

test("gofmt command 构造为 -l <filePath>", () => {
  const filePath = "/proj/main.go";
  const verifier = verifiersForFile(filePath).find((v) => v.id === "gofmt");
  assert.ok(verifier);
  assert.deepEqual(verifier.command("/proj", filePath), { bin: "gofmt", args: ["-l", filePath] });
});

test("go-vet command 构造为 go vet ./...", () => {
  const verifier = verifiersForFile("/proj/main.go").find((v) => v.id === "go-vet");
  assert.ok(verifier);
  assert.deepEqual(verifier.command("/proj", "/proj/main.go"), {
    bin: "go",
    args: ["vet", "./..."],
  });
});

test("cargo-check command 构造为 cargo check --quiet", () => {
  const verifier = verifiersForFile("/proj/main.rs").find((v) => v.id === "cargo-check");
  assert.ok(verifier);
  assert.deepEqual(verifier.command("/proj", "/proj/main.rs"), {
    bin: "cargo",
    args: ["check", "--quiet"],
  });
});

test("outcomeFromExecution：exit 0 判定为 pass", () => {
  const outcome = outcomeFromExecution(fakeVerifier("eslint"), 0, "", "");
  assert.deepEqual(outcome, { id: "eslint", status: "pass" });
});

test("outcomeFromExecution：非零退出判定为 fail 且包含 stdout 与 stderr", () => {
  const outcome = outcomeFromExecution(fakeVerifier("ruff"), 1, "stdout-part", "stderr-part");
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.match(outcome.output, /stdout-part/u);
    assert.match(outcome.output, /stderr-part/u);
  }
});

test("outcomeFromExecution：gofmt 特例 exit 0 但 stdout 非空判定为 fail", () => {
  const outcome = outcomeFromExecution(fakeVerifier("gofmt"), 0, "unformatted.go\n", "");
  assert.equal(outcome.status, "fail");
});

test("outcomeFromExecution：gofmt exit 0 且 stdout 为空判定为 pass", () => {
  const outcome = outcomeFromExecution(fakeVerifier("gofmt"), 0, "", "");
  assert.deepEqual(outcome, { id: "gofmt", status: "pass" });
});

test("outcomeFromExecution：非 gofmt 的 exit 0 即使 stdout 非空仍判定为 pass", () => {
  const outcome = outcomeFromExecution(fakeVerifier("eslint"), 0, "some stdout noise\n", "");
  assert.deepEqual(outcome, { id: "eslint", status: "pass" });
});

test("outcomeFromExecution：输出超过 4000 字符时被截断", () => {
  const longOutput = "x".repeat(5000);
  const outcome = outcomeFromExecution(fakeVerifier("ruff"), 1, longOutput, "");
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.ok(outcome.output.length < longOutput.length);
    assert.ok(outcome.output.length <= 4000 + 20);
  }
});

test("runVerifier：外部命令 exit 0 时返回 pass", async () => {
  const workdir = fixtureWorkdir("verifier-ext-pass-");
  const filePath = join(workdir, "a.txt");
  writeFileSync(filePath, "x", "utf8");
  const verifier: Verifier = {
    id: "fixture-ok",
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "bash", args: ["-c", "exit 0"] }),
    timeoutMs: 5000,
  };
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.deepEqual(outcome, { id: "fixture-ok", status: "pass" });
});

test("runVerifier：外部命令非零退出时返回 fail 且带 stderr", async () => {
  const workdir = fixtureWorkdir("verifier-ext-fail-");
  const filePath = join(workdir, "a.txt");
  writeFileSync(filePath, "x", "utf8");
  const verifier: Verifier = {
    id: "fixture-fail",
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "bash", args: ["-c", "echo boom 1>&2; exit 1"] }),
    timeoutMs: 5000,
  };
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.match(outcome.output, /boom/u);
  }
});

test("runVerifier：id=gofmt 且 exit 0 stdout 非空时端到端判定为 fail", async () => {
  const workdir = fixtureWorkdir("verifier-ext-gofmt-dirty-");
  const filePath = join(workdir, "main.go");
  writeFileSync(filePath, "x", "utf8");
  const verifier: Verifier = {
    id: "gofmt",
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "bash", args: ["-c", "echo main.go; exit 0"] }),
    timeoutMs: 5000,
  };
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
});

test("runVerifier：spawn 失败（二进制不存在）时返回 fail 且 output 含错误描述", async () => {
  const workdir = fixtureWorkdir("verifier-ext-enoent-");
  const filePath = join(workdir, "a.txt");
  writeFileSync(filePath, "x", "utf8");
  const verifier: Verifier = {
    id: "fixture-enoent",
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "definitely-not-a-real-binary-xyz-123", args: [] }),
    timeoutMs: 5000,
  };
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.ok(outcome.output.length > 0);
  }
});

test("runVerifier：执行超时时返回 fail 且 output 说明超时", async () => {
  const workdir = fixtureWorkdir("verifier-ext-timeout-");
  const filePath = join(workdir, "a.txt");
  writeFileSync(filePath, "x", "utf8");
  const verifier: Verifier = {
    id: "fixture-timeout",
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "bash", args: ["-c", "sleep 5"] }),
    timeoutMs: 200,
  };
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
  if (outcome.status === "fail") {
    assert.match(outcome.output, /超时/u);
  }
});

test("runVerifier：输出超过 maxBuffer 时返回 fail 而非静默当作 pass", async () => {
  const workdir = fixtureWorkdir("verifier-ext-maxbuffer-");
  const filePath = join(workdir, "a.txt");
  writeFileSync(filePath, "x", "utf8");
  const verifier: Verifier = {
    id: "fixture-huge",
    level: VERIFIER_LEVELS.fast,
    detect: () => true,
    command: () => ({ bin: "bash", args: ["-c", "head -c 700000 /dev/zero"] }),
    timeoutMs: 5000,
  };
  const outcome = await runVerifier(verifier, workdir, filePath);
  assert.equal(outcome.status, "fail");
});
