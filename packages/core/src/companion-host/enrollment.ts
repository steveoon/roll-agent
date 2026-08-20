import type { Readable } from "node:stream";
import {
  deviceEnrollmentResultSchema,
  type CompanionConfig,
  type DeviceEnrollmentResult,
} from "./schema.ts";
import type { CompanionConfigStore } from "./config-store.ts";
import type { CompanionCredentialStore } from "./credentials.ts";
import { canonicalizeCompanionWorkspace } from "./workspace.ts";
import { COMPANION_CONFIG_VERSION, resolveRelayEndpoint } from "./constants.ts";

const MAX_PAIRING_CODE_BYTES = 4 * 1024;
const ENROLLMENT_TIMEOUT_MS = 30_000;

export interface DeviceEnrollmentClient {
  redeem(pairingCode: string, signal?: AbortSignal): Promise<DeviceEnrollmentResult>;
}

export type CompanionFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export class OfficialDeviceEnrollmentClient implements DeviceEnrollmentClient {
  private readonly fetch: CompanionFetch;

  constructor(fetchImplementation: CompanionFetch = globalThis.fetch) {
    this.fetch = fetchImplementation;
  }

  async redeem(pairingCode: string, signal?: AbortSignal): Promise<DeviceEnrollmentResult> {
    if (pairingCode.length === 0) {
      throw new Error("Pairing code must not be empty");
    }
    const enrollmentUrl = resolveRelayEndpoint().enrollmentUrl;
    const timeoutSignal = AbortSignal.timeout(ENROLLMENT_TIMEOUT_MS);
    const requestSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const response = await this.fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(
        `Official Relay rejected device enrollment (HTTP ${String(response.status)})`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Official Relay returned an invalid enrollment response");
    }
    const parsed = deviceEnrollmentResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error("Official Relay returned an invalid enrollment response");
    }
    return parsed.data;
  }
}

export class CompanionEnrollmentService {
  private readonly configStore: CompanionConfigStore;
  private readonly credentialStore: CompanionCredentialStore;
  private readonly enrollmentClient: DeviceEnrollmentClient;

  constructor(options: {
    readonly configStore: CompanionConfigStore;
    readonly credentialStore: CompanionCredentialStore;
    readonly enrollmentClient: DeviceEnrollmentClient;
  }) {
    this.configStore = options.configStore;
    this.credentialStore = options.credentialStore;
    this.enrollmentClient = options.enrollmentClient;
  }

  async enroll(input: {
    readonly pairingCode: string;
    readonly workspace: string;
    readonly signal?: AbortSignal;
  }): Promise<CompanionConfig> {
    if ((await this.configStore.load()) !== null) {
      throw new Error("This Roll Companion is already enrolled; unenroll it first");
    }
    const cwd = await canonicalizeCompanionWorkspace(input.workspace);
    const enrollment = await this.enrollmentClient.redeem(input.pairingCode, input.signal);
    const credentialRef = await this.credentialStore.put(
      enrollment.deviceId,
      enrollment.deviceCredential,
    );
    const config: CompanionConfig = {
      version: COMPANION_CONFIG_VERSION,
      deviceId: enrollment.deviceId,
      workspaceId: enrollment.workspaceId,
      cwd,
      enabled: true,
      credentialRef,
    };
    try {
      await this.configStore.save(config);
      return config;
    } catch (error: unknown) {
      await this.credentialStore.delete(credentialRef).catch(() => undefined);
      throw error;
    }
  }

  async unenroll(): Promise<boolean> {
    const config = await this.configStore.load();
    if (config === null) {
      return false;
    }
    await this.credentialStore.delete(config.credentialRef);
    await this.configStore.remove();
    return true;
  }

  async setEnabled(enabled: boolean): Promise<CompanionConfig> {
    const current = await this.requireConfig();
    const updated: CompanionConfig = { ...current, enabled };
    await this.configStore.save(updated);
    return updated;
  }

  async setWorkspace(workspace: string): Promise<CompanionConfig> {
    const current = await this.requireConfig();
    const cwd = await canonicalizeCompanionWorkspace(workspace);
    const updated: CompanionConfig = { ...current, cwd };
    await this.configStore.save(updated);
    return updated;
  }

  private async requireConfig(): Promise<CompanionConfig> {
    const config = await this.configStore.load();
    if (config === null) {
      throw new Error("Roll Companion is not enrolled");
    }
    return config;
  }
}

export async function readPairingCodeFromStdin(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_PAIRING_CODE_BYTES) {
      throw new Error("Pairing code input is too large");
    }
    chunks.push(buffer);
  }
  const pairingCode = Buffer.concat(chunks).toString("utf8").trim();
  if (pairingCode.length === 0) {
    throw new Error("Pairing code input is empty");
  }
  return pairingCode;
}
