#!/usr/bin/env node
/** stdin: roll stdout with page.url / page.title. stdout: {"url":"","title":"","captcha":false,"blocked":false} */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";
import { classifyZhipinRiskPage } from "./risk-paths.mjs";

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
const empty = JSON.stringify({ url: "", title: "", captcha: false, blocked: false });
if (!jsonText) {
  process.stdout.write(empty);
  process.exit(0);
}
try {
  const j = JSON.parse(jsonText);
  const url = j.page?.url ?? "";
  const title = j.page?.title ?? "";
  const hit = classifyZhipinRiskPage(url, title);
  const captcha = hit?.kind === "verify";
  const blocked = hit !== null;
  process.stdout.write(JSON.stringify({ url, title, captcha, blocked }));
} catch {
  process.stdout.write(JSON.stringify({ url: "", title: "", captcha: false, blocked: false }));
}
