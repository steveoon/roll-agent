import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const moduleUrl = (relative: string): string => new URL(relative, import.meta.url).href;

// Run with an isolated OS home before importing any module: scheduler and configuration helpers
// use homedir(), and mutating HOME in the test runner would race unrelated tests.
async function scenario(body: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "roll-installer-coordination-"));
  try {
    await run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--experimental-sqlite",
        "--input-type=module",
        "--eval",
        `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { activateInstallerDistribution } from ${JSON.stringify(moduleUrl("./update.ts"))};
import { resolveExecutionEnvironment, getExecutionEnvironment } from ${JSON.stringify(moduleUrl("../../execution-environment/index.ts"))};
import { acquireAgentRegistryLock } from ${JSON.stringify(moduleUrl("../../registry/agent-registry-lock.ts"))};
import { acquireSchedulerAdmissionLock } from ${JSON.stringify(moduleUrl("../../scheduler-host/scheduler-admission.ts"))};
import { AgentStore } from ${JSON.stringify(moduleUrl("../../registry/store.ts"))};
const dataDir = resolve('.roll-agent/agents');
mkdirSync(dataDir, { recursive: true });
const current = resolveExecutionEnvironment();
const targetRoot = resolve('candidate');
mkdirSync(resolve(targetRoot, 'dist/cli'), { recursive: true });
writeFileSync(resolve(targetRoot, 'dist/cli/index.js'), 'console.log(JSON.stringify({ action: "not-installed", liveInvocations: 0 }));');
const target = { ...current, installation: { channel: 'standalone', version: '9.0.0', packageRoot: targetRoot } };
let activated = 0;
let disposed = 0;
const prepared = {
  version: '9.0.0',
  activate: async () => {
    assert.equal(getExecutionEnvironment(), current);
    assert.throws(() => acquireSchedulerAdmissionLock());
    assert.throws(() => acquireAgentRegistryLock(dataDir));
    activated++;
    return target;
  },
  dispose: async () => { disposed++; },
};
function assertReleased() {
  acquireAgentRegistryLock(dataDir).release();
  acquireSchedulerAdmissionLock().release();
  assert.equal(disposed, 0, 'caller retains disposal ownership');
}
${body}
`,
      ],
      {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("installer activates while holding admission/registry, leaves Agent records unchanged", async () => {
  await scenario(`
const store = new AgentStore(dataDir);
store.add({
  skill: { name: 'external-agent', description: 'External fixture', metadata: {} },
  transport: { type: 'streamable-http', endpoint: 'https://example.invalid/mcp' },
  runtime: { ownership: 'external' },
  installPath: process.cwd(), registeredAt: new Date().toISOString(), status: 'idle',
});
const before = readFileSync(resolve(dataDir, 'agents.json'), 'utf8');
const result = await activateInstallerDistribution(current, prepared);
assert.equal(result.environment, target);
assert.equal(activated, 1);
assert.equal(readFileSync(resolve(dataDir, 'agents.json'), 'utf8'), before);
assertReleased();
`);
});

test("installer refuses malformed configuration before activation", async () => {
  await scenario(`
writeFileSync('roll.config.yaml', 'agents: [broken');
await assert.rejects(activateInstallerDistribution(current, prepared));
assert.equal(activated, 0);
assertReleased();
`);
});

test("installer refuses registry records that permissive loading would discard", async () => {
  await scenario(`
writeFileSync(resolve(dataDir, 'agents.json'), JSON.stringify({ agents: [{ broken: true }] }));
await assert.rejects(activateInstallerDistribution(current, prepared), /无法解析/);
assert.equal(activated, 0);
assertReleased();
`);
});

test("installer refuses a managed Agent with unreadable runtime identity", async () => {
  await scenario(`
new AgentStore(dataDir).add({
  skill: { name: 'managed-agent', description: 'Managed fixture', metadata: {} },
  transport: { type: 'streamable-http', endpoint: 'http://127.0.0.1:4321/mcp' },
  runtime: { ownership: 'core-managed', start: { command: 'node', args: ['unused.js'] }, endpoint: { path: '/mcp', port: 4321 } },
  installPath: process.cwd(), registeredAt: new Date().toISOString(), status: 'online',
});
mkdirSync(resolve(dataDir, 'pids'), { recursive: true });
writeFileSync(resolve(dataDir, 'pids/managed-agent.runtime.json'), 'broken runtime');
writeFileSync(resolve(dataDir, 'pids/managed-agent.pid'), String(process.pid));
await assert.rejects(activateInstallerDistribution(current, prepared));
assert.equal(activated, 0);
assert.equal(existsSync(resolve(dataDir, 'pids/managed-agent.runtime.json')), true);
assertReleased();
`);
});

test("failed activation preserves the error and releases admission without disposing payload", async () => {
  await scenario(`
const failure = new Error('pointer replacement blocked');
prepared.activate = async () => { throw failure; };
await assert.rejects(activateInstallerDistribution(current, prepared), error => error === failure);
assert.equal(activated, 0);
assertReleased();
`);
});

test("scheduler failure after activation returns warnings while retaining the new environment", async () => {
  await scenario(`
writeFileSync(resolve(targetRoot, 'dist/cli/index.js'), 'process.exit(17);');
const result = await activateInstallerDistribution(current, prepared);
assert.equal(result.environment, target);
assert.equal(activated, 1);
if (process.platform === 'darwin' || process.platform === 'win32') {
  assert.ok(result.warnings.some(message => message.includes('scheduler') || message.includes('schedule daemon')));
}
assertReleased();
`);
});

test("installer refuses invalid scheduler service metadata while keeping the pointer unchanged", async () => {
  await scenario(`
writeFileSync(resolve('.roll-agent/scheduler-service.json'), '{broken metadata');
await assert.rejects(activateInstallerDistribution(current, prepared), /scheduler service metadata/);
assert.equal(activated, 0);
assertReleased();
`);
});

test("installer refuses interrupted scheduler service installation", async () => {
  await scenario(`
writeFileSync(resolve('.roll-agent/scheduler-service.json'), JSON.stringify({
  schemaVersion: 1, phase: 'installing', dataDir: resolve('old-scheduler'), maxConcurrentRuns: 1,
}));
await assert.rejects(activateInstallerDistribution(current, prepared), /scheduler service 正在安装/);
assert.equal(activated, 0);
assertReleased();
`);
});

for (const status of ["claimed", "running"] as const) {
  test(`installer refuses ${status} tasks in the installed service's different data directory`, async () => {
    await scenario(`
const runtime = await import(${JSON.stringify(moduleUrl("../../../../runtime/src/index.ts"))});
const schedulerDataDir = resolve('installed-service-ledger');
const ledger = new runtime.ScheduleStore(schedulerDataDir);
const now = Date.now();
ledger.createSchedule({ name: 'active-task', prompt: 'fixture', cwd: process.cwd(), trigger: runtime.createIntervalTrigger('1h'), fireImmediately: true }, now);
const claim = ledger.claimDue({ workerId: 'inline-999999', nowMs: now, limit: 1 })[0];
assert.ok(claim);
if (${JSON.stringify(status)} === 'running') {
  ledger.beginInvocation(claim.invocation.id, claim.ownershipToken, now + 1, { pid: 999999, startToken: 'pst-v2:unknown-fixture' });
}
ledger.close();
writeFileSync(resolve('.roll-agent/scheduler-service.json'), JSON.stringify({
  schemaVersion: 1, phase: 'installed', dataDir: schedulerDataDir, maxConcurrentRuns: 1,
}));
await assert.rejects(activateInstallerDistribution(current, prepared), /scheduler 仍有 1 个/);
assert.equal(activated, 0);
const reopened = new runtime.ScheduleStore(schedulerDataDir);
assert.equal(reopened.listOccupyingInvocations().length, 1);
reopened.close();
assertReleased();
`);
  });
}

test("installer refuses a foreground daemon with unparseable identity", async () => {
  await scenario(`
mkdirSync(resolve('.roll-agent/scheduler'), { recursive: true });
writeFileSync(resolve('.roll-agent/scheduler/daemon.json'), 'unknown daemon');
await assert.rejects(activateInstallerDistribution(current, prepared), /scheduler daemon 身份/);
assert.equal(activated, 0);
assertReleased();
`);
});
