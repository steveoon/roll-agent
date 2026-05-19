#!/usr/bin/env node
/** stdin: roll stdout with page.url / page.title. stdout: {"url":"","title":""} */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
const empty = JSON.stringify({ url: "", title: "" });
if (!jsonText) {
  process.stdout.write(empty);
  process.exit(0);
}
try {
  const j = JSON.parse(jsonText);
  const url = j.page?.url ?? "";
  const title = j.page?.title ?? "";
  const captcha =
    url.includes("/web/passport/zp/verify.html") || title.includes("安全验证");
  process.stdout.write(JSON.stringify({ url, title, captcha }));
} catch {
  process.stdout.write(JSON.stringify({ url: "", title: "", captcha: false }));
}
