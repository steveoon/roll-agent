import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CompanionPaths {
  readonly homeDir: string;
  readonly dataDir: string;
  readonly configPath: string;
  readonly logPath: string;
  readonly controlEndpoint: string;
  readonly secretsDir: string;
  readonly launchAgentPath: string;
  readonly windowsTaskXmlPath: string;
}

export function createCompanionPaths(
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
): CompanionPaths {
  const dataDir = join(homeDir, ".roll-agent", "companion");
  const pipeIdentity = createHash("sha256").update(homeDir).digest("hex").slice(0, 16);
  return {
    homeDir,
    dataDir,
    configPath: join(dataDir, "config.yaml"),
    logPath: join(dataDir, "companion.log"),
    controlEndpoint:
      platform === "win32"
        ? `\\\\.\\pipe\\roll-agent-companion-${pipeIdentity}`
        : join(dataDir, "control.sock"),
    secretsDir: join(dataDir, "credentials"),
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", "dev.roll-agent.companion.plist"),
    windowsTaskXmlPath: join(dataDir, "companion-task.xml"),
  };
}
