#!/usr/bin/env node
/** argv[2]: bundle file path. argv[3]: send result file path. stdout: { bundle, send } */
import { readFileSync } from "node:fs";

const bundlePath = process.argv[2] ?? "";
const sendResultPath = process.argv[3] ?? "";
if (bundlePath.length === 0 || sendResultPath.length === 0) {
  process.exit(1);
}

try {
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  const send = JSON.parse(readFileSync(sendResultPath, "utf8"));
  process.stdout.write(JSON.stringify({ bundle, send }));
} catch {
  process.exit(2);
}
