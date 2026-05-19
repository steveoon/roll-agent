#!/usr/bin/env node
/**
 * Read roll CLI stdout from stdin; print the last JSON object or array.
 */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const text = await readStdinUtf8();
const best = extractLastJson(text);
if (!best) {
  console.error(text.slice(-3000));
  process.exit(1);
}
process.stdout.write(best);
