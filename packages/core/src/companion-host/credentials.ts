import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceId } from "@roll-agent/relay-protocol";
import { credentialReferenceSchema, type CompanionCredentialReference } from "./schema.ts";
import { runChecked, SpawnProcessRunner, type ProcessRunner } from "./process-runner.ts";
import { createPowerShellUtf8StringExpression } from "./windows-powershell.ts";
import { resolveWindowsPowerShellExecutable } from "./windows-system.ts";

const KEYCHAIN_SERVICE = "dev.roll-agent.companion.device";

export interface CompanionCredentialStore {
  put(deviceId: DeviceId, credential: string): Promise<CompanionCredentialReference>;
  get(reference: CompanionCredentialReference): Promise<string>;
  delete(reference: CompanionCredentialReference): Promise<void>;
}

export class MacOsKeychainCredentialStore implements CompanionCredentialStore {
  private readonly runner: ProcessRunner;

  constructor(runner: ProcessRunner = new SpawnProcessRunner()) {
    this.runner = runner;
  }

  async put(deviceId: DeviceId, credential: string): Promise<CompanionCredentialReference> {
    if (credential.length === 0) {
      throw new Error("Device credential must not be empty");
    }
    if (containsNonPrintableAscii(credential)) {
      throw new Error("Device credential must contain printable ASCII characters only");
    }
    const command = [
      "add-generic-password",
      "-U",
      "-a",
      quoteKeychainCommandArgument(deviceId),
      "-s",
      quoteKeychainCommandArgument(KEYCHAIN_SERVICE),
      "-w",
      quoteKeychainCommandArgument(credential),
    ].join(" ");
    await runChecked(
      this.runner,
      {
        command: "/usr/bin/security",
        args: ["-i"],
        input: `${command}\n`,
      },
      "Unable to save the Companion device credential in macOS Keychain",
    );
    return credentialReferenceSchema.parse(`keychain:${deviceId}`);
  }

  async get(reference: CompanionCredentialReference): Promise<string> {
    const account = parseReference(reference, "keychain");
    const result = await runChecked(
      this.runner,
      {
        command: "/usr/bin/security",
        args: ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
      },
      "Unable to read the Companion device credential from macOS Keychain",
    );
    const credential = result.stdout.trimEnd();
    if (credential.length === 0) {
      throw new Error("The Companion device credential in macOS Keychain is empty");
    }
    return credential;
  }

  async delete(reference: CompanionCredentialReference): Promise<void> {
    const account = parseReference(reference, "keychain");
    const result = await this.runner.run({
      command: "/usr/bin/security",
      args: ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE],
    });
    if (result.code !== 0 && result.code !== 44 && !result.stderr.includes("could not be found")) {
      throw new Error("Unable to delete the Companion device credential from macOS Keychain");
    }
  }
}

const DPAPI_ENCRYPT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd()
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$encrypted = ConvertFrom-SecureString $secure
[IO.File]::WriteAllText($path, $encrypted, [Text.UTF8Encoding]::new($false))
`;

const DPAPI_DECRYPT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$encrypted = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
$secure = ConvertTo-SecureString $encrypted
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
`;

export class WindowsDpapiCredentialStore implements CompanionCredentialStore {
  private readonly secretsDir: string;
  private readonly runner: ProcessRunner;
  private readonly powershellExecutable: string;

  constructor(
    secretsDir: string,
    runner: ProcessRunner = new SpawnProcessRunner(),
    windowsDirectory?: string,
  ) {
    this.secretsDir = secretsDir;
    this.runner = runner;
    this.powershellExecutable = resolveWindowsPowerShellExecutable(windowsDirectory);
  }

  async put(deviceId: DeviceId, credential: string): Promise<CompanionCredentialReference> {
    if (credential.length === 0) {
      throw new Error("Device credential must not be empty");
    }
    await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    const fileName = `${deviceId}.dpapi`;
    const path = join(this.secretsDir, fileName);
    await runChecked(
      this.runner,
      {
        command: this.powershellExecutable,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          createPathBoundPowerShellScript(DPAPI_ENCRYPT_SCRIPT, path),
        ],
        input: credential,
      },
      "Unable to protect the Companion device credential with Windows DPAPI",
    );
    await chmod(path, 0o600).catch(() => undefined);
    return credentialReferenceSchema.parse(`dpapi:${deviceId}`);
  }

  async get(reference: CompanionCredentialReference): Promise<string> {
    const deviceId = parseReference(reference, "dpapi");
    const path = join(this.secretsDir, `${deviceId}.dpapi`);
    await readFile(path);
    const result = await runChecked(
      this.runner,
      {
        command: this.powershellExecutable,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          createPathBoundPowerShellScript(DPAPI_DECRYPT_SCRIPT, path),
        ],
      },
      "Unable to unprotect the Companion device credential with Windows DPAPI",
    );
    if (result.stdout.length === 0) {
      throw new Error("The Windows DPAPI Companion device credential is empty");
    }
    return result.stdout;
  }

  async delete(reference: CompanionCredentialReference): Promise<void> {
    const deviceId = parseReference(reference, "dpapi");
    try {
      await unlink(join(this.secretsDir, `${deviceId}.dpapi`));
    } catch (error: unknown) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function createPathBoundPowerShellScript(script: string, path: string): string {
  return `$path = ${createPowerShellUtf8StringExpression(path)}\n${script}`;
}

export function createPlatformCredentialStore(
  secretsDir: string,
  platform: NodeJS.Platform = process.platform,
  runner: ProcessRunner = new SpawnProcessRunner(),
): CompanionCredentialStore {
  if (platform === "darwin") {
    return new MacOsKeychainCredentialStore(runner);
  }
  if (platform === "win32") {
    return new WindowsDpapiCredentialStore(secretsDir, runner);
  }
  throw new Error("roll companion supports credential storage on macOS and Windows only");
}

export function quoteKeychainCommandArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function containsNonPrintableAscii(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint > 0x7e)) {
      return true;
    }
  }
  return false;
}

function parseReference(
  reference: CompanionCredentialReference,
  expectedKind: "keychain" | "dpapi",
): string {
  const parsed = credentialReferenceSchema.parse(reference);
  const prefix = `${expectedKind}:`;
  if (!parsed.startsWith(prefix)) {
    throw new Error(`Credential reference is not a ${expectedKind} reference`);
  }
  return parsed.slice(prefix.length);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
