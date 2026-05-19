#!/usr/bin/env node
/** stdin: roll agent health --json stdout. REPLY_AGENT env names the agent. exit 0 if healthy. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const agentName = process.env.REPLY_AGENT ?? "";
const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.exit(1);
}
let rows;
try {
  rows = JSON.parse(jsonText);
} catch {
  process.exit(1);
}
if (!Array.isArray(rows)) {
  process.exit(1);
}
const row = rows.find((r) => r.agentName === agentName);
process.exit(row?.healthy === true ? 0 : 1);
