import { ReplyAuthorityPublicKeysResponseSchema, type ReplyAuthorityPublicKey } from "./schemas.ts";

let keyStore = new Map<string, ReplyAuthorityPublicKey>();
let inflightRefresh: Promise<ReadonlyMap<string, ReplyAuthorityPublicKey>> | null = null;

function getReplyAuthorityKeysUrl(): string {
  const url = process.env.REPLY_AUTHORITY_KEYS_URL?.trim();
  if (!url) {
    throw new Error(
      "REPLY_AUTHORITY_KEYS_URL 未配置，browser-use-agent 无法拉取 Reply Authority 公钥。",
    );
  }
  return url;
}

function setKeys(
  keys: ReadonlyArray<ReplyAuthorityPublicKey>,
): ReadonlyMap<string, ReplyAuthorityPublicKey> {
  keyStore = new Map(keys.map((key) => [key.kid, key] as const));
  return keyStore;
}

export async function refreshReplyAuthorityKeys(): Promise<
  ReadonlyMap<string, ReplyAuthorityPublicKey>
> {
  if (inflightRefresh) {
    return inflightRefresh;
  }

  inflightRefresh = (async () => {
    const response = await fetch(getReplyAuthorityKeysUrl());
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`Reply Authority 公钥拉取失败 (${response.status})`);
    }

    const parsed = ReplyAuthorityPublicKeysResponseSchema.parse(payload);
    return setKeys(parsed.keys);
  })();

  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

export async function preloadReplyAuthorityKeys(): Promise<void> {
  await refreshReplyAuthorityKeys();
}

export async function resolveReplyAuthorityPublicKey(
  kid: string,
): Promise<ReplyAuthorityPublicKey> {
  const cached = keyStore.get(kid);
  if (cached) {
    return cached;
  }

  const refreshed = await refreshReplyAuthorityKeys();
  const resolved = refreshed.get(kid);
  if (!resolved) {
    throw new Error(`Unknown key ID: ${kid}`);
  }
  return resolved;
}

export function setReplyAuthorityKeysForTests(keys: ReadonlyArray<ReplyAuthorityPublicKey>): void {
  setKeys(keys);
}

export function resetReplyAuthorityKeyStoreForTests(): void {
  keyStore = new Map<string, ReplyAuthorityPublicKey>();
  inflightRefresh = null;
}
