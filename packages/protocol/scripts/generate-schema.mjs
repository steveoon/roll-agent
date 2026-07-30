#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod/v4";
import {
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  jsonRpcIdSchema,
  runtimeMethodSchemas,
  runtimeEventEnvelopeSchema,
  runtimeProtocolErrorDataSchema,
  runtimeServerRequestCancelParamsSchema,
  runtimeServerRequestSchemas,
} from "../dist/index.js";

const schemaDir = resolve(import.meta.dirname, "../dist/schema");
const schemaPath = resolve(schemaDir, "roll-runtime-protocol-v1.schema.json");
const fixturesDir = resolve(import.meta.dirname, "../fixtures/v1");

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
    return value.map((item) => rewriteReferences(item, definitionNames, sharedDefinitionNames));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key !== "$ref" || typeof item !== "string") {
        return [key, rewriteReferences(item, definitionNames, sharedDefinitionNames)];
      }
      const sharedPrefix = "__shared#/$defs/";
      if (item.startsWith(sharedPrefix)) {
        const localName = item.slice(sharedPrefix.length);
        const rootName = sharedDefinitionNames.get(localName);
        if (rootName === undefined) {
          throw new Error(`Unknown shared JSON Schema definition: ${localName}`);
        }
        return [key, `#/$defs/${rootName}`];
      }
      return [key, definitionNames.has(item) ? `#/$defs/${item}` : item];
    }),
  );
}

const schemaEntries = [
  ["jsonRpcId", jsonRpcIdSchema],
  ["runtimeEventEnvelope", runtimeEventEnvelopeSchema],
  ["runtimeProtocolErrorData", runtimeProtocolErrorDataSchema],
  ["runtimeServerRequestCancelParams", runtimeServerRequestCancelParamsSchema],
];
const requestReferences = [];
const resultReferences = [];
const serverRequestReferences = [];
const serverRequestResultReferences = [];
const methods = {};
const serverRequestMethods = {};

for (const [method, schemas] of Object.entries(runtimeMethodSchemas)) {
  const prefix = definitionPrefix(method);
  schemaEntries.push([`${prefix}Params`, schemas.params], [`${prefix}Result`, schemas.result]);
}

for (const [method, schemas] of Object.entries(runtimeServerRequestSchemas)) {
  const prefix = definitionPrefix(method);
  schemaEntries.push([`${prefix}Params`, schemas.params], [`${prefix}Result`, schemas.result]);
}

