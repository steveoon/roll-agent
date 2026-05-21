#!/usr/bin/env node
/** stdin: browser_status roll stdout. ROLL_BROWSER_INSTANCE names the requested instance. */
import { extractLastJson, readStdinUtf8 } from "./roll-json-extract.mjs";

const requestedInstance = process.env.ROLL_BROWSER_INSTANCE?.trim() ?? "";
const text = await readStdinUtf8();
const jsonText = extractLastJson(text);
if (!jsonText) {
  console.error("browser_status did not return JSON; cannot validate browser instance selection.");
  process.exit(1);
}

let status;
try {
  status = JSON.parse(jsonText);
} catch {
  console.error("browser_status returned invalid JSON; cannot validate browser instance selection.");
  process.exit(1);
}

if (!isRecord(status) || !Array.isArray(status.instances)) {
  console.error("browser_status result must be a JSON object with an instances array.");
  process.exit(1);
}

const instances = status.instances;
const instanceIds = instances
  .map((instance) => (isRecord(instance) && typeof instance.id === "string" ? instance.id : ""))
  .filter(Boolean);

if (requestedInstance) {
  if (instanceIds.length > 0 && !instanceIds.includes(requestedInstance)) {
    console.error(
      `browserInstance "${requestedInstance}" is not declared. Available: ${instanceIds.join(", ")}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const defaultInstanceId =
  typeof status.defaultInstanceId === "string" && status.defaultInstanceId.trim()
    ? status.defaultInstanceId
    : undefined;

if (instanceIds.length > 1 && defaultInstanceId === undefined) {
  console.error(
    `Multiple browser instances are configured (${instanceIds.join(
      ", ",
    )}); pass --browser-instance <id> or configure browser.defaultInstance.`,
  );
  process.exit(1);
}

process.exit(0);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
