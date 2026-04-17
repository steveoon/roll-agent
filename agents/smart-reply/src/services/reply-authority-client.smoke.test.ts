import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";

const ORIGINAL_URL = process.env.REPLY_AUTHORITY_URL;
const ORIGINAL_TOKEN = process.env.REPLY_AUTHORITY_BEARER_TOKEN;

const PROXY_REQUEST = {
  candidateMessage: "你好，请问薪资是多少？",
  conversationHistory: ["我: 你好", "候选人: 请问薪资是多少？"],
  target: {
    platform: "zhipin" as const,
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    recruiterUsername: "recruiter-alice",
  },
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return JSON.parse(body);
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.REPLY_AUTHORITY_URL;
  else process.env.REPLY_AUTHORITY_URL = ORIGINAL_URL;

  if (ORIGINAL_TOKEN === undefined) delete process.env.REPLY_AUTHORITY_BEARER_TOKEN;
  else process.env.REPLY_AUTHORITY_BEARER_TOKEN = ORIGINAL_TOKEN;
});

describe("generateSignedReply smoke", () => {
  it("proxies recruiter resolution through a local mock authority service", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const path = request.url ?? "/";
      const body = request.method === "POST" ? await readJson(request) : null;
      requests.push({ path, body });

      if (path === "/resolve-recruiter-binding") {
        writeJson(response, 200, {
          tenantId: "tenant-001",
          recruiterBinding: {
            platform: "zhipin",
            username: "recruiter-alice",
          },
        });
        return;
      }

      if (path === "/generate-signed-reply") {
        writeJson(response, 200, {
          suggestedReply: "感谢你的关注！我们这边薪资是综合计算的。",
          signedEnvelope: "payload.signature",
          envelopeExp: 1712736600,
          confidence: 0.85,
          stage: "job_consultation",
          replyPolicySource: "file",
        });
        return;
      }

      writeJson(response, 404, {
        statusCode: 404,
        error: "Not Found",
        message: `Unknown path: ${path}`,
      });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      process.env.REPLY_AUTHORITY_URL = `http://127.0.0.1:${String(address.port)}`;
      process.env.REPLY_AUTHORITY_BEARER_TOKEN = "client-token";

      const { generateSignedReply } = await import(
        `./reply-authority-client.ts?case=${Date.now()}`
      );
      const result = await generateSignedReply(PROXY_REQUEST);

      assert.equal(result.signedEnvelope, "payload.signature");
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.path, "/resolve-recruiter-binding");
      assert.deepEqual(requests[0]?.body, {
        platform: "zhipin",
        username: "recruiter-alice",
      });
      assert.equal(requests[1]?.path, "/generate-signed-reply");
      assert.deepEqual(requests[1]?.body, {
        ...PROXY_REQUEST,
        target: {
          platform: "zhipin",
          tenantId: "tenant-001",
          conversationId: "685501091-0",
          candidateId: "candidate-123",
          recruiterBinding: {
            platform: "zhipin",
            username: "recruiter-alice",
          },
        },
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
