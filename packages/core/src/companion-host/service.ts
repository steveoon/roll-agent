import { Buffer } from "node:buffer";
import { access, chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { COMPANION_SERVICE_LABEL, WINDOWS_COMPANION_TASK_NAME } from "./constants.ts";
import { parseWindowsUserSid } from "./identity.ts";
import type { CompanionPaths } from "./paths.ts";
import type { BundledRollInvocation } from "./invocation.ts";
import {
  SpawnProcessRunner,
  type ProcessInvocation,
  type ProcessRunner,
} from "./process-runner.ts";
import { createPowerShellUtf8StringExpression } from "./windows-powershell.ts";
import {
  resolveWindowsPowerShellExecutable,
  resolveWindowsScheduledTasksExecutable,
  resolveWindowsWhoAmIExecutable,
} from "./windows-system.ts";

const WINDOWS_TASK_STATES = {
  unknown: 0,
  disabled: 1,
  queued: 2,
  ready: 3,
  running: 4,
} as const;

type WindowsTaskState = (typeof WINDOWS_TASK_STATES)[keyof typeof WINDOWS_TASK_STATES];
const WINDOWS_TASK_STATE_VALUES: ReadonlySet<number> = new Set(Object.values(WINDOWS_TASK_STATES));

const WINDOWS_TASK_STATE_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$tasks = $service.GetFolder('\').GetTasks(1)
$task = $null
foreach ($candidate in $tasks) {
  if ($candidate.Name -eq $taskName) {
    $task = $candidate
    break
  }
}
if ($null -eq $task) {
  [Console]::Out.Write('missing')
  exit 0
}
[Console]::Out.Write('state:' + [int]$task.State)
`;

export interface CompanionServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
}

export interface CompanionServiceController {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<CompanionServiceStatus>;
}

export interface ServicePlanIdentity {
  readonly label: string;
  readonly displayName: string;
  readonly plistPath: string;
  readonly logPath: string;
  readonly windowsTaskName: string;
  readonly windowsTaskXmlPath: string;
  readonly programArguments: readonly string[];
}

export function companionServiceIdentity(
  paths: CompanionPaths,
  invocation: BundledRollInvocation,
): ServicePlanIdentity {
  return {
    label: COMPANION_SERVICE_LABEL,
    displayName: "Roll Companion",
    plistPath: paths.launchAgentPath,
    logPath: paths.logPath,
    windowsTaskName: WINDOWS_COMPANION_TASK_NAME,
    windowsTaskXmlPath: paths.windowsTaskXmlPath,
    programArguments: [invocation.command, ...invocation.companionArgs],
  };
}

export interface MacOsLaunchAgentPlan {
  readonly label: string;
  readonly displayName: string;
  readonly plistPath: string;
  readonly plist: string;
  readonly domainTarget: string;
  readonly serviceTarget: string;
}

export function createMacOsLaunchAgentPlanForIdentity(
  identity: ServicePlanIdentity,
  uid: number,
): MacOsLaunchAgentPlan {
  const programArguments = identity.programArguments
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(identity.label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(identity.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(identity.logPath)}</string>
  </dict>
</plist>
`;
  const domainTarget = `gui/${String(uid)}`;
  return {
    label: identity.label,
    displayName: identity.displayName,
    plistPath: identity.plistPath,
    plist,
    domainTarget,
    serviceTarget: `${domainTarget}/${identity.label}`,
  };
}

export function createMacOsLaunchAgentPlan(input: {
  readonly paths: CompanionPaths;
  readonly invocation: BundledRollInvocation;
  readonly uid: number;
}): MacOsLaunchAgentPlan {
  return createMacOsLaunchAgentPlanForIdentity(
    companionServiceIdentity(input.paths, input.invocation),
    input.uid,
  );
}

const WINDOWS_TASK_XML_NAMESPACE = "http://schemas.microsoft.com/windows/2004/02/mit/task";
const WINDOWS_TASK_RESTART_INTERVAL = "PT1M";
const WINDOWS_TASK_RESTART_COUNT = 3;
const WINDOWS_TASK_LOGON_TYPE = "InteractiveToken";

export interface WindowsTaskPrincipal {
  readonly userId: string;
}

export interface WindowsScheduledTaskPlan {
  readonly taskName: string;
  readonly displayName: string;
  readonly taskCommand: string;
  readonly taskXmlPath: string;
  readonly whoAmI: ProcessInvocation;
  readonly create: ProcessInvocation;
  readonly remove: ProcessInvocation;
  readonly start: ProcessInvocation;
  readonly stop: ProcessInvocation;
  readonly query: ProcessInvocation;
  renderTaskXml(principal: WindowsTaskPrincipal): string;
}

export function encodeWindowsTaskXml(xml: string): Buffer {
  return Buffer.from(`${String.fromCharCode(0xfeff)}${xml}`, "utf16le");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderWindowsTaskXml(input: {
  readonly displayName: string;
  readonly userId: string;
  readonly command: string;
  readonly commandArguments: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="${WINDOWS_TASK_XML_NAMESPACE}">
  <RegistrationInfo>
    <Description>${escapeXmlText(input.displayName)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXmlText(input.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXmlText(input.userId)}</UserId>
      <LogonType>${WINDOWS_TASK_LOGON_TYPE}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>${WINDOWS_TASK_RESTART_INTERVAL}</Interval>
      <Count>${String(WINDOWS_TASK_RESTART_COUNT)}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(input.command)}</Command>
      <Arguments>${escapeXmlText(input.commandArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function createWindowsScheduledTaskPlanForIdentity(
  identity: Pick<
    ServicePlanIdentity,
    "windowsTaskName" | "windowsTaskXmlPath" | "displayName" | "programArguments"
  >,
  windowsDirectory?: string,
): WindowsScheduledTaskPlan {
  const [command, ...commandArguments] = identity.programArguments;
  if (command === undefined) {
    throw new Error("Windows task definition requires a program to run");
  }
  const taskCommand = identity.programArguments.map(quoteWindowsCommandArgument).join(" ");
  const quotedArguments = commandArguments.map(quoteWindowsCommandArgument).join(" ");
  const taskSchedulerExecutable = resolveWindowsScheduledTasksExecutable(windowsDirectory);
  const powershellExecutable = resolveWindowsPowerShellExecutable(windowsDirectory);
  const queryScript = `$taskName = ${createPowerShellUtf8StringExpression(identity.windowsTaskName)}\n${WINDOWS_TASK_STATE_QUERY_SCRIPT}`;
  return {
    taskName: identity.windowsTaskName,
    displayName: identity.displayName,
    taskCommand,
    taskXmlPath: identity.windowsTaskXmlPath,
    whoAmI: {
      command: resolveWindowsWhoAmIExecutable(windowsDirectory),
      args: ["/user", "/fo", "csv", "/nh"],
    },
    create: {
      command: taskSchedulerExecutable,
      args: ["/Create", "/F", "/XML", identity.windowsTaskXmlPath, "/TN", identity.windowsTaskName],
    },
    remove: {
      command: taskSchedulerExecutable,
      args: ["/Delete", "/F", "/TN", identity.windowsTaskName],
    },
    start: {
      command: taskSchedulerExecutable,
      args: ["/Run", "/TN", identity.windowsTaskName],
    },
    stop: {
      command: taskSchedulerExecutable,
      args: ["/End", "/TN", identity.windowsTaskName],
    },
    query: {
      command: powershellExecutable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", queryScript],
    },
    renderTaskXml: (principal) =>
      renderWindowsTaskXml({
        displayName: identity.displayName,
        userId: principal.userId,
        command,
        commandArguments: quotedArguments,
      }),
  };
}

export function createWindowsScheduledTaskPlan(input: {
  readonly paths: CompanionPaths;
  readonly invocation: BundledRollInvocation;
  readonly windowsDirectory?: string;
}): WindowsScheduledTaskPlan {
  return createWindowsScheduledTaskPlanForIdentity(
    companionServiceIdentity(input.paths, input.invocation),
    input.windowsDirectory,
  );
}

export class MacOsLaunchAgentController implements CompanionServiceController {
  private readonly plan: MacOsLaunchAgentPlan;
  private readonly runner: ProcessRunner;

  constructor(plan: MacOsLaunchAgentPlan, runner: ProcessRunner = new SpawnProcessRunner()) {
    this.plan = plan;
    this.runner = runner;
  }

  async install(): Promise<void> {
    await atomicWritePrivate(this.plan.plistPath, this.plan.plist);
    const current = await this.inspectLaunchd();
    if (!current.loaded) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["bootstrap", this.plan.domainTarget, this.plan.plistPath],
      });
    } else if (!current.running) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["kickstart", this.plan.serviceTarget],
      });
    }
  }

  async uninstall(): Promise<void> {
    await this.stop();
    await unlink(this.plan.plistPath).catch((error: unknown) => {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    });
  }

  async start(): Promise<void> {
    const status = await this.inspectLaunchd();
    if (!status.installed) {
      throw new Error(`${this.plan.displayName} service is not installed`);
    }
    if (!status.loaded) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["bootstrap", this.plan.domainTarget, this.plan.plistPath],
      });
    } else if (!status.running) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["kickstart", this.plan.serviceTarget],
      });
    }
  }

  async stop(): Promise<void> {
    const status = await this.inspectLaunchd();
    if (status.loaded) {
      await this.runRequired({
        command: "/bin/launchctl",
        args: ["bootout", this.plan.serviceTarget],
      });
    }
  }

  async status(): Promise<CompanionServiceStatus> {
    const status = await this.inspectLaunchd();
    return { installed: status.installed, running: status.running };
  }

  private async inspectLaunchd(): Promise<{
    readonly installed: boolean;
    readonly loaded: boolean;
    readonly running: boolean;
  }> {
    const installed = await fileExists(this.plan.plistPath);
    const result = await this.runner.run({
      command: "/bin/launchctl",
      args: ["print", this.plan.serviceTarget],
    });
    return {
      installed,
      loaded: result.code === 0,
      running: result.code === 0 && /\bstate\s*=\s*running\b/i.test(result.stdout),
    };
  }

  private async runRequired(invocation: ProcessInvocation): Promise<void> {
    const result = await this.runner.run(invocation);
    if (result.code !== 0) {
      throw new Error(`Unable to update the per-user macOS ${this.plan.displayName} service`);
    }
  }
}

