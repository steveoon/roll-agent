import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFieldState, formatConfigValue, sameConfigValue } from "./field-presentation.ts";

function envReference(name: string): string {
  return `\${${name}}`;
}

describe("Roll UI field presentation", () => {
  describe("formatConfigValue", () => {
    it("formats empty, scalar and collection values for quick reading", () => {
      assert.equal(formatConfigValue(undefined), "未设置");
      assert.equal(formatConfigValue(null), "空值");
      assert.equal(formatConfigValue(true), "开启");
      assert.equal(formatConfigValue(false), "关闭");
      assert.equal(formatConfigValue(""), "空字符串");
      assert.equal(formatConfigValue(1200), "1,200");
      assert.equal(formatConfigValue([]), "空列表");
      assert.equal(formatConfigValue(["a", "b"]), "2 项");
      assert.equal(formatConfigValue({}), "空对象");
      assert.equal(formatConfigValue({ enabled: true, mode: "safe" }), "2 项配置");
    });

    it("turns millisecond durations into friendly units while retaining the raw value", () => {
      assert.equal(formatConfigValue(500, { widget: "duration" }), "0.5 秒（500 ms）");
      assert.equal(
        formatConfigValue(30_000, { path: ["runtime", "turnTimeoutMs"] }),
        "30 秒（30,000 ms）",
      );
      assert.equal(formatConfigValue(90_000, { widget: "duration" }), "1.5 分钟（90,000 ms）");
      assert.equal(formatConfigValue(7_200_000, { widget: "duration" }), "2 小时（7,200,000 ms）");
    });

    it("turns byte fields into friendly binary units while retaining bytes", () => {
      assert.equal(formatConfigValue(512, { path: ["runtime", "maxCaptureBytes"] }), "512 bytes");
      assert.equal(
        formatConfigValue(1_048_576, { path: ["runtime", "maxCaptureBytes"] }),
        "1 MB（1,048,576 bytes）",
      );
      assert.equal(formatConfigValue(1024, { path: ["runtime", "size"] }), "1,024");
    });

    it("identifies complete environment references without accepting partial strings", () => {
      assert.equal(formatConfigValue(envReference("ROLL_MODE")), "环境变量 ROLL_MODE");
      assert.equal(
        formatConfigValue(`prefix-${envReference("ROLL_MODE")}`),
        `prefix-${envReference("ROLL_MODE")}`,
      );
    });

    it("never exposes secret values or secret environment variable names", () => {
      const literal = formatConfigValue("do-not-show", { secret: true });
      const environment = formatConfigValue(envReference("SECRET_TOKEN"), { secret: true });
      assert.equal(literal, "已填写敏感值");
      assert.equal(environment, "已填写敏感值");
      assert.doesNotMatch(`${literal}${environment}`, /do-not-show|SECRET_TOKEN/u);
      assert.equal(
        formatConfigValue(undefined, { secret: true, configuredSecret: true }),
        "已安全配置",
      );
    });
  });

  describe("describeFieldState", () => {
    const base = {
      configuredSecret: false,
      secret: false,
      required: false,
      widget: "text",
      path: ["runtime", "mode"],
    } as const;

    it("distinguishes a custom value from an inherited default", () => {
      assert.deepEqual(
        describeFieldState({ ...base, present: true, value: "fast", defaultValue: "safe" }),
        {
          currentLabel: "已自定义：fast",
          sourceLabel: "来自 roll.config",
          resetLabel: "恢复默认值",
        },
      );
      assert.deepEqual(
        describeFieldState({ ...base, present: false, value: undefined, defaultValue: "safe" }),
        {
          currentLabel: "使用默认值：safe",
          sourceLabel: "来自内置默认值",
          resetLabel: "恢复默认值",
        },
      );
    });

    it("makes an explicit value equal to the default visible as persisted", () => {
      assert.deepEqual(
        describeFieldState({ ...base, present: true, value: "safe", defaultValue: "safe" }),
        {
          currentLabel: "已自定义：safe",
          sourceLabel: "来自 roll.config（与默认值相同）",
          resetLabel: "恢复默认值",
        },
      );
    });

    it("distinguishes required and optional unset fields", () => {
      assert.deepEqual(describeFieldState({ ...base, present: false, value: undefined }), {
        currentLabel: "未设置",
        sourceLabel: "未写入 roll.config",
        resetLabel: "移除自定义值",
      });
      assert.deepEqual(
        describeFieldState({ ...base, present: false, value: undefined, required: true }),
        {
          currentLabel: "尚未设置（必填）",
          sourceLabel: "需要手动配置",
          resetLabel: "移除自定义值",
        },
      );
    });

    it("describes environment-backed fields without conflating them with literals", () => {
      assert.deepEqual(
        describeFieldState({ ...base, present: true, value: envReference("ROLL_MODE") }),
        {
          currentLabel: "已使用环境变量",
          sourceLabel: "环境变量 ROLL_MODE",
          resetLabel: "移除自定义值",
        },
      );
    });

    it("describes secrets without revealing their content", () => {
      const state = describeFieldState({
        ...base,
        present: true,
        value: "do-not-show",
        configuredSecret: true,
        secret: true,
      });
      assert.deepEqual(state, {
        currentLabel: "已安全配置",
        sourceLabel: "来自 roll.config（内容已隐藏）",
        resetLabel: "清除敏感配置",
      });
      assert.doesNotMatch(JSON.stringify(state), /do-not-show/u);
    });
  });

  describe("sameConfigValue", () => {
    it("compares nested JSON-like values independently of object key order", () => {
      assert.equal(
        sameConfigValue(
          { browser: { enabled: true, names: ["work", "personal"] }, retries: 2 },
          { retries: 2, browser: { names: ["work", "personal"], enabled: true } },
        ),
        true,
      );
    });

    it("detects scalar, array and object shape differences", () => {
      assert.equal(sameConfigValue(0, false), false);
      assert.equal(sameConfigValue([1, 2], [2, 1]), false);
      assert.equal(sameConfigValue({ enabled: true }, { enabled: false }), false);
      assert.equal(sameConfigValue({ value: undefined }, {}), false);
      assert.equal(sameConfigValue(null, {}), false);
    });
  });
});
