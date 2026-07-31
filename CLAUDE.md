# CLAUDE.md — ColdFusion CFML Debugger for VS Code

Project guide for AI coding assistants (Claude, Gemini, etc.).

---

## Project Overview

A **VS Code extension** that provides ColdFusion / CFML debugging support via the
[Debug Adapter Protocol (DAP)](https://microsoft.github.io/debug-adapter-protocol/).
It connects to a live ColdFusion server over **RDS** (Remote Development Services)
using the `@bokic/cfrds` npm package, registers a `cfrds://` virtual filesystem
scheme so server-side source files can be opened in the editor, and surfaces
breakpoint, step, and event handling through the standard VS Code DAP integration.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.x, strict mode, CommonJS output (ES2020 target) |
| Runtime | Node.js ≥ 18, VS Code Extension Host |
| VS Code API | `^1.90.0` |
| DAP library | `@vscode/debugadapter` + `@vscode/debugprotocol` |
| CF RDS client | `@bokic/cfrds` (current: `^1.1.2`) |
| Build | `tsc` (`npm run compile` / `npm run watch`) |
| Linting | ESLint + `@typescript-eslint` |
| Packaging | `vsce package` → `.vsix` |

---

## Repository Layout

```
vscode_cfml_debugger/
├── src/
│   ├── extension.ts                         # activate() / deactivate() entry point
│   ├── cfml/
│   │   ├── connectionManager.ts             # Singleton RDS connection + event loop
│   │   └── cfrdsHelper.ts                   # Encapsulated @bokic/cfrds internal access wrapper
│   ├── debugAdapter/
│   │   ├── cfmlDebugAdapterFactory.ts       # DebugAdapterDescriptorFactory
│   │   └── cfmlDebugSession.ts              # Full DAP session (DebugSession subclass)
│   ├── panels/
│   │   └── cfmlSettingsViewProvider.ts      # Sidebar webview: Connection Settings UI
│   ├── virtualFs/
│   │   ├── cfmlVirtualFsProvider.ts         # FileSystemProvider for cfrds:// scheme
│   │   ├── cfmlVirtualFsTreeDataProvider.ts # Sidebar tree: Virtual Filesystem panel
│   │   └── cfmlDebugSessionsTreeDataProvider.ts # Sidebar tree: Debug Sessions panel
│   └── utils/
│       ├── logger.ts                        # OutputChannel wrapper (INFO/WARN/ERROR/DEBUG)
│       ├── pathUtils.ts                     # Path normalization and VFS scheme helpers
│       └── wddxParser.ts                    # WDDX deserialization, escaping, and formatting
├── resources/
│   ├── icon.png                             # Extension marketplace icon
│   └── icon-activity-bar.svg                # Activity bar icon
├── .vscode/
│   ├── launch.json                          # "Run Extension" config
│   ├── tasks.json                           # watch (default build) + compile tasks
│   └── settings.json
├── .eslintrc.json                           # ESLint configuration
├── out/                                     # Compiled JS (git-ignored)
├── package.json                             # Extension manifest + npm scripts
├── tsconfig.json
└── README.md
```

---

## Key Concepts

### ConnectionManager (`src/cfml/connectionManager.ts`)
- **Singleton** created in `activate()`, passed to all other components.
- Owns the `Server` instance from `@bokic/cfrds`.
- Exposes two VS Code events:
  - `onDidChangeState` — fires on every connection state transition (`disconnected | connecting | connected | error`).
  - `onDidReceiveDebugEvent` — fires when a `DebuggerEvent` arrives from the CF server.
- Runs a **single polling event loop** (`_runEventLoop`) after `debuggerStart()` succeeds, with consecutive error detection to handle server disconnects.
- On disconnect: clears all server breakpoints, stops the debugger session, closes the RDS connection.

### CfmlVirtualFsProvider (`src/virtualFs/cfmlVirtualFsProvider.ts`)
- Implements `vscode.FileSystemProvider` for the `cfrds://` URI scheme (configurable via `virtualFs.scheme`).
- **Read priority**: in-memory store (validated against server metadata) → live CF server via `ConnectionManager.readFile()`.
- **Write**: writes to the live CF server first, then updates the in-memory store.
- Directory listings and metadata are cached for `10 000 ms` (`DIR_CACHE_TTL_MS`).
- Automatically invalidates file and directory caches upon disconnect or debug session termination.

### CfmlDebugSession (`src/debugAdapter/cfmlDebugSession.ts`)
- Subclass of `DebugSession` from `@vscode/debugadapter`.
- Handles all DAP lifecycle requests (`initialize`, `launch`, `attach`, `disconnect`, `terminate`).
- Subscribes to `ConnectionManager`'s shared event loop — avoiding duplicate poll loops.
- Handles `BREAKPOINT` and `STEP` event types from `@bokic/cfrds`.
- **Full DAP implementation**: `stackTraceRequest` (with CF_TRACE call stack), `scopesRequest` (17 CF scopes), `variablesRequest` (with bounded nested struct/array expansion), `continueRequest`, `nextRequest` (step over), `stepInRequest`, `stepOutRequest`, `evaluateRequest`.

### CfmlSettingsViewProvider (`src/panels/cfmlSettingsViewProvider.ts`)
- Sidebar webview that renders a self-contained HTML/CSS/JS connection form.
- Communicates via `postMessage` (extension ↔ webview).
- Persists RDS credentials securely via VS Code's `SecretStorage` API (`context.secrets`).
- Uses a `nonce` for CSP.

### Logger (`src/utils/logger.ts`)
- Static class wrapping a single `OutputChannel` named `"ColdFusion Debugger"`.
- Methods: `Logger.info()`, `Logger.warn()`, `Logger.error()`, `Logger.debug()`.
- Revealed via the `cfmlDebugger.showDebugLog` command.

---

## VS Code Contribution Points

| Contribution | ID / Details |
|---|---|
| Debug type | `cfml` |
| Language | `cfml` (`.cfm`, `.cfc`, `.cfml`) |
| Activity bar container | `cfmlDebugger` |
| Sidebar views | `cfmlDebuggerSettings` (webview), `cfmlDebuggerSessions`, `cfmlDebuggerVirtualFs` |
| Debug sidebar view | `cfmlDebuggerVirtualFsDebug` (visible when `debugType == cfml`) |
| Commands | `cfmlDebugger.connect`, `disconnect`, `openVirtualFile`, `refreshVirtualFs`, `showDebugLog`, `rename`, `newFile`, `newFolder`, `delete` |
| Keybinding | `F2` → `cfmlDebugger.rename` (in VirtualFs tree) |
| Config prefix | `cfmlDebugger` |

### Settings (`cfmlDebugger.*`)

| Key | Type | Default | Description |
|---|---|---|---|
| `hostname` | string | `localhost` | CF server hostname |
| `port` | number | `8500` | CF server port |
| `username` | string | `admin` | RDS username |
| `path` | string | `"/"` | Base path on server |
| `url` | string | `http://localhost:8500` | Full server URL |
| `virtualFs.enabled` | boolean | `true` | Register `cfrds://` provider |
| `virtualFs.scheme` | string | `cfrds` | URI scheme for VFS |
| `trace` | boolean | `false` | Verbose DAP trace logging |

---

## Build & Development Workflow

```bash
# Install dependencies
npm install

# One-shot compile
npm run compile

# Watch mode (used by "Run Extension" launch config)
npm run watch

# Lint
npm run lint

# Run compile & lint checks
npm test

# Package as .vsix
npm run package
```

**To run/debug the extension:**
Press **F5** in VS Code. The `watch` task starts automatically (default build task),
then VS Code opens an **Extension Development Host** window with the extension loaded.

---

## Architecture Notes

- The extension uses an **inline debug adapter** (`DebugAdapterInlineImplementation`),
  meaning the DAP session runs inside the extension host process — no separate
  Node.js subprocess or TCP port.
- There is **one centralized event polling loop** inside `ConnectionManager`.
  `CfmlDebugSession` instances subscribe to `ConnectionManager.onDidReceiveDebugEvent`.
- Password credentials are stored encrypted via VS Code's `SecretStorage` API (`context.secrets`).
- Low-level `@bokic/cfrds` internal manipulation is isolated inside `cfrdsHelper.ts`.
- The `punycode` Node built-in deprecation (`DEP0040`) is patched at the top of
  `extension.ts` by monkey-patching `Module.prototype.require` to redirect to the
  userland `punycode/` package.
- `vscode.FileSystemProvider` is registered at activation time (not lazily), so
  `cfrds://` URIs can be opened even before a debug session starts.

---

## External Dependencies of Note

| Package | Purpose |
|---|---|
| `@bokic/cfrds` | ColdFusion RDS client: `Server`, `DebuggerEvent`, `CFRDS_DEBUGGER_EVENT_TYPE`, `BrowseDirItem`, `IdeDefaultResult` |
| `@vscode/debugadapter` | `DebugSession` base class + DAP event/response types |
| `@vscode/debugprotocol` | `DebugProtocol` namespace types |
| `punycode` | Userland shim to suppress Node `DEP0040` |
