import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { renderWindowsCliFiles } from "./current-cli-windows.ts";

const windowsOnly = { skip: process.platform !== "win32", timeout: 60_000 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(50);
  }
}

function taskkill(pid: number): void {
  spawnSync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { windowsHide: true, timeout: 10_000, stdio: "ignore" },
  );
}

function prepareProbe(root: string): { readonly pidFile: string; readonly signalFile: string } {
  const pidFile = join(root, "pids.json");
  const signalFile = join(root, "sigint.txt");
  const entry = join(root, "probe 中文.mjs");
  writeFileSync(
    entry,
    `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
const child=spawn(process.env.ROLL_PROBE_NODE,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.once('error',error=>{console.error(error);process.exit(1)});
writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({node:process.pid,child:child.pid}));
process.on('SIGINT',()=>{writeFileSync(${JSON.stringify(signalFile)},'SIGINT');process.exit(130)});
setInterval(()=>{},1000);`,
  );
  const files = renderWindowsCliFiles(
    [process.execPath, entry],
    process.env.SystemRoot ?? "C:\\Windows",
  );
  assert.ok(files["launch.ps1"], "Unicode fixed launch forces the actual native bridge");
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  return { pidFile, signalFile };
}

function readPids(path: string): { readonly node: number; readonly child: number } {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(value !== null && typeof value === "object" && "node" in value && "child" in value);
  assert.equal(typeof value.node, "number");
  assert.equal(typeof value.child, "number");
  assert.ok(typeof value.node === "number" && typeof value.child === "number");
  return { node: value.node, child: value.child };
}

test(
  "Windows native CLI remains in the tool tree and taskkill spares an unrelated process",
  windowsOnly,
  async () => {
    const root = mkdtempSync(join(tmpdir(), "roll-cli-tree-test-"));
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    let wrapper: ReturnType<typeof spawn> | undefined;
    try {
      const { pidFile } = prepareProbe(root);
      wrapper = spawn(`"${join(root, "roll.cmd")}"`, {
        shell: true,
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, ROLL_PROBE_NODE: process.execPath },
      });
      await until(() => existsSync(pidFile), "native child started");
      const pids = readPids(pidFile);
      assert.ok(wrapper.pid && sentinel.pid);
      assert.ok(alive(pids.node) && alive(pids.child));
      taskkill(wrapper.pid);
      await until(
        () => !alive(pids.node) && !alive(pids.child),
        "native child and grandchild settled",
      );
      assert.equal(alive(sentinel.pid), true);
    } finally {
      if (wrapper?.pid && wrapper.exitCode === null) taskkill(wrapper.pid);
      sentinel.kill();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
);

// This fixture creates its own hidden console. Ctrl+C is broadcast only to that
// console, never the user's terminal. The helper's native handler protects only
// itself; the batch, bridge and Node retain their normal console handlers.
const CONSOLE_PROBE = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RollConsoleProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string reserved,desktop,title; public int x,y,width,height,xchars,ychars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFO { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder line,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESS_INFO process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  delegate bool Handler(uint kind);
  static Handler protect=delegate(uint kind){return true;};
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(Handler handler,bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint kind,uint group);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
  public static string Run(string cmd,string line,string cwd,string ready){
    STARTUPINFO startup=new STARTUPINFO();startup.cb=Marshal.SizeOf(typeof(STARTUPINFO));startup.flags=1;startup.show=0;
    PROCESS_INFO child;
    Check(CreateProcessW(cmd,new StringBuilder(line),IntPtr.Zero,IntPtr.Zero,false,0x10,IntPtr.Zero,cwd,ref startup,out child));
    try {
      for(int i=0;i<500 && !System.IO.File.Exists(ready);i++)System.Threading.Thread.Sleep(50);
      if(!System.IO.File.Exists(ready))throw new Exception("Console child did not start");
      FreeConsole();Check(AttachConsole(child.pid));Check(SetConsoleCtrlHandler(protect,true));
      Check(GenerateConsoleCtrlEvent(0,0));System.Threading.Thread.Sleep(1000);FreeConsole();
      WaitForSingleObject(child.process,5000);uint code;Check(GetExitCodeProcess(child.process,out code));
      return child.pid.ToString()+","+code.ToString();
    } finally {CloseHandle(child.thread);CloseHandle(child.process);}
  }
}
'@
$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__DATA__'))|ConvertFrom-Json
$cmd=if($data.direct){Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'}else{Join-Path $env:SystemRoot 'System32\cmd.exe'}
$line=if($data.direct){$data.line}else{'"'+$cmd+'" /d /s /c ""'+$data.shim+'""'}
$pidValue=[RollConsoleProbe]::Run($cmd,$line,$data.root,$data.ready)
[IO.File]::WriteAllText($data.owner,[string]$pidValue)
`;

test(
  "Windows native CLI receives ordinary console Ctrl+C without detaching",
  windowsOnly,
  async () => {
    for (const direct of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "roll-cli-console-test-"));
      const owner = join(root, "console-owner.txt");
      const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      try {
        const { pidFile, signalFile } = prepareProbe(root);
        const line = readFileSync(join(root, "roll.cmd"), "utf8")
          .split("\r\n")
          .find((value) => value.includes(" -File "))
          ?.replaceAll("%~dp0", root + "\\")
          .replace(/ %\*$/u, "");
        assert.ok(line);
        const data = Buffer.from(
          JSON.stringify({
            root,
            ready: pidFile,
            owner,
            shim: join(root, "roll.cmd"),
            direct,
            line,
          }),
          "utf8",
        ).toString("base64");
        const script = join(root, "console-probe.ps1");
        writeFileSync(script, CONSOLE_PROBE.replace("__DATA__", data));
        const result = spawnSync(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
          ],
          {
            env: { ...process.env, ROLL_PROBE_NODE: process.execPath },
            encoding: "utf8",
            timeout: 35_000,
            windowsHide: true,
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        await until(() => existsSync(signalFile), "Node received real Ctrl+C console event");
        const pids = readPids(pidFile);
        await until(
          () => !alive(pids.node) && !alive(pids.child),
          "console descendants exited naturally",
        );
        assert.ok(sentinel.pid);
        assert.equal(alive(sentinel.pid), true);
        assert.equal(readFileSync(signalFile, "utf8"), "SIGINT");
        if (direct) {
          assert.equal(
            readFileSync(owner, "utf8").split(",")[1],
            "130",
            "Bridge must preserve the child's interrupt exit status",
          );
        }
      } finally {
        // CMD may retain its ordinary Terminate batch job? prompt after Ctrl+C.
        if (existsSync(owner)) taskkill(Number(readFileSync(owner, "utf8").split(",")[0]));
        sentinel.kill();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  },
);
