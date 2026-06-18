#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function sqliteAvailable() {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function sourceTreeAvailable() {
  return existsSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts"));
}

function hasExecFlag(flag) {
  return process.execArgv.includes(flag);
}

function hasWarningSuppression() {
  return (
    process.execArgv.includes("--no-warnings") ||
    process.execArgv.includes("--disable-warning=ExperimentalWarning")
  );
}

function resolveCommandName(argv) {
  return argv.find((arg) => !arg.startsWith("-"));
}

const commandName = resolveCommandName(process.argv.slice(2));
const shouldEnableSqlite = commandName === "chat";
const hasSqliteFlag = hasExecFlag("--experimental-sqlite");
const needsSqliteFlag = shouldEnableSqlite && !hasSqliteFlag && !(await sqliteAvailable());
const needsTypeStripFlag = sourceTreeAvailable() && !hasExecFlag("--experimental-strip-types");
const needsExperimentalWarningSuppression =
  shouldEnableSqlite && (needsSqliteFlag || hasSqliteFlag) && !hasWarningSuppression();

if (!process.env.ROLL_SQLITE_RESPAWNED && (needsSqliteFlag || needsTypeStripFlag)) {
  const nodeFlags = [
    ...(needsExperimentalWarningSuppression ? ["--disable-warning=ExperimentalWarning"] : []),
    ...(needsSqliteFlag ? ["--experimental-sqlite"] : []),
    ...(needsTypeStripFlag ? ["--experimental-strip-types"] : []),
  ];
  const result = spawnSync(
    process.execPath,
    [...nodeFlags, process.argv[1], ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, ROLL_SQLITE_RESPAWNED: "1" } },
  );
  process.exit(result.status ?? 0);
}

await import("../dist/cli/index.js");
