import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = process.env.ROLL_DIST_ROOT;
if (!root || !/^(\/[A-Za-z0-9_-][A-Za-z0-9._-]*){2,}$/.test(root)) {
  throw new Error(
    "Invalid ROLL_DIST_ROOT: use a canonical ASCII absolute path with at least two components",
  );
}
if (process.argv.length !== 3) {
  throw new Error("Usage: node render-nginx.mjs <private-output-file>");
}
const requested = resolve(process.argv[2]);
const output = join(await realpath(dirname(requested)), basename(requested));
const repository = await realpath(resolve(import.meta.dirname, "../.."));
const within = relative(repository, output);
if (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)) {
  throw new Error("Rendered deployment configuration must be outside the repository");
}
// The caller may be running from one worktree while targeting a different checkout.
for (let parent = dirname(output); ; parent = dirname(parent)) {
  let trackedRoot = false;
  try {
    await lstat(join(parent, ".git"));
    trackedRoot = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (trackedRoot) {
    throw new Error("Rendered deployment configuration must be outside the repository");
  }
  if (dirname(parent) === parent) break;
}
const template = await readFile(new URL("./nginx.conf", import.meta.url), "utf8");
await writeFile(output, template.replaceAll("__ROLL_DIST_ROOT__", root), {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Rendered private Nginx configuration; review and install it through the administrator channel.",
);
