# AGENTS.md — ColdFusion CFML Debugger for VS Code

Project guide and coding rules for AI coding assistants working on this VS Code extension.

---

## Project Overview

A **VS Code extension** that provides ColdFusion / CFML debugging support via the
[Debug Adapter Protocol (DAP)](https://microsoft.github.io/debug-adapter-protocol/).
It connects to a live ColdFusion server over **RDS** (Remote Development Services)
using the `@bokic/cfrds` npm package, registers a `cfrds://` virtual filesystem
scheme so server-side source files can be opened in the editor, and surfaces
breakpoint, step, and event handling through the standard VS Code DAP integration.

---

## Tech Stack & Compiler Rules

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

- **TypeScript 5.x**, strict mode (`"strict": true` in `tsconfig.json`). No implicit `any`.
- Target: **CommonJS / ES2020**. Do not introduce ESM (`import()` dynamic calls or `"type": "module"`).
- All source lives under `src/`. Compiled output goes to `out/` (never commit `out/`).
- Run `npm run compile` to verify; run `npm run lint` before finishing any change.

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

## Naming Conventions

| Item | Convention | Example |
|---|---|---|
| Classes | `PascalCase`, prefixed `Cfml` for extension-domain types | `CfmlDebugSession` |
| Interfaces / types | `PascalCase`; prefix `I` only when a matching class exists | `LogLevel`, `IdeDefaultResult` |
| Private class members | `_camelCase` leading underscore | `_channel`, `_runEventLoop` |
| Public methods / properties | `camelCase` | `initialize()`, `onDidChangeState` |
| Constants / module-level `const` | `UPPER_SNAKE_CASE` for true constants, `camelCase` for non-primitive values | `DIR_CACHE_TTL_MS`, `vfsScheme` |
| File names | `camelCase` matching the primary export | `cfmlDebugSession.ts` |

---

## Code Style

- **Indentation**: 4 spaces (no tabs).
- **Quotes**: single quotes for TypeScript string literals; double quotes inside JSON files.
- **Trailing commas**: include in multi-line arrays and objects.
- **Semicolons**: always.
- **Line length**: soft limit of 120 characters.
- **Alignment**: light column-alignment is acceptable for related declarations (see `extension.ts` patterns), but don't over-engineer it.
- **Blank lines**: one blank line between class members; two blank lines between top-level declarations.

---

## VS Code API Rules

- Always register disposables with `context.subscriptions.push(...)` in `activate()`.
- Read configuration via `vscode.workspace.getConfiguration('cfmlDebugger')` — use typed `.get<T>(key, defaultValue)` overloads.
- Store sensitive credentials (passwords, secrets) via VS Code's `context.secrets` (`SecretStorage` API), **never** in plain text settings.
- **Never** use `console.log/warn/error` directly in production paths — route all output through `Logger` (`src/utils/logger.ts`).
- Use `Logger.info()`, `Logger.warn()`, `Logger.error()`, `Logger.debug()` for all runtime messages.
- All commands must be declared in `package.json` under `contributes.commands` with id prefix `cfmlDebugger.` before being registered in code.

---

## DAP / Debug Adapter Rules

- `CfmlDebugSession` is the sole subclass of `DebugSession`. Keep all DAP request handlers (`*Request` methods) inside it.
- Every DAP response **must** call either `this.sendResponse(response)` or `this.sendErrorResponse(response, ...)` — never leave a request unacknowledged.
- Events sent to the client must use the typed helpers from `@vscode/debugadapter` (e.g., `new StoppedEvent(...)`, `new BreakpointEvent(...)`).
- `ConnectionManager` owns the single event loop (`_runEventLoop`). `CfmlDebugSession` instances subscribe to `ConnectionManager.onDidReceiveDebugEvent` rather than running duplicate polling loops.

---

## Architecture Notes & Constraints

- The extension uses an **inline debug adapter** (`DebugAdapterInlineImplementation`),
  meaning the DAP session runs inside the extension host process — no separate
  Node.js subprocess or TCP port.
- There is **one centralized event polling loop** inside `ConnectionManager`.
  `CfmlDebugSession` instances subscribe to `ConnectionManager.onDidReceiveDebugEvent`.
- Password credentials are stored encrypted via VS Code's `SecretStorage` API (`context.secrets`).
- Low-level `@bokic/cfrds` internal manipulation is isolated inside `cfrdsHelper.ts`.
- **`ConnectionManager` is a singleton** created in `activate()` and passed by constructor injection. Do not import it statically or use a module-level global (except `activeConnectionManager` in `extension.ts` for the `deactivate()` hook).
- **`CfmlVirtualFsProvider`** is registered at activation time unconditionally (subject to `virtualFs.enabled`). Do not lazily register it.
- `vscode.FileSystemProvider` is registered at activation time (not lazily), so
  `cfrds://` URIs can be opened even before a debug session starts.
- Directory listing cache TTL is `DIR_CACHE_TTL_MS = 10_000` ms — keep this constant centralised in `cfmlVirtualFsProvider.ts`.
- The `cfrds://` URI scheme string must come from configuration (`cfmlDebugger.virtualFs.scheme`), not be hard-coded in new code.
- The `punycode` Node `DEP0040` patch in `extension.ts` must remain at the **very top**
  of the file, before any `import` statements (it monkey-patches
  `Module.prototype.require` to redirect to the userland `punycode/` package).

---

## Error Handling

- Prefer explicit `try/catch` over unhandled Promise rejections — all `async` methods that touch network I/O must have a `catch` path that calls `Logger.error(...)`.
- Use discriminated-union result types or typed error messages — avoid stringly-typed error propagation where possible.
- Never `throw` from inside a VS Code event handler or disposable `dispose()` method; log and swallow instead.

---

## Comments & Documentation

- **JSDoc** on every exported class and public method — at minimum a one-line `/** ... */` summary.
- Use inline section dividers (`// ── Section name ───`) for logical groupings inside large functions (follow `extension.ts` style).
- Do not leave commented-out dead code. Remove it or open a `// TODO:` with a ticket/issue reference.
- Preserve all existing comments and docstrings when editing a file.

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

```bash
npm run compile   # type-check + compile
npm run lint      # ESLint (must pass with 0 errors)
npm run package   # vsce package → .vsix (only for release)
```

- Do **not** commit `out/`, `*.vsix`, or `node_modules/`.
- The `.vscodeignore` controls what ends up in the packaged extension — update it if new top-level asset directories are added.

**To run/debug the extension:**
Press **F5** in VS Code. The `watch` task starts automatically (default build task),
then VS Code opens an **Extension Development Host** window with the extension loaded.

---

## Dependencies

| Package | Purpose |
|---|---|
| `@bokic/cfrds` | ColdFusion RDS client: `Server`, `DebuggerEvent`, `CFRDS_DEBUGGER_EVENT_TYPE`, `BrowseDirItem`, `IdeDefaultResult` |
| `@vscode/debugadapter` | `DebugSession` base class + DAP event/response types |
| `@vscode/debugprotocol` | `DebugProtocol` namespace types |
| `punycode` | Userland shim to suppress Node `DEP0040` |

- Runtime dependencies go in `dependencies`; type packages and build tools go in `devDependencies`.
- Do **not** add new runtime dependencies without explicit discussion. This is a VS Code extension — bundle size matters.
- The four runtime deps are: `@bokic/cfrds`, `@vscode/debugadapter`, `@vscode/debugprotocol`, `punycode`.
