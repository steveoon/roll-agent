import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { resetReplyAuthorityKeyStoreForTests, setReplyAuthorityKeysForTests } from "./key-store.ts";
import { resetReplyEnvelopeReplayStoreForTests } from "./replay-store.ts";
import { verifySignedReplyEnvelope } from "./verifier.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEYS_URL = process.env.REPLY_AUTHORITY_KEYS_URL;

function createSignedEnvelope(overrides: Partial<Record<string, unknown>> = {}): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 2,
    iss: "reply-authority-service",
    kid: "reply-signing-key-2026-04",
    jti: "550e8400-e29b-41d4-a716-446655440000",
    iat: now - 5,
    exp: now + 300,
    aud: "browser-use-agent/zhipin_send_reply",
    platform: "zhipin",
    tenantId: "tenant-001",
    conversationId: "685501091-0",
    candidateId: "candidate-123",
    reply: "你好，欢迎了解这个岗位。",
    policyVersion: "tenant:file:v1",
    recruiterBinding: {
      platform: "zhipin",
      username: "recruiter-alice",
    },
    ...overrides,
  };

  setReplyAuthorityKeysForTests([
    {
      kid: String(payload.kid),
      algorithm: "Ed25519",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
      validFrom: "2026-04-10T12:00:00.000Z",
    },
  ]);

  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson, "utf-8").toString("base64url");
  const signatureBase64 = sign(null, Buffer.from(payloadJson, "utf-8"), privateKey).toString(
    "base64url",
  );
  return `${payloadBase64}.${signatureBase64}`;
}

afterEach(() => {
  resetReplyAuthorityKeyStoreForTests();
  resetReplyEnvelopeReplayStoreForTests();
  globalThis.fetch = ORIGINAL_FETCH;

  if (ORIGINAL_KEYS_URL === undefined) delete process.env.REPLY_AUTHORITY_KEYS_URL;
  else process.env.REPLY_AUTHORITY_KEYS_URL = ORIGINAL_KEYS_URL;
});

describe("verifySignedReplyEnvelope", () => {
  it("verifies a valid signed envelope", async () => {
    const envelope = createSignedEnvelope();
    const payload = await verifySignedReplyEnvelope(envelope);

    assert.equal(payload.aud, "browser-use-agent/zhipin_send_reply");
    assert.equal(payload.candidateId, "candidate-123");
    assert.equal(payload.recruiterBinding.username, "recruiter-alice");
  });

  it("round-trips CJK recruiterBinding.username through base64url decode", async () => {
    const envelope = createSignedEnvelope({
      recruiterBinding: {
        platform: "zhipin",
        username: "祝东升",
      },
    });
    const payload = await verifySignedReplyEnvelope(envelope);

    assert.equal(payload.recruiterBinding.username, "祝东升");
  });

  it("rejects envelopes with an unsupported version", async () => {
    const envelope = createSignedEnvelope({ v: 1 });

    await assert.rejects(
      async () => await verifySignedReplyEnvelope(envelope),
      /unexpected envelope version/,
    );
  });

  it("rejects expired envelopes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const envelope = createSignedEnvelope({
      iat: now - 300,
      exp: now - 120,
    });

    await assert.rejects(async () => await verifySignedReplyEnvelope(envelope), /Envelope expired/);
  });

  it("rejects envelopes signed by an unknown kid", async () => {
    const envelope = createSignedEnvelope({ kid: "missing-key" });
    resetReplyAuthorityKeyStoreForTests();
    process.env.REPLY_AUTHORITY_KEYS_URL =
      "https://reply-authority.duliday.com/.well-known/reply-authority-keys";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await assert.rejects(async () => await verifySignedReplyEnvelope(envelope), /Unknown key ID/);
  });

  it("rejects malformed compact envelope strings", async () => {
    await assert.rejects(
      async () => await verifySignedReplyEnvelope("not-a-valid-envelope"),
      /Invalid signed envelope format/,
    );
  });
});
