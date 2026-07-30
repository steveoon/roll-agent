#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { format } from "prettier";
import {
  RELAY_MESSAGE_TYPE_VALUES,
  RELAY_MUTATION_REQUEST_METHODS,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHOD_DISPOSITIONS,
  RELAY_REQUEST_METHOD_VALUES,
  RELAY_ERROR_RETRYABILITY,
  relayMessageSchema,
  relayRequestMethodSchemas,
} from "../dist/index.js";
import {
  RELAY_ACK_CONFORMANCE_CASES,
  RELAY_ENCRYPTED_VISIBLE_METADATA_FIELDS,
  RELAY_ERROR_CONFORMANCE_CASES,
  RELAY_FRAME_CONFORMANCE_CASES,
  RELAY_METHOD_REGISTRY_CONFORMANCE_CASES,
  RELAY_METHOD_CONFORMANCE_CASES,
  RELAY_NEGOTIATION_CONFORMANCE_CASES,
  RELAY_REPLAY_CONFORMANCE_CASES,
} from "../dist/conformance.js";
import { z } from "zod/v4";

const schemaDir = resolve(import.meta.dirname, "../dist/schema");
const schemaPath = resolve(schemaDir, "roll-relay-protocol-v1.schema.json");
const fixturesDir = resolve(import.meta.dirname, "../fixtures/v1");
const manifestPath = resolve(fixturesDir, "manifest.json");

async function formatJson(value) {
  return format(JSON.stringify(value, null, 2), { parser: "json" });
}

function definitionPrefix(method) {
  return method
    .split(".")
    .map((part, index) =>
      index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join("");
}

function sharedDefinitionName(name) {
  return `shared${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function rewriteReferences(value, definitionNames, sharedDefinitionNames) {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteReferences(entry, definitionNames, sharedDefinitionNames));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key !== "$ref" || typeof entry !== "string") {
        return [key, rewriteReferences(entry, definitionNames, sharedDefinitionNames)];
      }
      const sharedPrefix = "__shared#/$defs/";
      if (entry.startsWith(sharedPrefix)) {
        const localName = entry.slice(sharedPrefix.length);
        const rootName = sharedDefinitionNames.get(localName);
        if (rootName === undefined) {
          throw new Error(`Unknown shared JSON Schema definition: ${localName}`);
        }
        return [key, `#/$defs/${rootName}`];
      }
      return [key, definitionNames.has(entry) ? `#/$defs/${entry}` : entry];
    }),
  );
}

const schemaEntries = [["relayMessage", relayMessageSchema]];
const methodSchemas = {};
for (const [method, schemas] of Object.entries(relayRequestMethodSchemas)) {
  const prefix = definitionPrefix(method);
  const paramsName = `${prefix}Params`;
  const resultName = `${prefix}Result`;
  schemaEntries.push([paramsName, schemas.params], [resultName, schemas.result]);
  methodSchemas[method] = {
    params: { $ref: `#/$defs/${paramsName}` },
    result: { $ref: `#/$defs/${resultName}` },
  };
}

const registry = z.registry();
for (const [name, entrySchema] of schemaEntries) {
  registry.add(entrySchema, { id: name });
}
const generatedSchemas = z.toJSONSchema(registry, {
  target: "draft-2020-12",
}).schemas;
const definitionNames = new Set(
  Object.keys(generatedSchemas).filter((name) => name !== "__shared"),
);
const sharedDefinitions = generatedSchemas.__shared?.$defs ?? {};
const sharedDefinitionNames = new Map(
  Object.keys(sharedDefinitions).map((name) => [name, sharedDefinitionName(name)]),
);
const definitions = {};
for (const [name, generatedSchema] of Object.entries(generatedSchemas)) {
  if (name === "__shared") {
    continue;
  }
  const { $schema: _schema, ...definition } = generatedSchema;
  definitions[name] = rewriteReferences(definition, definitionNames, sharedDefinitionNames);
}
for (const [name, sharedSchema] of Object.entries(sharedDefinitions)) {
  const rootName = sharedDefinitionNames.get(name);
  if (rootName === undefined || Object.hasOwn(definitions, rootName)) {
    throw new Error(`JSON Schema definition name collision: ${String(rootName)}`);
  }
  definitions[rootName] = rewriteReferences(sharedSchema, definitionNames, sharedDefinitionNames);
}

