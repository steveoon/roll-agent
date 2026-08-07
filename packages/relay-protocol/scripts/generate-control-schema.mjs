#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { format } from "prettier";
import { z } from "zod/v4";
import {
  RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION,
  RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION,
  RELAY_CONTROL_VERSION,
  RELAY_WSS_DIRECTIONS,
  relayBrowserControlMessageSchema,
  relayBrowserFirstControlFrameSchema,
  relaySessionDescriptorSchema,
} from "../dist/control.js";

const schemaDir = resolve(import.meta.dirname, "../dist/schema");
const fixturesDir = resolve(import.meta.dirname, "../fixtures/control/v1.0");

async function formatJson(value) {
  return format(JSON.stringify(value, null, 2), { parser: "json" });
}

function generateJsonSchema(schema, metadata) {
  return {
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...metadata,
  };
}

function createValidator(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return { ajv, validate: ajv.compile(schema) };
}

function assertFixture(validate, ajv, fixture, expected, context) {
  const actual = validate(fixture);
  if (actual !== expected) {
    throw new Error(
      `${context} expected ${String(expected)} but received ${String(actual)}: ` +
        ajv.errorsText(validate.errors, { separator: "; " }),
    );
  }
}

if (RELAY_CONTROL_VERSION !== "1.0") {
  throw new Error("Control schema generator must be reviewed for a Control version change");
}

const controlSchema = generateJsonSchema(relayBrowserControlMessageSchema, {
  $id: "urn:roll-agent:schema:relay-control:1.0",
  title: "Roll Relay Browser Control v1.0",
  description: "Relay-to-Browser session and workspace control messages.",
  "x-roll-control-version": RELAY_CONTROL_VERSION,
  "x-roll-browser-first-message-type": "session.ready",
  "x-roll-browser-message-types-by-direction": RELAY_BROWSER_WSS_MESSAGE_TYPES_BY_DIRECTION,
  "x-roll-companion-message-types-by-direction": RELAY_COMPANION_WSS_MESSAGE_TYPES_BY_DIRECTION,
  "x-roll-wss-directions": RELAY_WSS_DIRECTIONS,
});
const sessionSchema = generateJsonSchema(relaySessionDescriptorSchema, {
  $id: "urn:roll-agent:schema:relay-browser-session:1.0",
  title: "Roll Relay Browser Session Descriptor v1.0",
  description: "Short-lived single-use Browser WebSocket connection descriptor.",
  "x-roll-control-version": RELAY_CONTROL_VERSION,
});

await mkdir(schemaDir, { recursive: true });
await writeFile(
  resolve(schemaDir, "roll-relay-control-v1.schema.json"),
  await formatJson(controlSchema),
  "utf8",
);
await writeFile(
  resolve(schemaDir, "roll-relay-browser-session-v1.schema.json"),
  await formatJson(sessionSchema),
  "utf8",
);

const manifest = JSON.parse(await readFile(resolve(fixturesDir, "manifest.json"), "utf8"));
const { ajv: controlAjv, validate: validateControl } = createValidator(controlSchema);
const { ajv: sessionAjv, validate: validateSession } = createValidator(sessionSchema);

for (const entry of manifest.messages) {
  const fixture = JSON.parse(await readFile(resolve(fixturesDir, entry.fixture), "utf8"));
  assertFixture(validateControl, controlAjv, fixture, entry.valid, `Control ${entry.fixture}`);
  const firstFrameValid = relayBrowserFirstControlFrameSchema.safeParse(fixture).success;
  if (firstFrameValid !== entry.validFirstFrame) {
    throw new Error(
      `Control ${entry.fixture} first-frame expectation was ${String(entry.validFirstFrame)} ` +
        `but received ${String(firstFrameValid)}`,
    );
  }
}

for (const entry of manifest.sessions) {
  const fixture = JSON.parse(await readFile(resolve(fixturesDir, entry.fixture), "utf8"));
  assertFixture(validateSession, sessionAjv, fixture, entry.valid, `Session ${entry.fixture}`);
}
