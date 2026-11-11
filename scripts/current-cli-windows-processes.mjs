// Bounded validation helpers. All actions target one fixture-owned process tree/window.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function waitUntil(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error("Timed out: " + label);
}

export function readWindowsProcessTree(pid) {
  assert.equal(process.platform, "win32");
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const source = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process); $owned=New-Object 'System.Collections.Generic.HashSet[uint32]'; [void]$owned.Add(${pid}); do { $changed=$false; foreach($row in $rows){if($owned.Contains([uint32]$row.ParentProcessId) -and $owned.Add([uint32]$row.ProcessId)){$changed=$true}} }while($changed); @($rows | Where-Object {$owned.Contains([uint32]$_.ProcessId)} | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress`;
  const result = spawnSync(
    `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || "[]");
}

export async function operatePackagedWindow(port, action) {
  let target;
  await waitUntil(async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find((row) => row.type === "page" && row.url.includes("index.html"));
      return !!target;
    } catch {
      return false;
    }
  }, "packaged renderer debugging endpoint");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const expression =
    action === "start"
      ? `(async()=>{let input;for(let attempt=0;!input || input.disabled;attempt++){if(attempt>150)throw new Error('Production composer unavailable');input=document.getElementById('message-input');await new Promise(resolve=>setTimeout(resolve,50));}Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Validate nested CLI cancellation');input.dispatchEvent(new Event('input',{bubbles:true}));for(let attempt=0;document.getElementById('send-message')?.disabled;attempt++){if(attempt>100)throw new Error('Production Send unavailable');await new Promise(resolve=>setTimeout(resolve,20));}document.getElementById('composer').requestSubmit();return 'submitted';})()`
      : action === "cancel"
        ? `(() => { const button=document.getElementById('cancel-turn'); if(!button || button.disabled) throw new Error('Production Stop button unavailable: '+document.body.innerText.slice(0,1000)); button.click(); return 'stop-dispatched'; })()`
        : "window.close(); 'close-dispatched'";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Packaged window action timed out")), 10000);
      const finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener(
        "close",
        () =>
          finish(
            action === "close" ? undefined : new Error("Window closed before Stop acknowledgement"),
          ),
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        const row = JSON.parse(event.data);
        if (row.id !== 1) return;
        const closedContext =
          action === "close" &&
          row.error?.code === -32000 &&
          /Execution context was destroyed|Target closed/iu.test(row.error.message);
        finish(
          !closedContext && (row.error || row.result?.exceptionDetails)
            ? new Error(`Packaged ${action}: ${JSON.stringify(row)}`)
            : undefined,
        );
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  } finally {
    socket.close();
  }
}
