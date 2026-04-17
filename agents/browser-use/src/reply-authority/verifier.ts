import { createPublicKey, verify } from "node:crypto";
import { resolveReplyAuthorityPublicKey } from "./key-store.ts";
import {
  REPLY_AUTHORITY_CLOCK_SKEW_SECONDS,
  ReplyAuthorityEnvelopePayloadSchema,
  type ReplyAuthorityEnvelopePayload,
} from "./schemas.ts";

interface ParsedCompactEnvelope {
  readonly payload: ReplyAuthorityEnvelopePayload;
  readonly payloadJson: string;
  readonly signatureBase64: string;
}

function validateEnvelopeVersion(payloadUnknown: unknown): void {
  if (
    typeof payloadUnknown === "object" &&
    payloadUnknown !== null &&
    "v" in payloadUnknown &&
    typeof payloadUnknown.v === "number" &&
    payloadUnknown.v !== 2
  ) {
    throw new Error("unexpected envelope version");
  }
}

function parseCompactEnvelope(signedEnvelope: string): ParsedCompactEnvelope {
  const parts = signedEnvelope.split(".");
  const payloadBase64 = parts[0];
  const signatureBase64 = parts[1];

  if (
    parts.length !== 2 ||
    payloadBase64 === undefined ||
    signatureBase64 === undefined ||
    payloadBase64.length === 0 ||
    signatureBase64.length === 0
  ) {
    throw new Error("Invalid signed envelope format");
  }

  let payloadJson = "";
  try {
    payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf-8");
  } catch {
    throw new Error("Invalid signed envelope format");
  }

  let payloadUnknown: unknown;
  try {
    payloadUnknown = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new Error("Envelope payload schema validation failed");
  }
  validateEnvelopeVersion(payloadUnknown);

  const parsed = ReplyAuthorityEnvelopePayloadSchema.safeParse(payloadUnknown);
  if (!parsed.success) {
    throw new Error("Envelope payload schema validation failed");
  }

  return {
    payload: parsed.data,
    payloadJson,
    signatureBase64,
  };
}

function validateEnvelopeTimestamps(
  payload: ReplyAuthorityEnvelopePayload,
  nowSeconds: number,
): void {
  if (payload.exp <= payload.iat) {
    throw new Error("Envelope expiry must be after issue time");
  }
  if (payload.exp < nowSeconds - REPLY_AUTHORITY_CLOCK_SKEW_SECONDS) {
    throw new Error("Envelope expired");
  }
  if (payload.iat > nowSeconds + REPLY_AUTHORITY_CLOCK_SKEW_SECONDS) {
    throw new Error("Envelope issued in the future");
  }
}

export async function verifySignedReplyEnvelope(
  signedEnvelope: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ReplyAuthorityEnvelopePayload> {
  const parsed = parseCompactEnvelope(signedEnvelope);
  const publicKeyRecord = await resolveReplyAuthorityPublicKey(parsed.payload.kid);

  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyRecord.publicKey, "base64url"),
    format: "der",
    type: "spki",
  });

  const isValid = verify(
    null,
    Buffer.from(parsed.payloadJson, "utf-8"),
    publicKey,
    Buffer.from(parsed.signatureBase64, "base64url"),
  );
  if (!isValid) {
    throw new Error("Signature verification failed");
  }

  validateEnvelopeTimestamps(parsed.payload, nowSeconds);
  return parsed.payload;
}
