#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { format } from "prettier";
import {
  LATEST_RELAY_PROTOCOL_VERSION,
  RELAY_ERROR_RETRYABILITY,
  RELAY_MESSAGE_TYPE_VALUES,
  RELAY_MESSAGE_TYPE_VALUES_V11,
  RELAY_MUTATION_REQUEST_METHODS,
  RELAY_MUTATION_REQUEST_METHODS_V11,
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_METHOD_DISPOSITIONS,
  RELAY_REQUEST_METHOD_DISPOSITIONS_V11,
  RELAY_REQUEST_METHOD_VALUES,
  RELAY_REQUEST_METHOD_VALUES_V11,
  relayMessageSchema,
  relayMessageSchemaV11,
  relayRequestMethodSchemas,
  relayRequestMethodSchemasV11,
} from "../dist/index.js";
import {
  RELAY_ACK_CONFORMANCE_CASES,
  RELAY_ENCRYPTED_VISIBLE_METADATA_FIELDS,
  RELAY_ERROR_CONFORMANCE_CASES,
  RELAY_FRAME_CONFORMANCE_CASES,
  RELAY_FRAME_CONFORMANCE_CASES_V11,
  RELAY_METHOD_REGISTRY_CONFORMANCE_CASES,
  RELAY_METHOD_REGISTRY_CONFORMANCE_CASES_V11,
  RELAY_METHOD_CONFORMANCE_CASES,
  RELAY_METHOD_CONFORMANCE_CASES_V11,
  RELAY_NEGOTIATION_CONFORMANCE_CASES,
  RELAY_NEGOTIATION_CONFORMANCE_CASES_V11,
  RELAY_REPLAY_CONFORMANCE_CASES,
  RELAY_REPLAY_CONFORMANCE_CASES_V11,
} from "../dist/conformance.js";
import { z } from "zod/v4";

const schemaDir = resolve(import.meta.dirname, "../dist/schema");
const frozenSchemaHashes = {
  "1.0": "d6417ea791f754776fa0c2bedaaadf30e609d57bf276642e2bd2290eb7f61f21",
  1.1: "0523ac0e41dcd4e298e86dea3b432858af9b4746af9c3a3ebf10fbd9ac1e898a",
};

const frozenV1FixtureHashes = {
  "invalid-encrypted-metadata-leak.json":
    "3186a9ce85581f8ac0896366cef7bf8a750e8dcd73fd13bcf46d6bd1370d9512",
  "invalid-extra-field.json": "f5841a471ebd17c498986c67e1306d78729fea4d7cf8a0962ae6b06c194a6650",
  "invalid-gap-recovery.json": "d349054ccb89bb407f376759631fc5b63f1fcf9476a9f3aedd7c2d5a5b9989db",
  "invalid-request-id.json": "86c4e8ea0949bf9c58f4e7525abd9b093df6a7a22b2895200175cf3c856259a6",
  "invalid-unknown-message.json":
    "a3211c5cd2df3a685979a68e7173bf3e51d6746ffdd463223541200845b4fea3",
  "invalid-unknown-method.json": "a8ffa99c6727835a032d7c91997e57d294eb223a05d581bf7d2e3d9bf0463d3a",
  "invalid-unknown-version.json":
    "4614ad82720764acefbd25b03b7b51cfa76a630a889d60e3c5a1fa1a1023e9f5",
  "manifest.json": "646c5360ebf73c1b3cf3f248be5035ca15d5eae416e43cc7fa86b504a34cdada",
  "valid-device-connect.json": "104c68bffcca4a9f2fbae23949858dd7243ef34a3d8e17bcd58e6f4773fa7cce",
  "valid-runtime-ack.json": "86f619ecd7b5cc25036a7e02d2a6521e00a1773bd9037e10d68fbc92eb58b788",
  "valid-runtime-encrypted.json":
    "6ae5833e88a2d56647fb38487974249ccbe02bab33fc5f7dc8ed41bedc1b71db",
  "valid-runtime-event.json": "327cf8145a790701d56fa892a363bac7df5b754fae814c1a51b113222580a7b9",
  "valid-runtime-gap.json": "a1529eeea8646d0a218a804d6265982c762b03f4f1f25297271c7b03ddb16186",
  "valid-runtime-request.json": "3ce02f3e263a67d0f4765ef2018bda62c4df2453f2a8d69f6b91aff8d2dacb55",
  "valid-runtime-response.json": "127399593a6484fa158c52e7ed048500a1f0e35142ffba0da0a85bf430f96c23",
};

