// The signed URL is a bearer credential. Only the private ticket file crosses the SSH stdin pipe.
import { writeFile } from "node:fs/promises";

const [artifactId, ticketFile] = process.argv.slice(2);
const { GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
if (!/^\d+$/.test(artifactId) || !repository || !token || !ticketFile) {
  throw new Error("Expected an artifact ID, ticket file and GitHub credentials");
}
const api = `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`;
const options = {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  redirect: "manual",
};
async function request(url, status) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  } catch {
    console.error("GitHub artifact API connection failed");
    process.exit(75);
  }
  if (response.status !== status) {
    console.error(`GitHub artifact API returned HTTP ${response.status}`);
    process.exit(response.status === 429 || response.status >= 500 ? 75 : 1);
  }
  return response;
}
const artifact = await (await request(api, 200)).json();
if (
  String(artifact.id) !== artifactId ||
  artifact.name !== "standalone-publication" ||
  artifact.expired !== false ||
  !Number.isSafeInteger(artifact.size_in_bytes) ||
  artifact.size_in_bytes < 1 ||
  !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)
) {
  throw new Error("Invalid or expired publication artifact");
}
const redirect = await request(`${api}/zip`, 302);
const location = redirect.headers.get("location");
if (!location || !location.startsWith("https://")) throw new Error("Missing HTTPS download URL");
await writeFile(
  ticketFile,
  JSON.stringify({ url: location, size: artifact.size_in_bytes, sha256: artifact.digest.slice(7) }),
  { mode: 0o600 },
);
