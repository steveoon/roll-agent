# Structured output example

This opt-in, read-only Subagent returns three fictional candidates as `example.candidates` version 1.
Electron renders cards; this Web application renders a sortable comparison table. No component code is
transmitted by the Agent. Unknown contracts fall back to bounded JSON.

From the Roll repository root, after the pinned workspace dependencies have been installed:

```sh
node examples/structured-output/build.mjs
roll agent add ./examples/structured-output
```

Use a separate test Roll configuration, registry and Companion Workspace. This example never enrolls,
unpairs or changes the user's existing Companion. In Electron, connect to that workspace and ask:
“Use structured-output-demo list_candidates once.”

For Web, pair the test Workspace using the normal Relay enrollment flow. Explicitly allow
`structured-output-demo` / `list_candidates` in the local host's remote application-output policy.
The tool's `remoteReadable` declaration alone does not grant remote access. Allow the exact origin
`http://127.0.0.1:9441` in the isolated Relay's origin list.

Provide these variables through your secret manager or isolated environment (never browser code):

- `DEMO_RELAY_URL`: HTTPS Relay URL, or HTTP loopback URL for local testing.
- `DEMO_WORKSPACE_ID`: already paired test Workspace; fixed server-side.
- `DEMO_RELAY_APP_KEY`: Relay application key.
- `DEMO_PASSWORD`: a dedicated password for the example's HTTP Basic login.
- `DEMO_PORT`: optional, default 9441.

```sh
node examples/structured-output/server.mjs
```

Open `http://127.0.0.1:9441`, sign in as `demo`, connect, create a conversation, then list the synthetic
candidates. Refresh the page and use **Open history** to load the saved result again. The application
backend exchanges authenticated requests for short-lived Relay tickets and never accepts a Workspace
ID from the browser. For production, replace demo Basic authentication with your existing identity
system and a persisted subject-to-Workspace mapping; serve the application over HTTPS.

The client reports result errors without retrying tool execution. Browser refresh only reads history;
it never repeats a mutation. Use a Relay 1.2 / Runtime 1.5 chain for application results. Older versions
continue ordinary chat but cannot provide this result channel.

For isolated GUI acceptance only, `node examples/structured-output/build.mjs --loopback-qa` builds a
test adapter that maps WSS descriptors to plain WS **only** when both the page and Relay host are exactly
`127.0.0.1`. It uses the SDK's testing transport injection; production SDK validation and the normal
build remain WSS-only. A test with this adapter verifies framing/routing/UI but does not verify TLS.
Rebuild without the flag before distributing the example.
