import { test } from "node:test";
import assert from "node:assert/strict";
import { tool } from "ai";
import { z } from "zod";
import {
  CAPABILITY_APPROVAL_MODES,
  CAPABILITY_HOST_MODES,
  CAPABILITY_MANIFEST_VERSION,
  CAPABILITY_SESSION_DURABILITIES,
  CAPABILITY_SESSION_EXEC_LIFECYCLES,
  CAPABILITY_TOOL_ROLES,
  CAPABILITY_TOOL_SOURCE_KINDS,
  buildEffectiveCapabilityTurnContext,
  buildEffectiveCapabilityManifest,
  createSafeCapabilitySnapshot,
  findCapabilityToolId,
  listCapabilityToolIds,
} from "./capability-manifest.ts";

test("effective capability manifest derives names and schemas from the final toolset", () => {
  const tools = {
    roll__skill_1: tool({
      description: "Load a skill",
      inputSchema: z.object({ name: z.string() }),
      execute: ({ name }) => Promise.resolve(name),
    }),
    browser__click: tool({
      description: "Click a browser element",
      inputSchema: z.object({ ref: z.string() }),
      execute: ({ ref }) => Promise.resolve(ref),
    }),
  };
  const routes = {
    roll__skill_1: { agentName: "roll", toolName: "skill" },
    browser__click: {
      agentName: "browser",
      toolName: "click",
      agentSource: "git",
      transport: "streamable-http",
      runtimeOwnership: "external-managed",
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  } as const;

  const manifest = buildEffectiveCapabilityManifest({
    tools,
    toolRoles: {
      roll__skill_1: CAPABILITY_TOOL_ROLES.skill,
      browser__click: CAPABILITY_TOOL_ROLES.agent,
    },
    resolveRoute: (id) => routes[id as keyof typeof routes],
    skills: [{ name: "review", description: "Review code", source: "project" }],
    agentCount: 1,
    profile: "posix",
    cwd: "/workspace",
    platform: "linux",
  });

  assert.equal(manifest.version, CAPABILITY_MANIFEST_VERSION);
  assert.equal(manifest.audience, "roll-chat");
  assert.equal(manifest.lifecycle.hostMode, CAPABILITY_HOST_MODES.embedded);
  assert.equal(manifest.dynamicContext.cwd, "/workspace");
  assert.equal(findCapabilityToolId(manifest, CAPABILITY_TOOL_ROLES.skill), "roll__skill_1");
  assert.deepEqual(listCapabilityToolIds(manifest, CAPABILITY_TOOL_ROLES.agent), [
    "browser__click",
  ]);

  const skill = manifest.tools.find((entry) => entry.id === "roll__skill_1");
  assert.equal(skill?.toolName, "skill");
  assert.equal(skill?.source, CAPABILITY_TOOL_SOURCE_KINDS.builtIn);
  assert.equal(skill?.approval, CAPABILITY_APPROVAL_MODES.readOnly);
  assert.deepEqual(skill?.inputSchema, {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  });
  const browser = manifest.tools.find((entry) => entry.id === "browser__click");
  assert.equal(browser?.source, "git");
  assert.equal(browser?.transport, "streamable-http");
  assert.equal(browser?.runtimeOwnership, "external-managed");
  assert.deepEqual(browser?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
  });
  assert.equal(manifest.lifecycle.sessionExec, CAPABILITY_SESSION_EXEC_LIFECYCLES.unavailable);
  assert.doesNotMatch(JSON.stringify(manifest), /execute/u);
});

test("manifest fails closed when the finalized toolset has no matching route", () => {
  assert.throws(
    () =>
      buildEffectiveCapabilityManifest({
        tools: {
          orphan: tool({
            inputSchema: z.object({}),
            execute: () => Promise.resolve("ok"),
          }),
        },
        toolRoles: {},
        resolveRoute: () => undefined,
        skills: [],
        agentCount: 0,
        profile: "test",
        cwd: "/tmp",
      }),
    /orphan/u,
  );
});

