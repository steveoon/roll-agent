# Thin Electron Runtime Protocol reference

This is intentionally an Electron adapter, not a second Roll client
implementation:

- `main.ts` owns `@roll-agent/client-node`, the child process, stderr, and IPC.
- `preload.ts` exposes named Thread/Turn methods plus
  `onApprovalRequest(handler)`, never a generic `request(method, params)` escape hatch.
- `renderer.ts` only renders events, sends named commands, and returns a decision from the
  approval handler. It never constructs `approval.respond` or a JSON-RPC id.

## Scope

This example is local-only:

```text
Electron Renderer → preload IPC → Electron Main → @roll-agent/client-node → local Runtime
```

It intentionally does not import `@roll-agent/companion` or
`@roll-agent/relay-protocol`, does not connect to a Cloud Relay, and does not enable remote
Browser access. Installing `@roll-agent/core` only makes the `roll` Runtime command available; it
does not install or start Companion.

If a product later adds remote Web access, the Electron Main process—or a separate local
daemon—must explicitly host `@roll-agent/companion`, complete device/Workspace pairing, and start
an authenticated outbound Relay connection. The Renderer must still stay behind named preload
IPC.

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

The verifier checks those boundaries as well as the CSP, sandbox, and absence of
the blocking `window.confirm()` API. To run the built example, install Electron
in a host project whose `package.json` points `main` at this `dist/main.js`, then
start Electron with `--workspace=/absolute/path/to/project`.

The example also enables context isolation and sandboxing, validates each IPC
sender, blocks navigation/new windows, and supplies a restrictive CSP. Do not
expose API keys, environment variables, arbitrary process spawning, a generic
Runtime request method, or a raw `ipcRenderer` object to the renderer.

This reference intentionally requires Runtime Protocol `"1.1"`. Main owns the
Runtime→Renderer request token, binds it to one `webContents`, translates Runtime
cancellation into a preload `AbortSignal`, closes the asynchronous `<dialog>`,
and rejects stale or cross-window responses.
