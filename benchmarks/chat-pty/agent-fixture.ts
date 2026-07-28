import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "../../packages/sdk/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StdioServerTransport } from "../../packages/sdk/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "../../packages/sdk/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

interface FixtureOptions {
  readonly name: string;
  readonly delayMs: number;
  readonly lifecycleDir: string;
}

interface LifecycleEvent {
  readonly event: "started" | "list-start" | "list-end" | "exited";
  readonly monotonicNs: string;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseOptions(): FixtureOptions {
  const name = readOption("--name");
  const delayValue = readOption("--delay-ms");
  const lifecycleDir = readOption("--lifecycle-dir");
  const delayMs = Number(delayValue);
  if (
    name === undefined ||
    !/^[a-z0-9-]+$/u.test(name) ||
    delayValue === undefined ||
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    lifecycleDir === undefined
  ) {
    throw new Error(
      "usage: agent-fixture.ts --name <agent-name> --delay-ms <non-negative-int> " +
        "--lifecycle-dir <path>",
    );
  }
  return { name, delayMs, lifecycleDir };
}

const options = parseOptions();
mkdirSync(options.lifecycleDir, { recursive: true });
const lifecyclePath = join(options.lifecycleDir, `${options.name}.json`);
const lifecycleTempPath = `${lifecyclePath}.${String(process.pid)}.tmp`;
const events: LifecycleEvent[] = [];

function record(event: LifecycleEvent["event"]): void {
  events.push({ event, monotonicNs: process.hrtime.bigint().toString() });
  writeFileSync(
    lifecycleTempPath,
    `${JSON.stringify({
      name: options.name,
      pid: process.pid,
      delayMs: options.delayMs,
      toolCount: 1,
      events,
    })}\n`,
    "utf8",
  );
  renameSync(lifecycleTempPath, lifecyclePath);
}

record("started");
process.once("exit", () => record("exited"));

const server = new Server(
  { name: options.name, version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  record("list-start");
  await delay(options.delayMs);
  record("list-end");
  return {
    tools: [
      {
        name: "bootstrap_probe",
        description: `Deterministic bootstrap probe for ${options.name}`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        agent: options.name,
        arguments: request.params.arguments ?? {},
      }),
    },
  ],
}));

await server.connect(new StdioServerTransport());