test("manifest fails closed when a finalized tool has no explicit capability role", () => {
  assert.throws(
    () =>
      buildEffectiveCapabilityManifest({
        tools: {
          orphan: tool({
            inputSchema: z.object({}),
            execute: () => Promise.resolve("ok"),
          }),
        },
        toolRoles: {},
        resolveRoute: () => ({ agentName: "demo", toolName: "orphan" }),
        skills: [],
        agentCount: 1,
        profile: "test",
        cwd: "/tmp",
      }),
    /orphan.*capability role/u,
  );
});

test("manifest declares resumable session lifecycle only when the complete exec trio exists", () => {
  const makeTool = () =>
    tool({
      inputSchema: z.object({}),
      execute: () => Promise.resolve("ok"),
    });
  const tools = {
    command: makeTool(),
    poll: makeTool(),
    list: makeTool(),
  };
  const roles = {
    command: CAPABILITY_TOOL_ROLES.sessionCommand,
    poll: CAPABILITY_TOOL_ROLES.sessionPoll,
    list: CAPABILITY_TOOL_ROLES.sessionList,
  } as const;

  const manifest = buildEffectiveCapabilityManifest({
    tools,
    toolRoles: roles,
    resolveRoute: (id) => ({ agentName: "roll", toolName: id }),
    skills: [],
    agentCount: 0,
    profile: "test",
    hostMode: CAPABILITY_HOST_MODES.oneShot,
    cwd: "/tmp",
  });

  assert.equal(manifest.lifecycle.manifest, "session-snapshot");
  assert.equal(manifest.lifecycle.turnContext, "per-turn");
  assert.equal(manifest.lifecycle.hostMode, CAPABILITY_HOST_MODES.oneShot);
  assert.equal(manifest.lifecycle.sessionExec, CAPABILITY_SESSION_EXEC_LIFECYCLES.resumable);
  assert.equal(manifest.lifecycle.sessionDurability, CAPABILITY_SESSION_DURABILITIES.processLocal);
  assert.deepEqual(buildEffectiveCapabilityTurnContext(manifest).lifecycle, manifest.lifecycle);
});

test("turn context 使用运行主机本地日期而不是 UTC 日期", () => {
  class LocalBoundaryDate extends Date {
    override getFullYear(): number {
      return 2026;
    }

    override getMonth(): number {
      return 6;
    }

    override getDate(): number {
      return 17;
    }
  }

  const manifest = buildEffectiveCapabilityManifest({
    tools: {},
    toolRoles: {},
    resolveRoute: () => undefined,
    skills: [],
    agentCount: 0,
    profile: "test",
    cwd: "/tmp",
  });
  const now = new LocalBoundaryDate("2026-07-16T16:30:00.000Z");

  assert.equal(now.toISOString().slice(0, 10), "2026-07-16");
  assert.equal(buildEffectiveCapabilityTurnContext(manifest, { now }).date, "2026-07-17");
});

test("manifest approval reflects built-in read-only and always-confirm contracts", () => {
  const makeTool = () =>
    tool({
      inputSchema: z.object({}),
      execute: () => Promise.resolve("ok"),
    });
  const roles = {
    skill: CAPABILITY_TOOL_ROLES.skill,
    list: CAPABILITY_TOOL_ROLES.sessionList,
    transcript: CAPABILITY_TOOL_ROLES.transcriptRead,
    install: CAPABILITY_TOOL_ROLES.agentInstall,
    command: CAPABILITY_TOOL_ROLES.sessionCommand,
  } as const;
  const manifest = buildEffectiveCapabilityManifest({
    tools: Object.fromEntries(Object.keys(roles).map((id) => [id, makeTool()])),
    toolRoles: roles,
    resolveRoute: (id) => ({ agentName: "roll", toolName: id }),
    skills: [],
    agentCount: 0,
    profile: "test",
    cwd: "/tmp",
  });
  const approval = Object.fromEntries(manifest.tools.map((entry) => [entry.id, entry.approval]));

  assert.equal(approval["skill"], CAPABILITY_APPROVAL_MODES.readOnly);
  assert.equal(approval["list"], CAPABILITY_APPROVAL_MODES.readOnly);
  assert.equal(approval["transcript"], CAPABILITY_APPROVAL_MODES.readOnly);
  assert.equal(approval["install"], CAPABILITY_APPROVAL_MODES.alwaysConfirm);
  assert.equal(approval["command"], CAPABILITY_APPROVAL_MODES.runtimePolicy);
});

