import { randomUUID } from "node:crypto";
import { win32 } from "node:path";

const CMD_UNSAFE = /["%!^&|<>]/u;
// CMD reads a batch file in the console code page. Keep its source ASCII rather
// than changing a user's console code page or corrupting Unicode launch values.
const NON_ASCII = /[^\u0020-\u007e]/u;
const DOS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

/** Only change namespaces when ordinary Win32 parsing preserves every component. */
function ordinaryExecutablePath(path: string): string | undefined {
  const candidate = /^\\\\\?\\UNC\\/iu.test(path)
    ? `\\\\${path.slice(8)}`
    : /^\\\\\?\\[a-z]:\\/iu.test(path)
      ? path.slice(4)
      : path;
  if (hasControlCharacters(candidate) || /["<>|]/u.test(candidate) || candidate.includes("/")) {
    return undefined;
  }
  const drive = /^[a-z]:\\/iu.test(candidate);
  const unc = /^\\\\[^\\]+\\[^\\]+\\/u.test(candidate);
  if (!drive && !unc) return undefined;
  const components = candidate.slice(drive ? 3 : 2).split("\\");
  if (
    components.some(
      (component) =>
        !component ||
        /[ .]$/u.test(component) ||
        /[:?*]/u.test(component) ||
        DOS_DEVICE.test(component),
    )
  ) {
    return undefined;
  }
  return candidate;
}

export function cmdExecutablePath(path: string): string | undefined {
  const ordinary = ordinaryExecutablePath(path);
  return ordinary !== undefined && ordinary.length < 260 && !CMD_UNSAFE.test(ordinary)
    ? ordinary
    : undefined;
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

// PowerShell hosts this native call; no child data passes through its pipeline or $args.
// No job, detached flag, new process group, tree killing or parent monitoring is added.
const NATIVE_BRIDGE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ROLL_LAUNCH_DATA__')) | ConvertFrom-Json
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class RollCurrentCli {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved,desktop,title;
    public int x,y,width,height,xchars,ychars,fill,flags;
    public short show,reserved2; public IntPtr reservedPtr,stdin,stdout,stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFO { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string app,StringBuilder line,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFO process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetCommandLineW();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetConsoleCP();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach(char character in value) {
      if(character=='\\') { slashes++; continue; }
      if(character=='"') { result.Append('\\',slashes*2+1).Append(character); slashes=0; continue; }
      result.Append('\\',slashes).Append(character); slashes=0;
    }
    return result.Append('\\',slashes*2).Append('"').ToString();
  }
  public static int Run(string[] command,string marker) {
    string raw=Marshal.PtrToStringUni(GetCommandLineW());
    string delimiter=" "+marker;
    int boundary=raw.IndexOf(delimiter,StringComparison.Ordinal);
    if(boundary<0) throw new Exception("Missing current CLI argument boundary");
    int tail=boundary+delimiter.Length;
    if(tail<raw.Length && !Char.IsWhiteSpace(raw[tail])) throw new Exception("Invalid current CLI argument boundary");
    StringBuilder line=new StringBuilder();
    foreach(string argument in command) {
      if(line.Length>0) line.Append(' ');
      line.Append(Quote(argument));
    }
    line.Append(raw.Substring(tail));
    IntPtr self=GetCurrentProcess(), list=IntPtr.Zero, handles=IntPtr.Zero;
    IntPtr[] duplicates=new IntPtr[3]; bool initialized=false;
    PROCESS_INFO child=new PROCESS_INFO();
    try {
      int count=0;
      for(int index=0;index<3;index++) {
        IntPtr handle=GetStdHandle(-10-index);
        if(handle==IntPtr.Zero || handle==new IntPtr(-1)) continue;
        Check(DuplicateHandle(self,handle,self,out duplicates[index],0,true,2));
        count++;
      }
      STARTUPINFOEX startup=new STARTUPINFOEX();
      startup.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.startup.flags=0x100;
      startup.startup.stdin=duplicates[0]; startup.startup.stdout=duplicates[1]; startup.startup.stderr=duplicates[2];
      if(count>0) {
        IntPtr size=IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        list=Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(list,1,0,ref size)); initialized=true;
        handles=Marshal.AllocHGlobal(count*IntPtr.Size); int offset=0;
        foreach(IntPtr handle in duplicates) if(handle!=IntPtr.Zero) { Marshal.WriteIntPtr(handles,offset,handle); offset+=IntPtr.Size; }
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(count*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        startup.attributes=list;
      }
      // NULL cwd/env preserve the invoking tool's workspace/environment, including its Job.
      // Preserve an existing console for Ctrl+C; do not create a console in a headless tool.
      uint flags=0x80000u | (GetConsoleCP()==0 ? 0x08000000u : 0u);
      Check(CreateProcessW(command[0],line,IntPtr.Zero,IntPtr.Zero,count>0,flags,IntPtr.Zero,null,ref startup,out child));
    } finally {
      foreach(IntPtr handle in duplicates) if(handle!=IntPtr.Zero) CloseHandle(handle);
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
    try {
      if(WaitForSingleObject(child.process,0xffffffff)!=0) Check(false);
      uint code; Check(GetExitCodeProcess(child.process,out code));
      return unchecked((int)code);
    } finally {
      CloseHandle(child.thread); CloseHandle(child.process);
    }
  }
}
'@
try {
  Add-Type -TypeDefinition $source
  $code = [RollCurrentCli]::Run([string[]]$launch.command, [string]$launch.marker)
  exit $code
} catch {
  [Console]::Error.WriteLine('Roll CLI launch failed: ' + $_.Exception.Message)
  exit 1
}
`;

export function renderWindowsCliFiles(
  command: readonly string[],
  systemRoot: string,
): Readonly<Record<string, string>> {
  const executable = command[0];
  if (!executable) throw new Error("无法确定当前 Roll Node 路径");
  if (command.some((value) => value.includes("\0"))) {
    throw new Error("Windows CLI 启动参数不能包含 NUL 字符");
  }
  const cmdPath = cmdExecutablePath(executable);
  const simple =
    cmdPath !== undefined &&
    !NON_ASCII.test(cmdPath) &&
    command.slice(1).every((value) => !CMD_UNSAFE.test(value) && !NON_ASCII.test(value));
  const start = ["@echo off", "setlocal DisableDelayedExpansion"];
  if (simple) {
    return {
      "roll.cmd": [
        ...start,
        `${[cmdPath, ...command.slice(1)].map(quoteWindowsArgument).join(" ")} %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
    };
  }
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powershellCmd = cmdExecutablePath(powershell);
  if (powershellCmd === undefined || NON_ASCII.test(powershellCmd)) {
    throw new Error("无法确定可供 CMD 启动的系统 PowerShell 路径");
  }
  const marker = `--roll-cli-${randomUUID()}`;
  // CreateProcessW also needs an extended path for a genuinely deep executable.
  // Preserve existing namespaces verbatim; add one only to equivalent canonical paths.
  const nativeExecutable = executable.startsWith("\\\\?\\")
    ? executable
    : ordinaryExecutablePath(executable) === undefined
      ? executable
      : win32.toNamespacedPath(executable);
  const data = Buffer.from(
    JSON.stringify({ command: [nativeExecutable, ...command.slice(1)], marker }),
    "utf8",
  ).toString("base64");
  return {
    "roll.cmd": [
      ...start,
      `${quoteWindowsArgument(powershellCmd)} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0launch.ps1" ${marker} %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "launch.ps1": NATIVE_BRIDGE.replace("__ROLL_LAUNCH_DATA__", data),
  };
}
