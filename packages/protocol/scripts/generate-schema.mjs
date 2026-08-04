#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod/v4";
import {
  RUNTIME_EVENT_NOTIFICATION,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SERVER_REQUEST_CANCEL_NOTIFICATION,
  SUPPORTED_RUNTIME_PROTOCOL_VERSIONS,
  getRuntimeProtocolRegistry,
  jsonRpcIdSchema,
  runtimeEventEnvelopeSchema,
  runtimeEventEnvelopeV11Schema,
} from "../dist/index.js";

const schemaDir = resolve(import.meta.dirname, "../dist/schema");
const latestSchemaPath = resolve(schemaDir, "roll-runtime-protocol-v1.schema.json");
const fixtureSuites = [
  {
    directory: resolve(import.meta.dirname, "../fixtures/v1"),
    defaultVersion: "1.1",
  },
  {
    directory: resolve(import.meta.dirname, "../fixtures/v1.2"),
    defaultVersion: "1.2",
  },
];

function versionedSchemaPath(version) {
  return resolve(schemaDir, `roll-runtime-protocol-v${version}.schema.json`);
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

function setProtocolVersionConst(definitions, definitionName, version) {
  const definition = definitions[definitionName];
  const protocolVersion = definition?.properties?.protocolVersion;
  if (protocolVersion === undefined) {
    throw new Error(`Missing ${definitionName}.protocolVersion JSON Schema property`);
  }
  definition.properties.protocolVersion = {
    type: "string",
    const: version,
  };
}

function createProtocolBundle(version) {
  const protocolRegistry = getRuntimeProtocolRegistry(version);
  const eventEnvelopeSchema =
    version === "1.2" ? runtimeEventEnvelopeSchema : runtimeEventEnvelopeV11Schema;
  const schemaEntries = [
    ["jsonRpcId", jsonRpcIdSchema],
    ["runtimeEventEnvelope", eventEnvelopeSchema],
    ["runtimeProtocolErrorData", protocolRegistry.errorDataSchema],
  ];
  if (protocolRegistry.serverRequestCancelParamsSchema !== null) {
    schemaEntries.push([
      "runtimeServerRequestCancelParams",
      protocolRegistry.serverRequestCancelParamsSchema,
    ]);
  }

  for (const [method, schemas] of Object.entries(protocolRegistry.methods)) {
    const prefix = definitionPrefix(method);
    schemaEntries.push([`${prefix}Params`, schemas.params], [`${prefix}Result`, schemas.result]);
  }
  for (const [method, schemas] of Object.entries(protocolRegistry.serverRequests)) {
    const prefix = definitionPrefix(method);
    schemaEntries.push([`${prefix}Params`, schemas.params], [`${prefix}Result`, schemas.result]);
  }

  const zodRegistry = z.registry();
  for (const [name, schema] of schemaEntries) {
    zodRegistry.add(schema, { id: name });
  }
  const generatedSchemas = z.toJSONSchema(zodRegistry, {
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

  setProtocolVersionConst(definitions, "runtimeEventEnvelope", version);
  setProtocolVersionConst(definitions, "initializeResult", version);
  if (version === "1.2") {
    definitions.clientCapabilitiesSetParams.properties.serverRequestMethods.uniqueItems = true;
    definitions.clientCapabilitiesSetResult.properties.acceptedServerRequestMethods.uniqueItems = true;
  }
  if (version === "1.0") {
    definitions.runtimeEventEnvelope.allOf = [
      {
        not: {
          type: "object",
          properties: {
            event: {
              type: "object",
              properties: {
                type: { const: "approval.resolved" },
              },
              required: ["type"],
            },
          },
          required: ["event"],
        },
      },
    ];
  }

  const requestReferences = [];
  const resultReferences = [];
  const serverRequestReferences = [];
  const serverRequestResultReferences = [];
  const methods = {};
  const serverRequestMethods = {};

  for (const method of Object.keys(protocolRegistry.methods)) {
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

  for (const method of Object.keys(protocolRegistry.serverRequests)) {
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
  if (serverRequestReferences.length > 0) {
    definitions.serverRequest = { oneOf: serverRequestReferences };
  }
  definitions.runtimeEventNotification = {
    type: "object",
    properties: {
      jsonrpc: { const: "2.0" },
      method: { const: RUNTIME_EVENT_NOTIFICATION },
      params: { $ref: "#/$defs/runtimeEventEnvelope" },
    },
    required: ["jsonrpc", "method", "params"],
    additionalProperties: false,
  };
  if (protocolRegistry.serverRequestCancelParamsSchema !== null) {
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
  }
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

  const rootReferences = [
    { $ref: "#/$defs/clientRequest" },
    ...(serverRequestReferences.length === 0 ? [] : [{ $ref: "#/$defs/serverRequest" }]),
    { $ref: "#/$defs/runtimeEventNotification" },
    ...(protocolRegistry.serverRequestCancelParamsSchema === null
      ? []
      : [{ $ref: "#/$defs/runtimeServerRequestCancelNotification" }]),
    { $ref: "#/$defs/successResponse" },
    { $ref: "#/$defs/errorResponse" },
  ];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://roll-agent.dev/schemas/runtime-protocol/${version}`,
    title: `Roll Runtime Protocol v${version}`,
    description:
      "Bidirectional JSON-RPC requests, responses, and notifications for Roll Runtime Protocol.",
    oneOf: rootReferences,
    $defs: definitions,
    "x-roll-protocol-version": version,
    "x-roll-methods": methods,
    "x-roll-server-request-methods": serverRequestMethods,
  };
}

function fixtureProtocolVersion(value, defaultVersion) {
  const protocolVersion = value?.params?.protocolVersion;
  return SUPPORTED_RUNTIME_PROTOCOL_VERSIONS.includes(protocolVersion)
    ? protocolVersion
    : defaultVersion;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const keyword of [
  "x-roll-protocol-version",
  "x-roll-methods",
  "x-roll-server-request-methods",
]) {
  ajv.addKeyword({ keyword });
}

const bundles = new Map();
const validators = new Map();
for (const version of SUPPORTED_RUNTIME_PROTOCOL_VERSIONS) {
  const bundle = createProtocolBundle(version);
  bundles.set(version, bundle);
  validators.set(version, ajv.compile(bundle));
}

for (const { directory, defaultVersion } of fixtureSuites) {
  const fixtureNames = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  for (const name of fixtureNames) {
    const value = JSON.parse(await readFile(resolve(directory, name), "utf8"));
    const version = fixtureProtocolVersion(value, defaultVersion);
    const validate = validators.get(version);
    if (validate === undefined) {
      throw new Error(`Missing Runtime Protocol ${version} fixture validator`);
    }
    const expected = name.startsWith("valid-");
    const actual = validate(value);
    if (actual !== expected) {
      throw new Error(
        `JSON Schema ${version} fixture ${name} expected ${String(expected)} but received ` +
          `${String(actual)}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
      );
    }
  }
}

await mkdir(schemaDir, { recursive: true });
for (const [version, bundle] of bundles) {
  await writeFile(versionedSchemaPath(version), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}
const latestBundle = bundles.get(RUNTIME_PROTOCOL_VERSION);
if (latestBundle === undefined) {
  throw new Error(`Missing latest Runtime Protocol ${RUNTIME_PROTOCOL_VERSION} JSON Schema`);
}
await writeFile(latestSchemaPath, `${JSON.stringify(latestBundle, null, 2)}\n`, "utf8");