const protocolConfigs = [
  {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    schemaFileName: "roll-relay-protocol-v1.schema.json",
    fixturesVersion: "v1",
    frozenFixtures: true,
    messageTypes: RELAY_MESSAGE_TYPE_VALUES,
    mutationMethods: RELAY_MUTATION_REQUEST_METHODS,
    requestMethodDispositions: RELAY_REQUEST_METHOD_DISPOSITIONS,
    requestMethods: RELAY_REQUEST_METHOD_VALUES,
    messageSchema: relayMessageSchema,
    requestMethodSchemas: relayRequestMethodSchemas,
    frameCases: RELAY_FRAME_CONFORMANCE_CASES,
    negotiationCases: RELAY_NEGOTIATION_CONFORMANCE_CASES,
    methodRegistryCases: RELAY_METHOD_REGISTRY_CONFORMANCE_CASES,
    methodCases: RELAY_METHOD_CONFORMANCE_CASES,
    replayCases: RELAY_REPLAY_CONFORMANCE_CASES,
  },
  {
    protocolVersion: LATEST_RELAY_PROTOCOL_VERSION,
    schemaFileName: "roll-relay-protocol-v1.1.schema.json",
    fixturesVersion: "v1.1",
    frozenFixtures: false,
    messageTypes: RELAY_MESSAGE_TYPE_VALUES_V11,
    mutationMethods: RELAY_MUTATION_REQUEST_METHODS_V11,
    requestMethodDispositions: RELAY_REQUEST_METHOD_DISPOSITIONS_V11,
    requestMethods: RELAY_REQUEST_METHOD_VALUES_V11,
    messageSchema: relayMessageSchemaV11,
    requestMethodSchemas: relayRequestMethodSchemasV11,
    frameCases: RELAY_FRAME_CONFORMANCE_CASES_V11,
    negotiationCases: RELAY_NEGOTIATION_CONFORMANCE_CASES_V11,
    methodRegistryCases: RELAY_METHOD_REGISTRY_CONFORMANCE_CASES_V11,
    methodCases: RELAY_METHOD_CONFORMANCE_CASES_V11,
    replayCases: RELAY_REPLAY_CONFORMANCE_CASES_V11,
  },
];

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

function generateSchema(config) {
  const schemaEntries = [["relayMessage", config.messageSchema]];
  const methodSchemas = {};
  for (const [method, schemas] of Object.entries(config.requestMethodSchemas)) {
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
  return {
    ...relayMessageDefinition,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://roll-agent.dev/schemas/relay-protocol/${config.protocolVersion}`,
    title: `Roll Relay Protocol v${config.protocolVersion}`,
    description: "Versioned Companion Relay frames shared by Browser, Cloud Relay and Companion.",
    $defs: definitions,
    "x-roll-relay-protocol-version": config.protocolVersion,
    "x-roll-message-types": config.messageTypes,
    "x-roll-request-methods": config.requestMethods,
    "x-roll-request-method-dispositions": config.requestMethodDispositions,
    "x-roll-mutation-methods": config.mutationMethods,
    "x-roll-relay-error-retryability": RELAY_ERROR_RETRYABILITY,
    "x-roll-request-method-schemas": methodSchemas,
  };
}

function createValidator(schema) {
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
  return { ajv, validate: ajv.compile(schema) };
}

function verifyFrozenSchema(protocolVersion, contents) {
  const expectedHash = frozenSchemaHashes[protocolVersion];
  if (expectedHash === undefined) {
    throw new Error(`Missing frozen JSON Schema hash for Relay Wire ${protocolVersion}`);
  }
  const actualHash = createHash("sha256").update(contents).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `Frozen Relay Wire ${protocolVersion} JSON Schema changed: expected ${expectedHash}, ` +
        `received ${actualHash}`,
    );
  }
}

