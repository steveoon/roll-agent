import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputSink, partitionModelBudget } from "./output-buffer.ts";

test("帽内全部收集，统计正确", () => {
  const sink = new OutputSink(1024);
  sink.append(Buffer.from("a\nb\nc"));
  const captured = sink.collect();
  assert.equal(captured.text, "a\nb\nc");
  assert.equal(captured.totalBytes, 5);
  assert.equal(captured.totalLines, 3);
  assert.equal(captured.truncated, false);
});

test("超帽后停止存储但继续累加统计", () => {
  const sink = new OutputSink(4);
  sink.append(Buffer.from("abcd"));
  sink.append(Buffer.from("ef\ngh\n"));
  const captured = sink.collect();
  assert.equal(captured.text, "abcd");
  assert.equal(captured.totalBytes, 10);
  assert.equal(captured.totalLines, 2);
  assert.equal(captured.truncated, true);
});

test("单个超帽 chunk 截断到帽边界", () => {
  const sink = new OutputSink(3);
  sink.append(Buffer.from("abcdef"));
  const captured = sink.collect();
  assert.equal(captured.text, "abc");
  assert.equal(captured.totalBytes, 6);
  assert.equal(captured.truncated, true);
});

test("尾部有换行不多算一行", () => {
  const sink = new OutputSink(1024);
  sink.append(Buffer.from("a\nb\n"));
  assert.equal(sink.collect().totalLines, 2);
});

test("空输出行数为 0", () => {
  assert.equal(new OutputSink(16).collect().totalLines, 0);
});

test("partitionModelBudget: stderr 大时占 2/3，stdout 得剩余", () => {
  const budget = partitionModelBudget(300, 1000);
  assert.equal(budget.stderr, 200);
  assert.equal(budget.stdout, 100);
});

test("partitionModelBudget: stderr 小时未用额度回补 stdout", () => {
  const budget = partitionModelBudget(300, 50);
  assert.equal(budget.stderr, 50);
  assert.equal(budget.stdout, 250);
});
