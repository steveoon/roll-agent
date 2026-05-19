#!/usr/bin/env node
/**
 * stdin: full roll stdout (e.g. browser_snapshot). stdout: ref id for 未读 tab, exit 1 if missing.
 * Uses extract-roll-json first; regex fallback when snapshot JSON is truncated/invalid (#6).
 */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

function findUnreadRefInJson(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    const refs = j.snapshot?.refs ?? j.refs ?? [];
    const hit = refs.find(
      (r) => r.name === "未读" || String(r.name ?? "").includes("未读"),
    );
    return hit?.ref ?? "";
  } catch {
    return "";
  }
}

function findUnreadRefRegex(text) {
  const m = text.match(/"name"\s*:\s*"[^"]*未读[^"]*"[\s\S]*?"ref"\s*:\s*"(@[^"]+)"/);
  return m?.[1] ?? "";
}

const text = await readStdinUtf8();
const extracted = extractLastJson(text);
let ref = extracted ? findUnreadRefInJson(extracted) : "";
if (!ref) {
  ref = findUnreadRefRegex(text);
}
if (ref) {
  process.stdout.write(ref);
  process.exit(0);
}
process.exit(1);