export class WindowsScheduledTaskController implements CompanionServiceController {
  private readonly plan: WindowsScheduledTaskPlan;
  private readonly runner: ProcessRunner;

  constructor(plan: WindowsScheduledTaskPlan, runner: ProcessRunner = new SpawnProcessRunner()) {
    this.plan = plan;
    this.runner = runner;
  }

  async install(): Promise<void> {
    const userId = await this.resolveUserId();
    await atomicWritePrivate(
      this.plan.taskXmlPath,
      encodeWindowsTaskXml(this.plan.renderTaskXml({ userId })),
    );
    await this.runRequired(
      this.plan.create,
      `Unable to install the current-user ${this.plan.displayName} task`,
    );
    await this.start();
  }

  async uninstall(): Promise<void> {
    await this.stop();
    const status = await this.status();
    if (status.installed) {
      await this.runRequired(
        this.plan.remove,
        `Unable to uninstall the current-user ${this.plan.displayName} task`,
      );
    }
    await unlink(this.plan.taskXmlPath).catch((error: unknown) => {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    });
  }

  async start(): Promise<void> {
    const status = await this.status();
    if (!status.installed) {
      throw new Error(`${this.plan.displayName} service is not installed`);
    }
    await this.runRequired(
      this.plan.start,
      `Unable to start the current-user ${this.plan.displayName} task`,
    );
  }

