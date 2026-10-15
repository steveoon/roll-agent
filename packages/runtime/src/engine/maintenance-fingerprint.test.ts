import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { AgentSession } from "./agent-session.ts";
import { maintenanceDigest } from "./maintenance-fingerprint.ts";
import { requestDigest, estimatePreparedRequest } from "./request-budget.ts";
import { MaintenanceEpisode } from "./compaction-recovery.ts";

function session(
  signature: string,
  encrypted: string,
  image: number,
  text = "Keep the same contract",
) {
  return new AgentSession({
    id: "maintenance-fingerprint",
    model: new MockLanguageModelV4(),
    sources: [],
    maxSteps: 8,
    initialMessages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image", image: new Uint8Array([image]) },
        ],
        providerOptions: {
          google: { thoughtSignature: signature },
          openai: { encryptedContent: encrypted },
        },
      },
    ],
  });
}

test("opaque payload changes do not restart maintenance, but calibration still distinguishes them", async () => {
  const a = session("signature-a", "cipher-a", 1);
  const b = session("signature-b", "cipher-b", 2);
  const changed = session("signature-b", "cipher-b", 2, "A genuinely new requirement");
  try {
    assert.equal(a["maintenanceFingerprint"](), b["maintenanceFingerprint"]());
    assert.notEqual(a["maintenanceFingerprint"](), changed["maintenanceFingerprint"]());
    assert.notEqual(requestDigest(a.getMessages()), requestDigest(b.getMessages()));
    const budget = estimatePreparedRequest(
      { prompt: [], maxOutputTokens: 100 },
      {
        provider: "test",
        model: "test",
        window: 32000,
      },
      0,
    );
    const episode = new MaintenanceEpisode("turn", budget, { messages: 0, tools: 0 }, 120000);
    episode.beginPass(a["maintenanceFingerprint"]());
    episode.beginPass(b["maintenanceFingerprint"]());
    assert.equal(episode.workBlockReason(a["maintenanceFingerprint"]()), "maintenance_no_progress");
  } finally {
    await Promise.all([a.close(), b.close(), changed.close()]);
  }
});

test("maintenance still distinguishes business inputs and non-opaque provider configuration", () => {
  const input = (name: string) => ({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool-call", input: { type: "image", path: name, providerMetadata: name } },
        ],
      },
    ],
  });
  assert.notEqual(maintenanceDigest(input("a")), maintenanceDigest(input("b")));
  assert.notEqual(
    maintenanceDigest({ options: { reasoningEffort: "low" } }),
    maintenanceDigest({ options: { reasoningEffort: "high" } }),
  );
  assert.equal(
    maintenanceDigest({ options: { thoughtSignature: "a" } }),
    maintenanceDigest({ options: { thoughtSignature: "b" } }),
  );
});