test("safe capability snapshot drops schema examples/defaults and redacts bounded strings", () => {
  const base = buildEffectiveCapabilityManifest({
    tools: {
      inspect: tool({
        description: "inspect",
        inputSchema: z.object({ query: z.string() }),
        execute: () => Promise.resolve("ok"),
      }),
    },
    toolRoles: { inspect: CAPABILITY_TOOL_ROLES.agent },
    resolveRoute: () => ({ agentName: "audit", toolName: "inspect" }),
    skills: [],
    agentCount: 1,
    profile: "test",
    cwd: "/tmp",
  });
  const originalTool = base.tools[0];
  assert.ok(originalTool);
  const secret = "ultra-private-token-value";
  const media = `data:image/png;base64,${"a".repeat(2_048)}`;
  const unsafeManifest = {
    ...base,
    skills: Array.from({ length: 200 }, (_, index) => ({
      name: `skill-${String(index)}`,
      description: "safe description",
      source: "project" as const,
    })),
    tools: [
      {
        ...originalTool,
        description: `apiKey=${secret} MY_API_KEY=${secret} service.api.key:${secret} ${media} ${"safe text ".repeat(10_000)}`,
        inputSchema: {
          type: "object",
          properties: {
            apiKey: {
              type: "string",
              description: `Bearer ${secret}`,
              default: secret,
              examples: [secret, media],
              enum: [secret],
            },
            image: { type: "string", const: media },
            ...Object.fromEntries(
              Array.from({ length: 200 }, (_, index) => [
                `field-${String(index)}`,
                { type: "string" },
              ]),
            ),
          },
        },
      },
    ],
  } satisfies typeof base;
  const turnContext = buildEffectiveCapabilityTurnContext(unsafeManifest, {
    explicitSkillNames: ["review"],
  });

  const snapshot = createSafeCapabilitySnapshot(unsafeManifest, turnContext);
  const serialized = JSON.stringify(snapshot);
  const safeTool = snapshot.manifest.tools[0];

  assert.ok(safeTool?.description);
  assert.ok(safeTool.description.length <= 512);
  assert.equal(snapshot.manifest.skills.length, 128);
  assert.ok(
    typeof safeTool.inputSchema === "object" &&
      safeTool.inputSchema !== null &&
      !Array.isArray(safeTool.inputSchema),
  );
  const safeProperties = safeTool.inputSchema["properties"];
  assert.ok(
    typeof safeProperties === "object" && safeProperties !== null && !Array.isArray(safeProperties),
  );
  assert.ok(Object.keys(safeProperties).length <= 129);
  assert.doesNotMatch(serialized, /ultra-private-token-value|data:image|base64/u);
  assert.doesNotMatch(serialized, /"(?:default|example|examples)"/u);
  assert.match(serialized, /sensitive value redacted|media value omitted/u);
  assert.match(JSON.stringify(unsafeManifest), /ultra-private-token-value|data:image/u);
  assert.notEqual(snapshot.manifest, unsafeManifest);
});

