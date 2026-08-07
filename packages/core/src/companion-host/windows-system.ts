import { win32 } from "node:path";

const DEFAULT_WINDOWS_DIRECTORY = "C:\\Windows";

export function resolveWindowsDirectory(input?: string): string {
  const candidate = input ?? process.env["SystemRoot"] ?? process.env["WINDIR"];
  const normalized = win32.normalize(candidate ?? DEFAULT_WINDOWS_DIRECTORY);
  if (!win32.isAbsolute(normalized) || !/^[A-Za-z]:\\/u.test(normalized)) {
    throw new Error("Windows system directory must be an absolute local drive path");
  }
  return normalized;
}

export function resolveWindowsPowerShellExecutable(windowsDirectory?: string): string {
  return win32.join(
    resolveWindowsDirectory(windowsDirectory),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function resolveWindowsScheduledTasksExecutable(windowsDirectory?: string): string {
  return win32.join(resolveWindowsDirectory(windowsDirectory), "System32", "schtasks.exe");
}

export function resolveWindowsWhoAmIExecutable(windowsDirectory?: string): string {
  return win32.join(resolveWindowsDirectory(windowsDirectory), "System32", "whoami.exe");
}
