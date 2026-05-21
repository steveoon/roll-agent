import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentLogger } from "@roll-agent/sdk";
import { BrowserRuntimeConfigSchema } from "@roll-agent/browser";
import { BrowserInstancePool, runWithBrowserInstance } from "../browser-instance-pool.ts";
import { setRuntimeStateForTests } from "../runtime-holder.ts";
import {
  buildRecruitmentIdempotencyKey,
  recordRecruitmentEventAsync,
  setRecruitmentEventPostDepsForTests,
  setRecruitmentEventRecorderForTests,
} from "./client.ts";

function createLogger(warnings: string[] = []): AgentLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
  };
}

afterEach(() => {
  setRecruitmentEventPostDepsForTests(undefined);
  setRecruitmentEventRecorderForTests(undefined);
  setRuntimeStateForTests({});
});

describe("recruitment events client", () => {
  it("builds stable idempotency keys", () => {
    assert.equal(
      buildRecruitmentIdempotencyKey("zhipin-message-sent", ["c-1", "g-1", "hello"]),
      buildRecruitmentIdempotencyKey("zhipin-message-sent", ["c-1", "g-1", "hello"]),
    );
  });

  it("posts events when API config and default agent id are present", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_BASE_URL: "https://events.example.test",
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: "zhipin-agent-1",
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    recordRecruitmentEventAsync(
      {
        idempotencyKey: "key-1",
        sourcePlatform: "zhipin",
        dataSource: "api_callback",
        eventType: "message_received",
        candidate: { name: "张三", position: "服务员" },
        details: {},
      },
      createLogger(),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://events.example.test/api/v1/recruitment-events");
    assert.equal(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization,
      "Bearer token-1",
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      events: Array<{ agentId: string; dataSource: string }>;
    };
    assert.equal(body.events[0]?.agentId, "zhipin-agent-1");
    assert.equal(body.events[0]?.dataSource, "api_callback");
  });

  it("posts events with default endpoint when token and default agent id are present", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: "zhipin-agent-1",
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    recordRecruitmentEventAsync(
      {
        idempotencyKey: "key-1",
        sourcePlatform: "zhipin",
        dataSource: "api_callback",
        eventType: "message_received",
        candidate: { name: "张三", position: "服务员" },
        details: {},
      },
      createLogger(),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://huajune.duliday.com/api/v1/recruitment-events");
    assert.equal(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization,
      "Bearer token-1",
    );
  });

  it("uses browser instance trackingAgentId before default env agent id", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const instancePool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      defaultInstance: "boss-a",
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
          trackingAgentId: "zhipin-agent-instance",
        },
      },
    });
    setRuntimeStateForTests({ instancePool });
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_BASE_URL: "https://events.example.test",
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: "zhipin-agent-env",
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await runWithBrowserInstance("boss-a", async () => {
      recordRecruitmentEventAsync(
        {
          idempotencyKey: "key-1",
          sourcePlatform: "zhipin",
          dataSource: "api_callback",
          eventType: "message_received",
          candidate: { name: "张三", position: "服务员" },
          details: {},
        },
        createLogger(),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const body = JSON.parse(String(calls[0]?.init.body)) as {
      events: Array<{ agentId: string }>;
    };
    assert.equal(body.events[0]?.agentId, "zhipin-agent-instance");
  });

  it("does not fallback to default env agent id when multi-instance tracking context is missing", async () => {
    const warnings: string[] = [];
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const instancePool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
          trackingAgentId: "zhipin-agent-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
          trackingAgentId: "zhipin-agent-b",
        },
      },
    });
    setRuntimeStateForTests({ instancePool });
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_BASE_URL: "https://events.example.test",
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: "zhipin-agent-env",
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    recordRecruitmentEventAsync(
      {
        idempotencyKey: "key-1",
        sourcePlatform: "zhipin",
        dataSource: "api_callback",
        eventType: "message_received",
        candidate: { name: "张三", position: "服务员" },
        details: {},
      },
      createLogger(warnings),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(calls.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /tracking-agent-id|browser instance/i);
  });

  it("falls back to default env agent id when the selected browser instance has no trackingAgentId", async () => {
    const calls: Array<{ readonly agentId: string }> = [];
    const instancePool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
          trackingAgentId: "zhipin-agent-b",
        },
      },
    });
    setRuntimeStateForTests({ instancePool });
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_BASE_URL: "https://events.example.test",
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: "zhipin-agent-env",
      },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ agentId: string }> };
        calls.push({ agentId: body.events[0]?.agentId ?? "" });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await runWithBrowserInstance("boss-a", async () => {
      recordRecruitmentEventAsync(
        {
          idempotencyKey: "key-1",
          sourcePlatform: "zhipin",
          dataSource: "api_callback",
          eventType: "message_received",
          candidate: { name: "张三", position: "服务员" },
          details: {},
        },
        createLogger(),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      calls.map((call) => call.agentId),
      ["zhipin-agent-env"],
    );
  });

  it("posts different trackingAgentId values for different browser instances", async () => {
    const calls: Array<{ readonly agentId: string }> = [];
    const instancePool = new BrowserInstancePool(BrowserRuntimeConfigSchema.parse({}), {
      instances: {
        "boss-a": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9222,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-a",
          trackingAgentId: "zhipin-agent-a",
        },
        "boss-b": {
          mode: "managed-cdp",
          cdpHost: "127.0.0.1",
          cdpPort: 9223,
          channel: "chrome",
          userDataDir: "/tmp/roll-browser/boss-b",
          trackingAgentId: "zhipin-agent-b",
        },
      },
    });
    setRuntimeStateForTests({ instancePool });
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_BASE_URL: "https://events.example.test",
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
      },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ agentId: string }> };
        calls.push({ agentId: body.events[0]?.agentId ?? "" });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    await runWithBrowserInstance("boss-a", async () => {
      recordRecruitmentEventAsync(
        {
          idempotencyKey: "key-a",
          sourcePlatform: "zhipin",
          dataSource: "api_callback",
          eventType: "message_received",
          candidate: { name: "张三", position: "服务员" },
          details: {},
        },
        createLogger(),
      );
    });
    await runWithBrowserInstance("boss-b", async () => {
      recordRecruitmentEventAsync(
        {
          idempotencyKey: "key-b",
          sourcePlatform: "zhipin",
          dataSource: "api_callback",
          eventType: "message_received",
          candidate: { name: "李四", position: "收银" },
          details: {},
        },
        createLogger(),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      calls.map((call) => call.agentId),
      ["zhipin-agent-a", "zhipin-agent-b"],
    );
  });

  it("warns once when tracking is enabled without required API config", async () => {
    const warnings: string[] = [];
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    setRecruitmentEventPostDepsForTests({
      env: {},
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    const draft = {
      idempotencyKey: "key-1",
      sourcePlatform: "zhipin" as const,
      dataSource: "api_callback" as const,
      eventType: "message_received" as const,
      candidate: { name: "张三", position: "服务员" },
      details: {},
    };
    recordRecruitmentEventAsync(draft, createLogger(warnings));
    recordRecruitmentEventAsync(draft, createLogger(warnings));

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /RECRUITMENT_EVENTS_API_TOKEN/);
    assert.equal(calls.length, 0);
  });

  it("warns when the API rejects an event inside a successful HTTP response", async () => {
    const warnings: string[] = [];
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_API_TOKEN: "token-1",
        RECRUITMENT_EVENTS_DEFAULT_AGENT_ID: "zhipin-agent-1",
      },
      fetch: (async () => {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              results: [
                {
                  idempotencyKey: "key-1",
                  status: "error",
                  error: {
                    code: "InvalidEvent",
                    message: "Invalid enum value",
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    recordRecruitmentEventAsync(
      {
        idempotencyKey: "key-1",
        sourcePlatform: "zhipin",
        dataSource: "api_callback",
        eventType: "message_received",
        candidate: { name: "张三", position: "服务员" },
        details: {},
      },
      createLogger(warnings),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /InvalidEvent/);
  });

  it("does not post or warn when tracking is disabled", async () => {
    const warnings: string[] = [];
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    setRecruitmentEventPostDepsForTests({
      env: {
        RECRUITMENT_EVENTS_ENABLED: "false",
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });

    recordRecruitmentEventAsync(
      {
        idempotencyKey: "key-1",
        sourcePlatform: "zhipin",
        dataSource: "api_callback",
        eventType: "message_received",
        candidate: { name: "张三", position: "服务员" },
        details: {},
      },
      createLogger(warnings),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(warnings.length, 0);
    assert.equal(calls.length, 0);
  });
});