function createManifest(config) {
  return {
    protocolVersion: config.protocolVersion,
    frames: config.frameCases.map(({ id, fixtureName, valid }) => ({
      id,
      fixture: fixtureName,
      valid,
    })),
    negotiation: config.negotiationCases.map(({ id, peerVersions, expected }) => ({
      id,
      peerVersions,
      expected: expected ?? null,
    })),
    methodRegistry: config.methodRegistryCases.map(({ id, value, expected }) => ({
      id,
      value,
      expected: expected ?? null,
    })),
    methods: config.methodCases,
    replay: config.replayCases,
    ack: RELAY_ACK_CONFORMANCE_CASES,
    errors: RELAY_ERROR_CONFORMANCE_CASES,
    encryptedVisibleMetadataFields: RELAY_ENCRYPTED_VISIBLE_METADATA_FIELDS,
    deferredBreakingRules: [
      "runtime.response-result-xor-error",
      "encrypted-payload-kind-required-metadata",
      "gap-from-not-after-through",
    ],
  };
}

function assertFrameCase(validate, ajv, entry, context) {
  const actual = validate(entry.frame);
  if (actual !== entry.valid) {
    throw new Error(
      `${context} case ${entry.id} expected ${String(entry.valid)} but received ` +
        `${String(actual)}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
    );
  }
}

async function verifyFrozenV1File(fixturesDir, fileName, expectedContents) {
  const actualContents = await readFile(resolve(fixturesDir, fileName));
  const expectedBytes = Buffer.from(expectedContents, "utf8");
  const actualHash = createHash("sha256").update(actualContents).digest("hex");
  const expectedHash = frozenV1FixtureHashes[fileName];
  if (expectedHash === undefined || actualHash !== expectedHash) {
    throw new Error(
      `Frozen Relay Wire 1.0 fixture ${fileName} changed: expected ${String(expectedHash)}, ` +
        `received ${actualHash}`,
    );
  }
  if (!actualContents.equals(expectedBytes)) {
    throw new Error(
      `Frozen Relay Wire 1.0 fixture ${fileName} no longer matches its conformance case`,
    );
  }
}

async function writeOrVerifyFixtures(config, validate, ajv) {
  const fixturesDir = resolve(import.meta.dirname, `../fixtures/${config.fixturesVersion}`);
  if (config.frozenFixtures) {
    const actualFileNames = (await readdir(fixturesDir)).toSorted();
    const expectedFileNames = Object.keys(frozenV1FixtureHashes).toSorted();
    if (JSON.stringify(actualFileNames) !== JSON.stringify(expectedFileNames)) {
      throw new Error(
        `Frozen Relay Wire 1.0 fixture registry changed: expected ${expectedFileNames.join(", ")}, ` +
          `received ${actualFileNames.join(", ")}`,
      );
    }
  } else {
    await mkdir(fixturesDir, { recursive: true });
  }

  for (const entry of config.frameCases) {
    assertFrameCase(validate, ajv, entry, `JSON Schema ${config.protocolVersion}`);
    const contents = await formatJson(entry.frame);
    if (config.frozenFixtures) {
      await verifyFrozenV1File(fixturesDir, entry.fixtureName, contents);
    } else {
      await writeFile(resolve(fixturesDir, entry.fixtureName), contents, "utf8");
    }
  }

  const manifestContents = await formatJson(createManifest(config));
  if (config.frozenFixtures) {
    await verifyFrozenV1File(fixturesDir, "manifest.json", manifestContents);
  } else {
    await writeFile(resolve(fixturesDir, "manifest.json"), manifestContents, "utf8");
  }

  for (const entry of config.frameCases) {
    const fixture = JSON.parse(await readFile(resolve(fixturesDir, entry.fixtureName), "utf8"));
    if (validate(fixture) !== entry.valid) {
      throw new Error(
        `${config.protocolVersion} fixture ${entry.fixtureName} does not match its expectation`,
      );
    }
  }
}

if (RELAY_PROTOCOL_VERSION !== "1.0" || LATEST_RELAY_PROTOCOL_VERSION !== "1.1") {
  throw new Error(
    "Schema generator version registry must be reviewed for a Relay Wire version change",
  );
}

await mkdir(schemaDir, { recursive: true });
for (const config of protocolConfigs) {
  const schema = generateSchema(config);
  const { ajv, validate } = createValidator(schema);
  const schemaContents = await formatJson(schema);
  verifyFrozenSchema(config.protocolVersion, schemaContents);
  await writeFile(resolve(schemaDir, config.schemaFileName), schemaContents, "utf8");
  await writeOrVerifyFixtures(config, validate, ajv);
}
