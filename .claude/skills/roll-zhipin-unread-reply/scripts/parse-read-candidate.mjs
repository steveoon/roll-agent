#!/usr/bin/env node
/** stdin: zhipin_read_messages roll stdout. stdout: one candidate JSON; exit 2 if empty list. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  process.exit(1);
}
let j;
try {
  j = JSON.parse(jsonText);
} catch {
  process.exit(1);
}
const c = (j.candidates ?? [])[0];
if (!c?.conversationId) {
  process.exit(2);
}
process.stdout.write(
  JSON.stringify({
    conversationId: c.conversationId,
    name: c.name ?? "",
    preview: c.preview ?? "",
    pageUrl: j.page?.url ?? "",
    pageTitle: j.page?.title ?? "",
  }),
);
