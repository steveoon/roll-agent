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
