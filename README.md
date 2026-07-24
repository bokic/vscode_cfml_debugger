# ColdFusion CFML Debugger for VS Code

A Visual Studio Code extension that adds **ColdFusion / CFML debugging** support
via the [Debug Adapter Protocol (DAP)](https://microsoft.github.io/debug-adapter-protocol/)
with an integrated **virtual filesystem** (`cfrds://`) for server-side source files.

---

## Features

- ✅ VS Code DAP integration (`launch` & `attach`)
- ✅ Virtual filesystem (`cfrds://`) for files fetched from the CF server
- ✅ File management on CF server (Create file/folder, Rename, Delete directly via VFS tree)
- ✅ Breakpoints in `.cfm`, `.cfc`, `.cfml` files
- ✅ Continue / Step over / Step into / Step out
- ✅ Call stack display (current stopped location & stack traces)
- ✅ Expression evaluation & Watch panel with recursive WDDX unwrapping
- ✅ Scope & Variable inspection (`VARIABLES`, `LOCAL`, `ARGUMENTS`, `ATTRIBUTES`, `REQUEST`, `SESSION`, `APPLICATION`, etc.)
- ✅ Connection Settings sidebar panel (connect / disconnect without a debug session)
- ✅ Virtual Filesystem sidebar panel (browse server directory tree)
- ✅ Debug Sessions sidebar panel (active RDS session info)
- ✅ Graceful teardown (automatically clears breakpoints, continues active thread, stops debug session, and closes `cfrds://` tabs on disconnect/shutdown)

---

## Project Structure

```
src/
├── extension.ts                              # Activation & deactivation entry point
├── cfml/
│   └── connectionManager.ts                  # Singleton RDS connection + event loop + teardown
├── debugAdapter/
│   ├── cfmlDebugAdapterFactory.ts            # Creates inline DAP sessions
│   └── cfmlDebugSession.ts                   # Full DAP request handlers
├── panels/
│   └── cfmlSettingsViewProvider.ts           # Connection Settings webview panel
├── virtualFs/
│   ├── cfmlVirtualFsProvider.ts              # In-memory FileSystemProvider (cfrds://)
│   ├── cfmlVirtualFsTreeDataProvider.ts      # Sidebar tree: Virtual Filesystem
│   └── cfmlDebugSessionsTreeDataProvider.ts  # Sidebar tree: Debug Sessions
└── utils/
    ├── logger.ts                             # Output-channel logger
    ├── pathUtils.ts                          # Path normalization utilities
    └── wddxParser.ts                         # Recursive WDDX parser & payload unwrapper
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- VS Code ≥ 1.90
- A running ColdFusion server with RDS enabled

### Install dependencies

```bash
npm install
```

### Build (watch mode)

```bash
npm run watch
```

### Run the extension

Press **F5** in VS Code to launch an Extension Development Host.

### Package

```bash
npm run package
```

---

## Usage

### 1. Connect to the ColdFusion server

Open the **ColdFusion Debugger** activity bar panel and fill in the
**Connection Settings** view (hostname, port, username, password, path), then
click **Connect**.  The extension will establish an RDS connection and start
a debugger session on the server.

### 2. Set breakpoints

Open any `.cfm`, `.cfc`, or `.cfml` file (local or via `cfrds://`) and click
in the gutter to set breakpoints.  They are synced to the CF server immediately
if already connected, or on the next connection.

### 3. Start a debug session

Add a debug configuration to `.vscode/launch.json` (see below) and press **F5**.
The extension reuses the existing RDS connection — no second session is started.

### 4. Step through code & Inspect Variables

When a breakpoint is hit, the VS Code debug toolbar becomes active:
- **Continue** (F5) — resume until the next breakpoint
- **Step Over** (F10) — execute the current line and stop at the next
- **Step Into** (F11) — step into a function call
- **Step Out** (⇧F11) — run until the current function returns
- **Variables & Watch** — inspect variables across ColdFusion scopes (`VARIABLES`, `LOCAL`, `ARGUMENTS`, etc.) or evaluate expressions in the Watch window.

---

## Debug Configurations

### Launch

```jsonc
{
  "type": "cfml",
  "request": "launch",
  "name": "Launch ColdFusion Debugger",
  "serverUrl": "http://localhost:8500",
  "username": "admin",
  "password": "",
  "webRoot": "${workspaceFolder}",
  "stopOnEntry": false,
  "virtualFs": {
    "enabled": true,
    "scheme": "cfrds"
  }
}
```

### Attach

```jsonc
{
  "type": "cfml",
  "request": "attach",
  "name": "Attach to ColdFusion Debugger",
  "serverUrl": "http://localhost:8500",
  "username": "admin",
  "password": "",
  "stopOnEntry": true
}
```

---

## Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `cfmlDebugger.hostname` | string | `localhost` | CF server hostname |
| `cfmlDebugger.port` | number | `8500` | CF server port |
| `cfmlDebugger.username` | string | `admin` | RDS username |
| `cfmlDebugger.password` | string | `""` | RDS password |
| `cfmlDebugger.path` | string | `"/"` | Base path on the server |
| `cfmlDebugger.url` | string | `http://localhost:8500` | Full server URL |
| `cfmlDebugger.virtualFs.enabled` | boolean | `true` | Register the `cfrds://` provider |
| `cfmlDebugger.virtualFs.scheme` | string | `cfrds` | URI scheme for virtual files |
| `cfmlDebugger.trace` | boolean | `false` | Verbose DAP trace logging |

---

## Virtual Filesystem

The extension registers a `cfrds://` URI scheme backed by a live RDS connection.
Server-side files can be opened directly from the **Virtual Filesystem** panel or
injected by the debug adapter:

```typescript
virtualFsProvider.provideFile(
  vscode.Uri.parse("cfrds:///index.cfm"),
  "<cfoutput>Hello World</cfoutput>",
);
```

VS Code opens these files as if they were local, enabling breakpoints and source
display for files that never touch the local disk.

---

## Architecture Notes

- **Single RDS session**: `ConnectionManager` owns one `debuggerStart()` session.
  The DAP debug session subscribes to its event emitter — no second poll loop is
  started when F5 is pressed.
- **Inline adapter**: The debug adapter runs inside the extension host process
  (`DebugAdapterInlineImplementation`) — no separate Node.js process or TCP port.
- **Breakpoint routing**: All breakpoint add/remove calls go through
  `ConnectionManager.setBreakpoint()` to ensure exactly one path to the server.
- **Clean teardown sequence**: On disconnect or app shutdown, the extension sequentially:
  1. Clears all breakpoints on the server (`debuggerClearAllBreakpoints`).
  2. Executes a continue command on the paused thread (`debuggerContinue`).
  3. Closes the server debugging session (`debuggerStop`).
  4. Closes all open `cfrds://` editor tabs in VS Code.

---

## Contributing

1. Fork the repo
2. Create a feature branch
3. Submit a pull request

---

## License

MIT
