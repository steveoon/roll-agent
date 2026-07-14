import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RollUiStaticAsset, RollUiStaticAssetProvider } from "./contracts.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createFileSystemStaticAssetProvider(
  rootDirectory: string,
): RollUiStaticAssetProvider {
  const configuredRoot = resolve(rootDirectory);

  return {
    async getAsset(pathname): Promise<RollUiStaticAsset | null> {
      const relativePath = toSafeRelativeAssetPath(pathname);
      if (relativePath === null) return null;

      let trustedRoot: string;
      let candidate: string;
      try {
        trustedRoot = await realpath(configuredRoot);
        candidate = await realpath(resolve(trustedRoot, relativePath));
      } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
      }

      if (!isPathInside(trustedRoot, candidate)) return null;
      const candidateStat = await stat(candidate);
      if (!candidateStat.isFile()) return null;

      return {
        body: await readFile(candidate),
        contentType: CONTENT_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream",
      };
    },
  };
}

function toSafeRelativeAssetPath(pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname.includes("\0") || pathname.includes("\\")) {
    return null;
  }
  const segments = pathname.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
