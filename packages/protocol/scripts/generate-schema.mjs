#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";
import {
  RUNTIME_PROTOCOL_VERSION,
  runtimeMethodSchemas,
  runtimeEventEnvelopeSchema,
  runtimeProtocolErrorDataSchema,
} from "../dist/index.js";

const schemaDir = resolve(import.meta.dirname, "../dist/schema");
const schemaPath = resolve(schemaDir, "roll-runtime-protocol-v1.schema.json");

function toDefinition(schema) {
  const { $schema: _schema, ...definition } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
  });
  return definition;
}

function definitionPrefix(method) {
  return method
    .split(".")
    .map((part, index) =>
      index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
    )
    .join("");
}

const definitions = {
  jsonRpcId: {
    oneOf: [{ type: "string" }, { type: "number" }],
  },
  runtimeEventEnvelope: toDefinition(runtimeEventEnvelopeSchema),
  runtimeProtocolErrorData: toDefinition(runtimeProtocolErrorDataSchema),
};
const requestReferences = [];
const resultReferences = [];
const methods = {};

for (const [method, schemas] of Object.entries(runtimeMethodSchemas)) {
  const prefix = definitionPrefix(method);
  const paramsName = `${prefix}Params`;
  const resultName = `${prefix}Result`;
  const requestName = `${prefix}Request`;
  definitions[paramsName] = toDefinition(schemas.params);
  definitions[resultName] = toDefinition(schemas.result);
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

definitions.clientRequest = { oneOf: requestReferences };
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
definitions.successResponse = {
  type: "object",
  properties: {
    jsonrpc: { const: "2.0" },
    id: { $ref: "#/$defs/jsonRpcId" },
    result: { anyOf: resultReferences },
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
  $id: "https://roll-agent.dev/schemas/runtime-protocol/1.0",
  title: "Roll Runtime Protocol v1",
  description:
    "JSON-RPC requests, responses, and runtime.event notifications for Roll Runtime Protocol v1.",
  oneOf: [
    { $ref: "#/$defs/clientRequest" },
    { $ref: "#/$defs/runtimeEventNotification" },
    { $ref: "#/$defs/successResponse" },
    { $ref: "#/$defs/errorResponse" },
  ],
  $defs: definitions,
  "x-roll-protocol-version": RUNTIME_PROTOCOL_VERSION,
  "x-roll-methods": methods,
};

await mkdir(schemaDir, { recursive: true });
await writeFile(schemaPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