const relayMessageDefinition = definitions.relayMessage;
if (relayMessageDefinition === undefined) {
  throw new Error("Relay message JSON Schema definition was not generated");
}
const schema = {
  ...relayMessageDefinition,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://roll-agent.dev/schemas/relay-protocol/${RELAY_PROTOCOL_VERSION}`,
  title: `Roll Relay Protocol v${RELAY_PROTOCOL_VERSION}`,
  description: "Versioned Companion Relay frames shared by Browser, Cloud Relay and Companion.",
  $defs: definitions,
  "x-roll-relay-protocol-version": RELAY_PROTOCOL_VERSION,
  "x-roll-message-types": RELAY_MESSAGE_TYPE_VALUES,
  "x-roll-request-methods": RELAY_REQUEST_METHOD_VALUES,
  "x-roll-request-method-dispositions": RELAY_REQUEST_METHOD_DISPOSITIONS,
  "x-roll-mutation-methods": RELAY_MUTATION_REQUEST_METHODS,
  "x-roll-relay-error-retryability": RELAY_ERROR_RETRYABILITY,
  "x-roll-request-method-schemas": methodSchemas,
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const keyword of [
  "x-roll-relay-protocol-version",
  "x-roll-message-types",
  "x-roll-request-methods",
  "x-roll-request-method-dispositions",
  "x-roll-mutation-methods",
  "x-roll-relay-error-retryability",
  "x-roll-request-method-schemas",
]) {
  ajv.addKeyword({ keyword });
}
const validate = ajv.compile(schema);

await mkdir(schemaDir, { recursive: true });
await mkdir(fixturesDir, { recursive: true });
for (const entry of RELAY_FRAME_CONFORMANCE_CASES) {
  const actual = validate(entry.frame);
  if (actual !== entry.valid) {
    throw new Error(
      `JSON Schema case ${entry.id} expected ${String(entry.valid)} but received ` +
        `${String(actual)}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
    );
  }
  await writeFile(resolve(fixturesDir, entry.fixtureName), await formatJson(entry.frame), "utf8");
}

const manifest = {
  protocolVersion: RELAY_PROTOCOL_VERSION,
  frames: RELAY_FRAME_CONFORMANCE_CASES.map(({ id, fixtureName, valid }) => ({
    id,
    fixture: fixtureName,
    valid,
  })),
  negotiation: RELAY_NEGOTIATION_CONFORMANCE_CASES.map(({ id, peerVersions, expected }) => ({
    id,
    peerVersions,
    expected: expected ?? null,
  })),
  methodRegistry: RELAY_METHOD_REGISTRY_CONFORMANCE_CASES.map(({ id, value, expected }) => ({
    id,
    value,
    expected: expected ?? null,
  })),
  methods: RELAY_METHOD_CONFORMANCE_CASES,
  replay: RELAY_REPLAY_CONFORMANCE_CASES,
  ack: RELAY_ACK_CONFORMANCE_CASES,
  errors: RELAY_ERROR_CONFORMANCE_CASES,
  encryptedVisibleMetadataFields: RELAY_ENCRYPTED_VISIBLE_METADATA_FIELDS,
  deferredBreakingRules: [
    "runtime.response-result-xor-error",
    "encrypted-payload-kind-required-metadata",
    "gap-from-not-after-through",
  ],
};

await writeFile(schemaPath, await formatJson(schema), "utf8");
await writeFile(manifestPath, await formatJson(manifest), "utf8");

for (const entry of RELAY_FRAME_CONFORMANCE_CASES) {
  const fixture = JSON.parse(await readFile(resolve(fixturesDir, entry.fixtureName), "utf8"));
  if (validate(fixture) !== entry.valid) {
    throw new Error(`Generated fixture ${entry.fixtureName} does not match its expectation`);
  }
}
