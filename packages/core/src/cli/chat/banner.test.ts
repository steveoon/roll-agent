import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBannerLines, renderBannerText, type BannerInfo } from "./banner.ts";

const INFO: BannerInfo = {
  version: "0.14.1",
  model: "claude-sonnet-5",
  agentCount: 4,
  skillCount: 26,
};

function texts(lines: ReturnType<typeof buildBannerLines>): string {
  return lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
}

test("unicode 宽终端使用块字符 logo 与六档渐变", () => {
  const lines = buildBannerLines(INFO, 120, { unicode: true });
  const body = texts(lines);
  assert.ok(body.includes("██████╗"));
  const colors = lines
    .map((line) => line.spans[0]?.color)
    .filter((color): color is string => color !== undefined)
    .slice(0, 6);
  assert.equal(new Set(colors).size, 6);
});

test("信息行以 Roll Agent 开头并跟随版本与统计", () => {
  const lines = buildBannerLines(INFO, 120, { unicode: true });
  const info = lines.find((line) => line.spans.some((span) => span.text.includes("Roll Agent")));
  assert.ok(info);
  const flat = info.spans.map((span) => span.text).join("");
  assert.ok(flat.includes("Roll Agent v0.14.1 · claude-sonnet-5 · 4 agents · 26 skills"));
  assert.equal(info.spans[0]?.color, "#e879f9");
});

test("非 unicode 终端降级为 slant ASCII logo", () => {
  const body = texts(buildBannerLines(INFO, 120, { unicode: false }));
  assert.ok(!body.includes("█"));
  assert.ok(body.includes("/ __ \\/ __ \\"));
});

test("极窄终端省略 logo，只保留信息行", () => {
  const body = texts(buildBannerLines(INFO, 24, { unicode: true }));
  assert.ok(!body.includes("█"));
  assert.ok(!body.includes("/ __ \\"));
  assert.ok(body.includes("Roll Agent v0.14.1"));
});

test("计数为 0 时省略对应信息段", () => {
  const body = texts(
    buildBannerLines({ ...INFO, agentCount: 0, skillCount: 0 }, 120, { unicode: true }),
  );
  assert.ok(!body.includes("agents"));
  assert.ok(!body.includes("skills"));
  assert.ok(body.includes("Roll Agent v0.14.1 · claude-sonnet-5"));
});

test("hints 选项追加提示行", () => {
  const lines = buildBannerLines(INFO, 120, { unicode: true, hints: "/exit 退出" });
  assert.ok(texts(lines).includes("/exit 退出"));
  const noHints = buildBannerLines(INFO, 120, { unicode: true });
  assert.ok(!texts(noHints).includes("/exit 退出"));
});

test("renderBannerText 输出包含全部文本内容", () => {
  const rendered = renderBannerText(buildBannerLines(INFO, 120, { unicode: true }));
  assert.ok(rendered.includes("Roll Agent"));
  assert.ok(rendered.includes("claude-sonnet-5"));
});