  async stop(): Promise<void> {
    const status = await this.inspectTaskState();
    if (status.state === undefined) {
      return;
    }
    await this.runner.run(this.plan.stop);
    const finalStatus = await this.inspectTaskState();
    if (
      finalStatus.state !== undefined &&
      finalStatus.state !== WINDOWS_TASK_STATES.disabled &&
      finalStatus.state !== WINDOWS_TASK_STATES.ready
    ) {
      throw new Error(`Unable to stop the current-user ${this.plan.displayName} task`);
    }
  }

  async status(): Promise<CompanionServiceStatus> {
    const status = await this.inspectTaskState();
    if (status.state === undefined) {
      return { installed: false, running: false };
    }
    if (
      status.state === WINDOWS_TASK_STATES.unknown ||
      status.state === WINDOWS_TASK_STATES.queued
    ) {
      throw new Error(`The current-user ${this.plan.displayName} task state is indeterminate`);
    }
    return {
      installed: true,
      running: status.state === WINDOWS_TASK_STATES.running,
    };
  }

  private async resolveUserId(): Promise<string> {
    const result = await this.runner.run(this.plan.whoAmI);
    const sid = result.code === 0 ? parseWindowsUserSid(result.stdout) : undefined;
    if (sid === undefined) {
      throw new Error(
        `Unable to identify the current Windows user for the ${this.plan.displayName} task`,
      );
    }
    return sid;
  }

  private async inspectTaskState(): Promise<{ readonly state: WindowsTaskState | undefined }> {
    const result = await this.runner.run(this.plan.query);
    if (result.code !== 0) {
      throw new Error(`Unable to inspect the current-user ${this.plan.displayName} task`);
    }
    const output = result.stdout.trim();
    if (output === "missing") {
      return { state: undefined };
    }
    const stateMatch = /^state:([0-4])$/u.exec(output);
    const state = Number(stateMatch?.[1]);
    if (!isWindowsTaskState(state)) {
      throw new Error(`The current-user ${this.plan.displayName} task returned an invalid state`);
    }
    return { state };
  }

  private async runRequired(invocation: ProcessInvocation, message: string): Promise<void> {
    const result = await this.runner.run(invocation);
    if (result.code !== 0) {
      throw new Error(message);
    }
  }
}

function isWindowsTaskState(value: number): value is WindowsTaskState {
  return WINDOWS_TASK_STATE_VALUES.has(value);
}

export function createPlatformServiceController(options: {
  readonly identity: ServicePlanIdentity;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly runner?: ProcessRunner;
  readonly windowsDirectory?: string;
}): CompanionServiceController {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? new SpawnProcessRunner();
  if (platform === "darwin") {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) {
      throw new Error("Unable to identify the current macOS user for LaunchAgent installation");
    }
    return new MacOsLaunchAgentController(
      createMacOsLaunchAgentPlanForIdentity(options.identity, uid),
      runner,
    );
  }
  if (platform === "win32") {
    return new WindowsScheduledTaskController(
      createWindowsScheduledTaskPlanForIdentity(options.identity, options.windowsDirectory),
      runner,
    );
  }
  throw new Error("roll service supports macOS and Windows only");
}

async function atomicWritePrivate(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replaceAll(/(\\+)$/g, "$1$1")}"`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
