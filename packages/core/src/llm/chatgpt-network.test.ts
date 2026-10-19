import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText } from "ai";
import { createChatGptModel } from "./chatgpt-model.ts";

test("an uncertain Responses POST is not replayed by SDK retries and reports safe recovery text", async () => {
  let calls = 0;
  let notices = 0;
  const model = createChatGptModel({
    modelId: "fixture",
    getAccessToken: async () => "synthetic-token",
    onNetworkError: (error) => {
      notices++;
      assert.equal(error.code, "network_error");
    },
    fetch: async () => {
      calls++;
      throw new TypeError("sensitive raw diagnostic", { cause: { code: "ECONNRESET" } });
    },
  });
  await assert.rejects(generateText({ model, prompt: "retained input" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /无法确认请求是否已被接收.*输入已保留/);
    assert.doesNotMatch(error.message, /sensitive|synthetic-token/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(notices, 1);
});