const registry = z.registry();
for (const [name, schema] of schemaEntries) {
  registry.add(schema, { id: name });
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
for (const [name, schema] of Object.entries(generatedSchemas)) {
  if (name === "__shared") {
    continue;
  }
  const { $schema: _schema, ...definition } = schema;
  definitions[name] = rewriteReferences(definition, definitionNames, sharedDefinitionNames);
}
for (const [name, schema] of Object.entries(sharedDefinitions)) {
  const rootName = sharedDefinitionNames.get(name);
  if (rootName === undefined || Object.hasOwn(definitions, rootName)) {
    throw new Error(`JSON Schema definition name collision: ${String(rootName)}`);
  }
  definitions[rootName] = rewriteReferences(schema, definitionNames, sharedDefinitionNames);
}
definitions.runtimeEventEnvelope.allOf = [
  {
    not: {
      type: "object",
      properties: {
        protocolVersion: { const: "1.0" },
        event: {
          type: "object",
          properties: {
            type: { const: "approval.resolved" },
          },
          required: ["type"],
        },
      },
      required: ["protocolVersion", "event"],
    },
  },
];
for (const method of Object.keys(runtimeMethodSchemas)) {
  const prefix = definitionPrefix(method);
  const paramsName = `${prefix}Params`;
  const resultName = `${prefix}Result`;
  const requestName = `${prefix}Request`;
  definitions[requestName] = {
    type: "object",
    properties: {
      jsonrpc: { const: "2.0" },
      id: { $ref: "#/$defs/jsonRpcId" },
      method: { const: method },
      params: { $ref: `#/$defs/${paramsName}` },
    },
    required: ["jsonrpc", "id", "method", "params"],
    additionalProperties: false,
  };
  requestReferences.push({ $ref: `#/$defs/${requestName}` });
  resultReferences.push({ $ref: `#/$defs/${resultName}` });
  methods[method] = {
    params: { $ref: `#/$defs/${paramsName}` },
    result: { $ref: `#/$defs/${resultName}` },
    request: { $ref: `#/$defs/${requestName}` },
  };
}

for (const method of Object.keys(runtimeServerRequestSchemas)) {
  const prefix = definitionPrefix(method);
  const paramsName = `${prefix}Params`;
  const resultName = `${prefix}Result`;
  const requestName = `${prefix}ServerRequest`;
  definitions[requestName] = {
    type: "object",
    properties: {
      jsonrpc: { const: "2.0" },
      id: { $ref: "#/$defs/jsonRpcId" },
      method: { const: method },
      params: { $ref: `#/$defs/${paramsName}` },
    },
    required: ["jsonrpc", "id", "method", "params"],
    additionalProperties: false,
  };
  serverRequestReferences.push({ $ref: `#/$defs/${requestName}` });
  serverRequestResultReferences.push({ $ref: `#/$defs/${resultName}` });
  serverRequestMethods[method] = {
    params: { $ref: `#/$defs/${paramsName}` },
    result: { $ref: `#/$defs/${resultName}` },
    request: { $ref: `#/$defs/${requestName}` },
  };
}

definitions.clientRequest = { oneOf: requestReferences };
definitions.serverRequest = { oneOf: serverRequestReferences };
definitions.runtimeEventNotification = {
  type: "object",
  properties: {
    jsonrpc: { const: "2.0" },
    method: { const: "runtime.event" },
    params: { $ref: "#/$defs/runtimeEventEnvelope" },
  },
  required: ["jsonrpc", "method", "params"],
  additionalProperties: false,
};
definitions.runtimeServerRequestCancelNotification = {
  type: "object",
  properties: {
    jsonrpc: { const: "2.0" },
    method: { const: RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION },
    params: { $ref: "#/$defs/runtimeServerRequestCancelParams" },
  },
  required: ["jsonrpc", "method", "params"],
  additionalProperties: false,
};
definitions.successResponse = {
  type: "object",
  properties: {
    jsonrpc: { const: "2.0" },
    id: { $ref: "#/$defs/jsonRpcId" },
    result: { anyOf: [...resultReferences, ...serverRequestResultReferences] },
  },
  required: ["jsonrpc", "id", "result"],
  additionalProperties: false,
};
definitions.errorResponse = {
  type: "object",
  properties: {
    jsonrpc: { const: "2.0" },
    id: {
      oneOf: [{ $ref: "#/$defs/jsonRpcId" }, { type: "null" }],
    },
    error: {
      type: "object",
      properties: {
        code: { type: "integer" },
        message: { type: "string" },
        data: { $ref: "#/$defs/runtimeProtocolErrorData" },
      },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  required: ["jsonrpc", "id", "error"],
  additionalProperties: false,
};

const bundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://roll-agent.dev/schemas/runtime-protocol/${RUNTIME_PROTOCOL_VERSION}`,
  title: `Roll Runtime Protocol v${RUNTIME_PROTOCOL_VERSION}`,
  description:
    "Bidirectional JSON-RPC requests, responses, and notifications for Roll Runtime Protocol.",
  oneOf: [
    { $ref: "#/$defs/clientRequest" },
    { $ref: "#/$defs/serverRequest" },
    { $ref: "#/$defs/runtimeEventNotification" },
    { $ref: "#/$defs/runtimeServerRequestCancelNotification" },
    { $ref: "#/$defs/successResponse" },
    { $ref: "#/$defs/errorResponse" },
  ],
  $defs: definitions,
  "x-roll-protocol-version": RUNTIME_PROTOCOL_VERSION,
  "x-roll-methods": methods,
  "x-roll-server-request-methods": serverRequestMethods,
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const keyword of [
  "x-roll-protocol-version",
  "x-roll-methods",
  "x-roll-server-request-methods",
]) {
  ajv.addKeyword({ keyword });
}
const validate = ajv.compile(bundle);
const fixtureNames = (await readdir(fixturesDir)).filter((name) => name.endsWith(".json")).sort();
for (const name of fixtureNames) {
  const value = JSON.parse(await readFile(resolve(fixturesDir, name), "utf8"));
  const expected = name.startsWith("valid-");
  const actual = validate(value);
  if (actual !== expected) {
    throw new Error(
      `JSON Schema fixture ${name} expected ${String(expected)} but received ${String(actual)}: ` +
        ajv.errorsText(validate.errors, { separator: "; " }),
    );
  }
}

await mkdir(schemaDir, { recursive: true });
await writeFile(schemaPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
