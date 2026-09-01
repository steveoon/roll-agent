import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditScheduledAgentCommands,
  buildScheduledEffectivePath,
  isCommandReachable,
} from "./command-audit.ts";

test("buildScheduledEffectivePath 在基线 PATH 上前置 node 目录", () => {
  const path = buildScheduledEffectivePath({
    baselinePath: "/usr/bin:/bin",
    execPath: "/opt/homebrew/bin/node",
    schedulerEnv: {},
    platform: "darwin",
  });
  assert.equal(path, "/opt/homebrew/bin:/usr/bin:/bin");
});

test("buildScheduledEffectivePath 让 scheduler.env 声明的 PATH 覆盖一切", () => {
  const path = buildScheduledEffectivePath({
    baselinePath: "/usr/bin:/bin",
    execPath: "/opt/homebrew/bin/node",
    schedulerEnv: { PATH: "/custom/bin" },
    platform: "darwin",
  });
  assert.equal(path, "/custom/bin");
});

test("isCommandReachable 绝对路径按存在性判断，裸命令沿 PATH 查找", () => {
  const files = new Set(["/opt/homebrew/bin/node", "/usr/bin/git"]);
  const exists = (p: string) => files.has(p);
  assert.equal(isCommandReachable("/opt/homebrew/bin/node", "", "darwin", exists), true);
  assert.equal(isCommandReachable("/missing/node", "", "darwin", exists), false);
  assert.equal(
    isCommandReachable("node", "/opt/homebrew/bin:/usr/bin", "darwin", exists),
    true,
  );
  assert.equal(isCommandReachable("python3", "/opt/homebrew/bin:/usr/bin", "darwin", exists), false);
});

test("isCommandReachable 在 win32 下尝试 .exe/.cmd/.bat 后缀", () => {
  const files = new Set(["C:\\nodejs\\node.exe"]);
  const exists = (p: string) => files.has(p);
  assert.equal(isCommandReachable("node", "C:\\nodejs", "win32", exists), true);
  assert.equal(isCommandReachable("missing", "C:\\nodejs", "win32", exists), false);
});

test("auditScheduledAgentCommands 汇总每个 agent 命令的可达性", () => {
  const files = new Set(["/opt/homebrew/bin/node"]);
  const report = auditScheduledAgentCommands({
    agents: [
      { name: "notify-agent", command: "node" },
      { name: "py-agent", command: "python3" },
    ],
    baselinePath: "/usr/bin:/bin",
    execPath: "/opt/homebrew/bin/node",
    schedulerEnv: {},
    platform: "darwin",
    exists: (p) => files.has(p),
  });
  assert.deepEqual(report, [
    { agentName: "notify-agent", command: "node", reachable: true },
    { agentName: "py-agent", command: "python3", reachable: false },
  ]);
});
