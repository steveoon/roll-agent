#!/usr/bin/env node
/**
 * stdin: full roll stdout (browser_snapshot). stdout: ref id for the right-panel
 * 「在线简历」 entry; exit 1 when absent. Prefers the depth-0 clickable panel
 * entry (the one that opens the resume dialog) over the header link.
 */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

function findResumeRefInJson(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    const refs = j.snapshot?.refs ?? j.refs ?? [];
    const hits = refs.filter((r) => (r.name ?? "") === "在线简历");
    const preferred = hits.find((r) => r.role === "clickable") ?? hits[0];
    return preferred?.ref ?? "";
  } catch {
    return "";
  }
}

function findResumeRefRegex(text) {
  const m = text.match(/"name"\s*:\s*"在线简历"[\s\S]*?"ref"\s*:\s*"(@[^"]+)"/);
  return m?.[1] ?? "";
}

const text = await readStdinUtf8();
const extracted = extractLastJson(text);
let ref = extracted ? findResumeRefInJson(extracted) : "";
if (!ref) {
  ref = findResumeRefRegex(text);
}
if (ref) {
  process.stdout.write(ref);
  process.exit(0);
}
process.exit(1);
