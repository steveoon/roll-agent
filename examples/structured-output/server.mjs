import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const relayUrl = new URL(required("DEMO_RELAY_URL"));
if (
  relayUrl.protocol !== "https:" &&
  !(relayUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(relayUrl.hostname))
) {
  throw new Error("Use HTTPS except for an isolated loopback relay");
}
const workspaceId = required("DEMO_WORKSPACE_ID");
const appKey = required("DEMO_RELAY_APP_KEY");
// Demonstration authentication only; production must use its existing authenticated subject mapping.
const expectedAuth = `Basic ${Buffer.from(`demo:${required("DEMO_PASSWORD")}`).toString("base64")}`;
const port = Number(process.env.DEMO_PORT ?? 9441);
const origin = `http://127.0.0.1:${port}`;
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/web.js", ["web.js", "text/javascript; charset=utf-8"]],
]);
function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Set ${key}`);
  return value;
}
function digest(value) {
  return createHash("sha256").update(value).digest();
}
createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  if (
    request.headers.host !== `127.0.0.1:${port}` ||
    !timingSafeEqual(digest(request.headers.authorization ?? ""), digest(expectedAuth))
  ) {
    response.writeHead(401, { "www-authenticate": 'Basic realm="Roll isolated demo"' });
    response.end("Authentication required");
    return;
  }
  try {
    if (request.method === "POST" && request.url === "/api/roll/session") {
      if (request.headers.origin !== origin) {
        response.writeHead(403);
        response.end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 2048) {
          response.writeHead(413);
          response.end();
          return;
        }
      }
      const input = JSON.parse(body);
      const versions = input.supportedRelayProtocolVersions;
      if (
        !Array.isArray(versions) ||
        !versions.every((version) => version === "1.2" || version === "1.1")
      ) {
        response.writeHead(400);
        response.end();
        return;
      }
      const upstream = await fetch(new URL("/v1/browser-sessions", relayUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, supportedRelayProtocolVersions: versions }),
        signal: AbortSignal.timeout(10000),
      });
      if (!upstream.ok) {
        response.writeHead(upstream.status);
        response.end("Relay session unavailable");
        return;
      }
      const session = await upstream.json();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ connectUrl: session.connectUrl, expiresAt: session.expiresAt }),
      );
      return;
    }
    const file = request.method === "GET" ? staticFiles.get(request.url) : undefined;
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    const bytes = await readFile(new URL(`./dist/${file[0]}`, import.meta.url));
    response.writeHead(200, { "content-type": file[1] });
    response.end(bytes);
  } catch {
    response.writeHead(502);
    response.end("Request failed");
  }
}).listen(port, "127.0.0.1", () =>
  process.stderr.write(`Open ${origin}; sign in as demo with DEMO_PASSWORD.\n`),
);
