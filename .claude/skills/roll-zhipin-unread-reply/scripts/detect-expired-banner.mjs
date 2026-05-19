#!/usr/bin/env node
/** stdin: snapshot or any roll text. stdout: ok | expired (UTF-8 literals live in Node, not PS1). */
import { readStdinUtf8 } from "./roll-json-extract.mjs";

const text = await readStdinUtf8();
if (/沟通职位已到期|职位已到期/.test(text)) {
  process.stdout.write("expired");
} else {
  process.stdout.write("ok");
}
