# GEMINI.md — Coding Rules for vscode_cfml_debugger

Guidelines for AI coding assistants working on this VS Code extension.

---

## Language & Compiler

- **TypeScript 5.x**, strict mode (`"strict": true` in `tsconfig.json`). No implicit `any`.
- Target: **CommonJS / ES2020**. Do not introduce ESM (`import()` dynamic calls or `"type": "module"`).
- All source lives under `src/`. Compiled output goes to `out/` (never commit `out/`).
- Run `npm run compile` to verify; run `npm run lint` before finishing any change.

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

## Architecture Constraints

- **`ConnectionManager` is a singleton** created in `activate()` and passed by constructor injection. Do not import it statically or use a module-level global (except `activeConnectionManager` in `extension.ts` for the `deactivate()` hook).
- **`CfmlVirtualFsProvider`** is registered at activation time unconditionally (subject to `virtualFs.enabled`). Do not lazily register it.
- Directory listing cache TTL is `DIR_CACHE_TTL_MS = 10_000` ms — keep this constant centralised in `cfmlVirtualFsProvider.ts`.
- The `cfrds://` URI scheme string must come from configuration (`cfmlDebugger.virtualFs.scheme`), not be hard-coded in new code.
- The `punycode` Node DEP0040 patch in `extension.ts` must remain at the **very top** of the file, before any `import` statements.

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

## Dependencies

- Runtime dependencies go in `dependencies`; type packages and build tools go in `devDependencies`.
- Do **not** add new runtime dependencies without explicit discussion. This is a VS Code extension — bundle size matters.
- The four runtime deps are: `@bokic/cfrds`, `@vscode/debugadapter`, `@vscode/debugprotocol`, `punycode`.

---

## Build & CI Reminders

```bash
npm run compile   # type-check + compile
npm run lint      # ESLint (must pass with 0 errors)
npm run package   # vsce package → .vsix (only for release)
```

- Do **not** commit `out/`, `*.vsix`, or `node_modules/`.
- The `.vscodeignore` controls what ends up in the packaged extension — update it if new top-level asset directories are added.
