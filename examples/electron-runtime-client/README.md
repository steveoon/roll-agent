# Thin Electron Runtime Protocol reference

This is intentionally an Electron adapter, not a second Roll client
implementation:

- `main.ts` owns `@roll-agent/client-node`, the child process, stderr, and IPC.
- `preload.ts` exposes named Thread/Turn/Approval methods, never a generic
  `request(method, params)` escape hatch.
- `renderer.ts` only renders events and sends Runtime Protocol commands.

Copy these files into an Electron TypeScript project, compile them to ESM, then
start it with an explicit workspace:

```bash
electron . --workspace=/absolute/path/to/project
```

The example also enables context isolation and sandboxing, validates each IPC
sender, blocks navigation/new windows, and supplies a restrictive CSP. Do not
expose API keys, environment variables, arbitrary process spawning, a generic
Runtime request method, or a raw `ipcRenderer` object to the renderer.
