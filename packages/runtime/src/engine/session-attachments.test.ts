import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUserMessageContent,
  normalizeSessionSendInput,
  redactBinaryPartsForEvidence,
} from "./session-attachments.ts";

test("normalizeSessionSendInput 把纯字符串输入归一为无附件请求", () => {
  assert.deepEqual(normalizeSessionSendInput("你好"), { text: "你好", attachments: [] });
});

test("normalizeSessionSendInput 保留结构化输入的附件", () => {
  const normalized = normalizeSessionSendInput({
    text: "看下这张截图",
    attachments: [{ data: "aGVsbG8=", mediaType: "image/png" }],
  });
  assert.deepEqual(normalized, {
    text: "看下这张截图",
    attachments: [{ data: "aGVsbG8=", mediaType: "image/png" }],
  });
});

test("normalizeSessionSendInput 拒绝空 data 与无效 mediaType", () => {
  assert.throws(
    () =>
      normalizeSessionSendInput({
        text: "x",
        attachments: [{ data: "", mediaType: "image/png" }],
      }),
    /data 不能为空/u,
  );
  assert.throws(
    () =>
      normalizeSessionSendInput({
        text: "x",
        attachments: [{ data: "aGVsbG8=", mediaType: "png" }],
      }),
    /mediaType 无效/u,
  );
});

test("buildUserMessageContent 无附件时保持字符串 content", () => {
  assert.equal(buildUserMessageContent("你好", []), "你好");
});

test("buildUserMessageContent 带附件时产出 text 在前的 parts 数组", () => {
  assert.deepEqual(
    buildUserMessageContent("看下这张截图", [
      { data: "aGVsbG8=", mediaType: "image/png" },
      { data: "d29ybGQ=", mediaType: "image/jpeg" },
    ]),
    [
      { type: "text", text: "看下这张截图" },
      { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
      { type: "file", data: "d29ybGQ=", mediaType: "image/jpeg" },
    ],
  );
});

test("buildUserMessageContent 空文本纯附件时省略 text part", () => {
  assert.deepEqual(buildUserMessageContent("", [{ data: "aGVsbG8=", mediaType: "image/png" }]), [
    { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
  ]);
});

test("redactBinaryPartsForEvidence 抹掉用户消息 file part 的内联数据", () => {
  const redacted = redactBinaryPartsForEvidence([
    { type: "text", text: "看下这张截图" },
    { type: "file", data: "aGVsbG8=".repeat(1000), mediaType: "image/png" },
    { type: "image", image: new Uint8Array([1, 2, 3]) },
  ]);
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /aGVsbG8=/u);
  assert.match(serialized, /看下这张截图/u);
  assert.match(serialized, /image\/png/u);
  assert.match(serialized, /\[二进制数据已省略\]/u);
});

test("redactBinaryPartsForEvidence 递归抹掉 tool-result 输出里的图像数据", () => {
  const redacted = redactBinaryPartsForEvidence([
    {
      type: "tool-result",
      toolName: "zhipin_capture_resume",
      output: {
        type: "content",
        value: [
          { type: "text", text: "ok" },
          { type: "file", data: { type: "data", data: "aGVsbG8=" }, mediaType: "image/png" },
          { type: "media", data: "d29ybGQ=", mediaType: "image/jpeg" },
        ],
      },
    },
  ]);
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /aGVsbG8=|d29ybGQ=/u);
  assert.match(serialized, /"ok"/u);
  assert.match(serialized, /\[二进制数据已省略\]/u);
});

test("redactBinaryPartsForEvidence 保留 URL 型 file part 与未知 part", () => {
  const url = new URL("https://example.com/a.png");
  const parts = [
    { type: "file", data: url, mediaType: "image/png" },
    { type: "reasoning", text: "thinking" },
  ];
  const redacted = redactBinaryPartsForEvidence(parts);
  assert.deepEqual(redacted, parts);
});
