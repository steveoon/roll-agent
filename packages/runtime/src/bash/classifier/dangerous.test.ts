import { test } from "node:test";
import assert from "node:assert/strict";
import { isDangerous } from "./dangerous.ts";

test("rm -f / -rf 判危险，普通 rm 不判", () => {
  assert.equal(isDangerous(["rm", "-rf", "x"], "linux"), true);
  assert.equal(isDangerous(["rm", "-f", "x"], "linux"), true);
  assert.equal(isDangerous(["rm", "x"], "linux"), false);
  assert.equal(isDangerous(["rm", "-i", "x"], "linux"), false);
});

test("绝对路径 rm 也判危险（basename 归一）", () => {
  assert.equal(isDangerous(["/bin/rm", "-rf", "x"], "linux"), true);
});

test("sudo 剥离后递归判定", () => {
  assert.equal(isDangerous(["sudo", "rm", "-rf", "x"], "linux"), true);
  assert.equal(isDangerous(["sudo", "ls"], "linux"), false);
});

test("其它命令非危险", () => {
  assert.equal(isDangerous(["ls", "-la"], "linux"), false);
  assert.equal(isDangerous([], "linux"), false);
});
