const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com"] as const;

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

export function executableLookupKey(argv0: string, platform: NodeJS.Platform): string {
  const name = basename(argv0);
  if (platform !== "win32") {
    return name;
  }
  const lowered = name.toLowerCase();
  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      return lowered.slice(0, -suffix.length);
    }
  }
  return lowered;
}
