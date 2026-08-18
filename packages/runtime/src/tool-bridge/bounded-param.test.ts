import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  boundedIntParam,
  describeZodIssues,
  friendlyInvalidToolInputMessage,
} from "./bounded-param.ts";

const spec = {
  name: "context",
  min: 0,
  max: 10,
  description: "每处命中前后附带的行数",
  defaultNote: "默认 0",
} as const;

test("schema describe 与校验边界同源派生", () => {
  const param = boundedIntParam(spec);
  const described = param.schema.description ?? "";
  assert.ok(described.includes("范围 0-10"));
  assert.ok(described.includes("默认 0"));
  assert.ok(described.includes("每处命中前后附带的行数"));
});

test("schema 保留 JSON schema 边界（min/max/int）", () => {
  const param = boundedIntParam(spec);
  assert.equal(param.schema.safeParse(undefined).success, true);
  assert.equal(param.schema.safeParse(0).success, true);
  assert.equal(param.schema.safeParse(10).success, true);
  assert.equal(param.schema.safeParse(18).success, false);
  assert.equal(param.schema.safeParse(-1).success, false);
  assert.equal(param.schema.safeParse(2.5).success, false);
});

test("describeZodIssues 一句话说清参数、边界与所传值", () => {
  const param = boundedIntParam(spec);
  const objectSchema = z.object({ context: param.schema });
  const parsed = objectSchema.safeParse({ context: 18 });
  assert.equal(parsed.success, false);
  if (parsed.success) {
    return;
  }
  const message = describeZodIssues(parsed.error, { context: 18 }) ?? "";
  assert.ok(message.includes("context"));
  assert.ok(message.includes("≤10"));
  assert.ok(message.includes("18"));
});

test("describeZodIssues 对 too_small 给出下界", () => {
  const objectSchema = z.object({ max_results: z.number().int().min(1) });
  const parsed = objectSchema.safeParse({ max_results: 0 });
  assert.equal(parsed.success, false);
  if (parsed.success) {
    return;
  }
  const message = describeZodIssues(parsed.error, { max_results: 0 }) ?? "";
  assert.ok(message.includes("max_results"));
  assert.ok(message.includes("≥1"));
  assert.ok(message.includes("0"));
});

test("friendlyInvalidToolInputMessage 从 SDK 风格错误提取友好文案", () => {
  const param = boundedIntParam(spec);
  const objectSchema = z.object({ context: param.schema });
  const parsed = objectSchema.safeParse({ context: 18 });
  assert.equal(parsed.success, false);
  if (parsed.success) {
    return;
  }
  const sdkLike = { toolInput: JSON.stringify({ context: 18 }), cause: parsed.error };
  const message = friendlyInvalidToolInputMessage(sdkLike) ?? "";
  assert.ok(message.includes("context"));
  assert.ok(message.includes("≤10"));
  assert.ok(message.includes("18"));
});

test("friendlyInvalidToolInputMessage 对无法结构化的错误返回 undefined", () => {
  assert.equal(friendlyInvalidToolInputMessage(new Error("boom")), undefined);
  assert.equal(friendlyInvalidToolInputMessage("AI_InvalidToolInputError: x"), undefined);
});
