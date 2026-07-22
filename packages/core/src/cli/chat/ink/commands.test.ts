import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCommands, SLASH_COMMANDS } from "./commands.ts";

test("filterCommands returns all on a bare slash", () => {
  assert.equal(filterCommands("/").length, SLASH_COMMANDS.length);
});

test("filterCommands prefix-filters by the command token", () => {
  assert.deepEqual(
    filterCommands("/th").map((c) => c.name),
    ["/think"],
  );
  assert.deepEqual(
    filterCommands("/e").map((c) => c.name),
    ["/effort", "/exit"],
  );
  assert.deepEqual(
    filterCommands("/ex").map((c) => c.name),
    ["/exit"],
  );
});

test("filterCommands ignores args after the command and is case-insensitive", () => {
  assert.deepEqual(
    filterCommands("/THINK on").map((c) => c.name),
    ["/think"],
  );
});

test("filterCommands returns [] for an unknown command", () => {
  assert.deepEqual(filterCommands("/nope"), []);
});

const SKILLS = [
  { name: "typescript-magician", description: "类型魔法师\n多行描述", source: "user" },
  { name: "frontend-design", description: "前端设计", source: "user" },
  { name: "compact", description: "与内置命令同名的 skill", source: "user" },
];

test("parseSkillInvocation 保留剩余文本的换行与格式", async () => {
  const { parseSkillInvocation } = await import("./commands.ts");
  const input = "/typescript-magician 修一下类型\n```ts\nconst a = 1;\n```";
  const result = parseSkillInvocation(input, SKILLS);
  assert.equal(result?.skills.length, 1);
  assert.equal(result?.prompt, "修一下类型\n```ts\nconst a = 1;\n```");
});

test("parseSkillInvocation 多 skill 前缀且重复去重", async () => {
  const { parseSkillInvocation } = await import("./commands.ts");
  const result = parseSkillInvocation(
    "/typescript-magician /frontend-design /typescript-magician 做某事",
    SKILLS,
  );
  assert.deepEqual(
    result?.skills.map((skill) => skill.name),
    ["typescript-magician", "frontend-design"],
  );
  assert.equal(result?.prompt, "做某事");
});

test("parseSkillInvocation 未知前缀返回 undefined", async () => {
  const { parseSkillInvocation } = await import("./commands.ts");
  assert.equal(parseSkillInvocation("/nope 做某事", SKILLS), undefined);
  assert.equal(parseSkillInvocation("普通消息", SKILLS), undefined);
  assert.equal(parseSkillInvocation("/frontend-design /typo 做某事", SKILLS), undefined);
});

test("buildSkillEntries 过滤与内置命令同名的 skill", async () => {
  const { buildSkillEntries } = await import("./commands.ts");
  const names = buildSkillEntries(SKILLS).map((entry) => entry.name);
  assert.ok(!names.includes("/compact"));
  assert.ok(names.includes("/typescript-magician"));
});

test("parseSkillInvocation 大小写匹配但保留 canonical skill 名", async () => {
  const { parseSkillInvocation } = await import("./commands.ts");
  const invocation = parseSkillInvocation("/FRONTEND-DESIGN 设计首页", SKILLS);
  assert.equal(invocation?.skills[0]?.name, "frontend-design");
  assert.equal(invocation?.prompt, "设计首页");
});

test("buildSkillListLines 单行截断且首行带用法", async () => {
  const { buildSkillListLines } = await import("./commands.ts");
  const long = { name: "long-skill", description: "很长的描述 ".repeat(50), source: "user" };
  const lines = buildSkillListLines([long, ...SKILLS], 60);
  assert.ok(lines[0]?.includes("用法"));
  for (const line of lines.slice(1)) {
    assert.ok(!line.includes("\n"));
  }
  const longLine = lines.find((line) => line.includes("/long-skill"));
  assert.ok(longLine);
  assert.ok(longLine.endsWith("…"));
});

test("truncateDisplay 对 CJK 宽字符按显示宽度截断", async () => {
  const { truncateDisplay } = await import("./commands.ts");
  assert.equal(truncateDisplay("abc", 0), "");
  assert.equal(truncateDisplay("abc", 1), "…");
  assert.equal(truncateDisplay("abc", 10), "abc");
  const truncated = truncateDisplay("中文中文中文中文", 9);
  assert.ok(truncated.endsWith("…"));
  assert.ok(truncated.length < 8);
  assert.equal(truncateDisplay("👩‍👩‍👧‍👦abc", 3), "👩‍👩‍👧‍👦…");
});