test("safe capability snapshot fail-closes quoted, block, CJK, prefixed and dotted secrets", () => {
  const safeText = [
    "notatoken=public token_budget=100 key_count=2",
    "PUBLIC_URL=https://public.example.com",
    "CALLBACK_URL=https://callback.example.com",
  ].join("\n");
  const secrets = [
    "alpha bravo charlie",
    "delta echo foxtrot",
    "golf hotel india",
    "juliet kilo lima",
  ] as const;
  const envSecrets = [
    "aws-secret-access-value",
    "aws-access-key-id-value",
    "/tmp/google-credential-secret.json",
    "postgres://db-user:db-password@localhost/app",
  ] as const;
  const base = buildEffectiveCapabilityManifest({
    tools: {
      inspect: tool({
        description: "inspect",
        inputSchema: z.object({ query: z.string() }),
        execute: () => Promise.resolve("ok"),
      }),
    },
    toolRoles: { inspect: CAPABILITY_TOOL_ROLES.agent },
    resolveRoute: () => ({ agentName: "audit", toolName: "inspect" }),
    skills: [],
    agentCount: 1,
    profile: "test",
    cwd: "/tmp",
  });
  const toolCapability = base.tools[0];
  assert.ok(toolCapability);
  const unsafeManifest = {
    ...base,
    tools: [
      {
        ...toolCapability,
        description: [
          safeText,
          `MY_API_KEY="${secrets[0]}"`,
          `service.api.key:'${secrets[1]}'`,
          `数据库密码：\`${secrets[2]}\``,
          `访问令牌: |\n  ${secrets[3]}`,
          `AWS_SECRET_ACCESS_KEY=${envSecrets[0]}`,
          `AWS_ACCESS_KEY_ID=${envSecrets[1]}`,
          `GOOGLE_APPLICATION_CREDENTIALS=${envSecrets[2]}`,
          `DATABASE_URL=${envSecrets[3]}`,
        ].join("\n"),
      },
    ],
  } satisfies typeof base;

  const serialized = JSON.stringify(createSafeCapabilitySnapshot(unsafeManifest, undefined));

  for (const secret of [...secrets, ...envSecrets]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  }
  assert.match(serialized, /sensitive value redacted/u);
  assert.match(serialized, /notatoken=public token_budget=100 key_count=2/u);
  assert.match(serialized, /PUBLIC_URL=https:\/\/public\.example\.com/u);
  assert.match(serialized, /CALLBACK_URL=https:\/\/callback\.example\.com/u);
});

test("safe capability snapshot redacts structured CJK secret keys without hiding counters", () => {
  const base = buildEffectiveCapabilityManifest({
    tools: {
      inspect: tool({
        description: "inspect",
        inputSchema: z.object({}),
        execute: () => Promise.resolve("ok"),
      }),
    },
    toolRoles: { inspect: CAPABILITY_TOOL_ROLES.agent },
    resolveRoute: () => ({ agentName: "audit", toolName: "inspect" }),
    skills: [],
    agentCount: 1,
    profile: "test",
    cwd: "/tmp",
  });
  const toolCapability = base.tools[0];
  assert.ok(toolCapability);
  const unsafeManifest = {
    ...base,
    tools: [
      {
        ...toolCapability,
        inputSchema: {
          type: "object",
          properties: {
            数据库密码: { type: "string", description: "中文结构机密" },
            AWS_ACCESS_KEY_ID: { type: "string", description: "aws-structured-access-id" },
            GOOGLE_APPLICATION_CREDENTIALS: {
              type: "string",
              description: "google-structured-credential",
            },
            DATABASE_URL: { type: "string", description: "postgres://structured-password" },
            PUBLIC_URL: { type: "string", description: "https://public.example.com" },
            密码学算法: { type: "string", description: "保留密码学说明" },
            访问令牌计数: { type: "integer", description: "保留令牌计数" },
            token_budget: { type: "integer", description: "preserve token budget" },
          },
        },
      },
    ],
  } satisfies typeof base;

  const snapshot = createSafeCapabilitySnapshot(unsafeManifest, undefined);
  const schema = snapshot.manifest.tools[0]?.inputSchema;
  assert.ok(typeof schema === "object" && schema !== null && !Array.isArray(schema));
  const properties = schema["properties"];
  assert.ok(typeof properties === "object" && properties !== null && !Array.isArray(properties));

  assert.deepEqual(properties["数据库密码"], {
    description: "[sensitive value redacted]",
    type: "string",
  });
  assert.deepEqual(properties["AWS_ACCESS_KEY_ID"], {
    description: "[sensitive value redacted]",
    type: "string",
  });
  assert.deepEqual(properties["GOOGLE_APPLICATION_CREDENTIALS"], {
    description: "[sensitive value redacted]",
    type: "string",
  });
  assert.deepEqual(properties["DATABASE_URL"], {
    description: "[sensitive value redacted]",
    type: "string",
  });
  assert.deepEqual(properties["PUBLIC_URL"], {
    description: "https://public.example.com",
    type: "string",
  });
  assert.deepEqual(properties["密码学算法"], {
    description: "保留密码学说明",
    type: "string",
  });
  assert.deepEqual(properties["访问令牌计数"], {
    description: "保留令牌计数",
    type: "integer",
  });
  assert.deepEqual(properties["token_budget"], {
    description: "preserve token budget",
    type: "integer",
  });
});
