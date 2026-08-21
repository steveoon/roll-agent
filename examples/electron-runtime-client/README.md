# Thin Electron Runtime Protocol reference

This is intentionally an Electron adapter, not a second Roll client
implementation:

- `main.ts` owns `@roll-agent/client-node`, the child process, stderr, and IPC.
- `preload.ts` exposes named Thread/Turn methods plus `onApprovalRequest(handler)` and
  `onUserInputRequest(handler)`, never a generic `request(method, params)` escape hatch.
- `renderer.ts` only renders events, sends named commands, and completes typed Approval/User Input
  handlers. It never constructs a Server Response or a JSON-RPC id.

## Scope

This example is local-only:

```text
Electron Renderer → preload IPC → Electron Main → @roll-agent/client-node → local Runtime
```

It intentionally does not import `@roll-agent/companion` or
`@roll-agent/relay-protocol`, does not connect to a Cloud Relay, and does not enable remote
Browser access. Installing `@roll-agent/core` makes both Runtime and Companion management commands
available, but does not enroll, install or start the Companion service.

If a product later adds remote Web access, prefer the separate official `roll companion` service
and `@roll-agent/relay-client`; do not move raw Relay handling into Electron Main or Renderer. A
version-locked OEM may use the low-level Companion package, but owns that security boundary. The
Renderer must still stay behind named preload IPC.

For a third-party local-only Electron host, the Roll-side application dependencies are
`@roll-agent/client-node` plus `@roll-agent/protocol` when it imports protocol constants, schemas,
or DTO types. `@roll-agent/companion` is not part of this reference's dependency set.

Build the reference from the repository root:

```bash
pnpm verify:example:electron
```

The build intentionally emits three different targets into the ignored
`examples/electron-runtime-client/dist/` directory:

| Output | Format | Reason |
|---|---|---|
| `main.js` | Node ESM | The Electron main process and Roll packages are ESM |
| `preload.cjs` | Bundled CommonJS | Sandboxed Electron preloads cannot use the ESM loader |
| `renderer.js` | Browser ESM | The renderer has no Node.js access |

The verifier runs the pure renderer-interaction registry tests, enforces explicit raw/gzip renderer
bundle budgets, and checks those boundaries as well as the CSP, sandbox, and absence of the
blocking `window.confirm()` API. To run the built example, install Electron
in a host project whose `package.json` points `main` at this `dist/main.js`, then
start Electron with `--workspace=/absolute/path/to/project`.

The example also enables context isolation and sandboxing, validates each IPC
sender, blocks navigation/new windows, and supplies a restrictive CSP. Do not
expose API keys, environment variables, arbitrary process spawning, a generic
Runtime request method, or a raw `ipcRenderer` object to the renderer.

This reference accepts every Runtime Protocol version with Server Request support — currently `"1.4"`,
`"1.3"`, `"1.2"`, and the `"1.1"` fallback — derived from `SUPPORTED_RUNTIME_PROTOCOL_VERSIONS` so it
tracks `@roll-agent/protocol` automatically. Its startup
`approval.request` and named `userInput.request` handlers are included in the 1.4/1.3/1.2
`client.capabilities.set` handshake, so `RollNodeClient.start()` does not resolve until Runtime has
acknowledged those capabilities. When negotiation falls back to 1.1, Approval remains available
and User Input is not advertised or delivered.

Main owns each renderer-local request token and binds it to the exact method, `webContents`, and
main-document generation. Main-frame navigation/reload, renderer exit, destroyed/closed windows,
and Runtime cancellation invalidate the token through one settlement registry. Wrong-window,
wrong-method, old-generation, duplicate, and late responses cannot consume another valid pending
interaction. The renderer token is never treated as a Runtime JSON-RPC `id`, 1.4/1.3/1.2 `interactionId`,
or mutation `requestId`.

The User Input dialog renders all five 1.4/1.3/1.2 controls (`text`, `multiline`, `number`, `boolean`, and
`choice`) with DOM `createElement()`/`textContent` APIs. Escape and Cancel return a normal
`{ status: "cancelled" }` result. Submitted values travel only over the named result IPC and are
validated again against the original request in Main; they are not copied into logs or Runtime
event output. The preload exposes neither raw `ipcRenderer` nor an untyped generic interaction API.
