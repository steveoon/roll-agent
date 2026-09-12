import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertVersion } from "./metadata.mjs";

const CORE_MANIFEST = "packages/core/package.json";

/** Resolve once before the matrix so later main/tag movement cannot change its inputs. */
export function resolveDistributionSource(root, { published = false } = {}) {
  const current = JSON.parse(readFileSync(resolve(root, CORE_MANIFEST), "utf8"));
  if (current.name !== "@roll-agent/core") throw new Error("Expected the Core package manifest");
  const version = assertVersion(current.version);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const sourceRef = published ? `refs/tags/@roll-agent/core@${version}^{commit}` : "HEAD";
  let sha;
  try {
    sha = git(["rev-parse", "--verify", sourceRef]);
  } catch (cause) {
    throw new Error(
      `Cannot resolve distribution source ${sourceRef}; a published Core release tag is required for publication`,
      { cause },
    );
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Distribution source must be a full commit SHA");
  if (published) {
    try {
      git(["merge-base", "--is-ancestor", sha, "HEAD"]);
    } catch (cause) {
      throw new Error("Published Core source is not an ancestor of the workflow commit", { cause });
    }
  }
  const sourceManifest = JSON.parse(git(["show", `${sha}:${CORE_MANIFEST}`]));
  if (sourceManifest.name !== current.name || sourceManifest.version !== version) {
    throw new Error(`Distribution source does not contain @roll-agent/core@${version}`);
  }
  return { sha, version };
}

async function main() {
  const publish = process.env.ROLL_DISTRIBUTION_PUBLISH;
  if (publish !== "true" && publish !== "false") {
    throw new Error("ROLL_DISTRIBUTION_PUBLISH must be true or false");
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const { sha, version } = resolveDistributionSource(resolve(import.meta.dirname, "../.."), {
    published: publish === "true",
  });
  console.log(
    `Standalone Roll ${version} source: ${sha} (${publish === "true" ? "published release" : "preview"})`,
  );
  await appendFile(process.env.GITHUB_OUTPUT, `source_sha=${sha}\nversion=${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
