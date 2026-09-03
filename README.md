# ColdFusion / CFML Debugger for VS Code

[![VS Code](https://img.shields.io/badge/VS%20Code-^1.90.0-blue.svg)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥18.0.0-green.svg)](https://nodejs.org/)
[![DAP](https://img.shields.io/badge/Protocol-Debug%20Adapter%20Protocol-purple.svg)](https://microsoft.github.io/debug-adapter-protocol/)

A feature-rich Visual Studio Code extension that brings **native ColdFusion / CFML debugging** support via the [Debug Adapter Protocol (DAP)](https://microsoft.github.io/debug-adapter-protocol/) and an integrated **virtual filesystem (`cfrds://`)** for remote server-side file access over ColdFusion Remote Development Services (RDS).

---

## 📋 Table of Contents

- [Features](#-features)
- [Architecture & Teardown Lifecycle](#-architecture--teardown-lifecycle)
- [Prerequisites](#-prerequisites)
- [Installation & Getting Started](#-installation--getting-started)
- [Usage Guide](#-usage-guide)
  - [1. Connection Settings Panel](#1-connection-settings-panel)
  - [2. Remote Virtual Filesystem (cfrds://)](#2-remote-virtual-filesystem-cfrds)
  - [3. Managing Remote Files & Folders](#3-managing-remote-files--folders)
  - [4. Setting & Syncing Breakpoints](#4-setting--syncing-breakpoints)
  - [5. Starting a Debug Session (Launch & Attach)](#5-starting-a-debug-session-launch--attach)
  - [6. Stepping & Variable Inspection](#6-stepping--variable-inspection)
- [Debug Configurations (`launch.json`)](#-debug-configurations-launchjson)
- [Extension Settings](#-extension-settings)
- [Commands & Keyboard Shortcuts](#-commands--keyboard-shortcuts)
- [Troubleshooting & Diagnostics](#-troubleshooting--diagnostics)
- [Development & Contributing](#-development--contributing)
- [License](#-license)

---

## ✨ Features

- **⚡ Native DAP Integration**: Full support for `launch` and `attach` debug requests with standard VS Code execution controls (Continue, Step Over, Step Into, Step Out, Pause, Terminate).
- **📂 Remote Virtual Filesystem (`cfrds://`)**: Seamlessly browse and open server-side ColdFusion files directly in VS Code without requiring local copies or network mounts.
- **🛠️ Remote File Management**: Create, rename (`F2`), and delete (`Delete` / context menu) files and directories directly on the remote ColdFusion server via the sidebar tree view.
- **🔴 Breakpoint Synchronization**: Set breakpoints in `.cfm`, `.cfc`, and `.cfml` files (local or remote `cfrds://`). Breakpoints are synced instantly to the ColdFusion RDS server.
- **🔍 Deep Scope & Variable Inspection**: Inspect local and global ColdFusion scopes (`VARIABLES`, `LOCAL`, `ARGUMENTS`, `ATTRIBUTES`, `REQUEST`, `SESSION`, `APPLICATION`, `SERVER`, `CGI`, `URL`, `FORM`).
- **📦 Recursive WDDX Unwrapping**: Parses complex ColdFusion structures, queries, arrays, and objects returned in WDDX payloads for accurate visualization in the Variables and Watch panels.
- **🎛️ Dedicated Activity Bar Sidebar**:
  - **Connection Settings**: Embedded Webview panel with live connection status, server info, and one-click Connect / Disconnect controls.
  - **Virtual Filesystem**: Tree view for exploring remote server directories.
  - **Debug Sessions**: View active RDS debugger sessions and thread states.
- **🧹 Graceful Teardown**: Automatically clears breakpoints from the server, resumes suspended threads, stops the RDS debug session, and closes virtual editor tabs on disconnect or VS Code exit.

---

## 🏗️ Architecture & Teardown Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           VS Code Extension Host                        │
│                                                                         │
│  ┌────────────────────────┐         ┌────────────────────────────────┐  │
│  │ Connection Settings    │         │  Virtual Filesystem Provider   │  │
│  │ (Webview Panel)        │         │  (cfrds://)                    │  │
│  └───────────┬────────────┘         └───────────────┬────────────────┘  │
│              │                                      │                   │
│              ▼                                      ▼                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │            ConnectionManager (Singleton RDS State)                │  │
│  │            - Manages @bokic/cfrds Server instance                 │  │
│  │            - Long-polling RDS Debugger Event Loop                 │  │
│  │            - Central Breakpoint Synchronizer                      │  │
│  └──────────────────────────────────┬────────────────────────────────┘  │
│                                     │                                   │
│                                     ▼                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │            CfmlDebugAdapterFactory (Inline DAP)                   │  │
│  │            - Translates DAP requests ↔ RDS protocol                │  │
│  │            - Maps stack frames & scopes                           │  │
│  └──────────────────────────────────┬────────────────────────────────┘  │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      │ HTTP / RDS Protocol (Port 8500)
                                      ▼
                       ┌─────────────────────────────┐
                       │  Adobe ColdFusion Server    │
                       │  - RDS Security / Debugger  │
                       └─────────────────────────────┘
```

### Clean Teardown Sequence
To prevent leaving threads paused or orphan debug sessions open on the ColdFusion server, disconnecting or closing VS Code triggers an automated teardown sequence:
1. **Clear Server Breakpoints**: Sends `debuggerClearAllBreakpoints` to purge all breakpoints registered during the session.
2. **Resume Suspended Thread**: Sends `debuggerContinue` to release any paused ColdFusion worker thread.
3. **Stop RDS Debug Session**: Invokes `debuggerStop` to notify the CF server that the debugging session has ended.
4. **Clean Workspace Tabs**: Automatically identifies and closes all open `cfrds://` virtual document tabs in VS Code.

---

## ⚙️ Prerequisites

- **VS Code**: Version `1.90.0` or higher.
- **Node.js**: Version `18.x` or higher (for building/packaging).
- **ColdFusion Server**: Adobe ColdFusion server with **RDS (Remote Development Services)** enabled and RDS security configured.

---

## 📖 Usage Guide

### 1. Connection Settings Panel
Click on the **ColdFusion Debugger** icon in the Activity Bar to reveal the sidebar panels.

1. In the **Connection Settings** webview panel, enter:
   - **Hostname**: (e.g., `localhost` or remote IP)
   - **Port**: ColdFusion web port (default: `8500`)
   - **Username**: RDS / Admin username (default: `admin`)
   - **Password**: RDS / Admin password
   - **Path**: Web root path on the server (e.g., `/` or `/var/www/html`)
2. Click **Connect**.
3. Once connected, the status indicator turns green and displays server details (CF Server Version, Client Version, Root Path, Debug Session ID).

### 2. Remote Virtual Filesystem (`cfrds://`)
- Expand the **Virtual Filesystem** panel in the sidebar to browse server directories.
- Click any `.cfm` or `.cfc` file to open it directly from the remote server.
- Files open under the `cfrds://` URI scheme and feature full syntax highlighting and breakpoint support.

### 3. Managing Remote Files & Folders
You can perform remote file operations directly inside the Virtual Filesystem tree view:
- **New File**: Click the `+` icon in the panel toolbar (or right-click a folder -> **New File...**).
- **New Folder**: Click the folder icon in the panel toolbar (or right-click -> **New Folder...**).
- **Rename**: Select a file or folder and press `F2` (or right-click -> **Rename**).
- **Delete**: Select a file or folder and press `Delete` (or right-click -> **Delete**). A modal confirmation prompt prevents accidental deletion.

### 4. Setting & Syncing Breakpoints
- Open any `.cfm`, `.cfc`, or `.cfml` file (local workspace file or remote `cfrds://` file).
- Click in the editor gutter or press `F9` to toggle breakpoints.
- If connected, breakpoints sync immediately to the server. If disconnected, breakpoints automatically sync as soon as a server connection is established.

### 5. Starting a Debug Session (Launch & Attach)
- Open the Debug view (`Ctrl+Shift+D` / `Cmd+Shift+D`).
- Select **Launch ColdFusion Debugger** or **Attach to ColdFusion Debugger** from the debug dropdown and press **F5**.
- The debug adapter reuses the active RDS connection maintained by `ConnectionManager`.

### 6. Stepping & Variable Inspection
When execution pauses at a breakpoint:
- Use the Debug Control Toolbar:
  - ⏸️ **Pause** / ▶️ **Continue** (`F5`)
  - ↷ **Step Over** (`F10`)
  - ↳ **Step Into** (`F11`)
  - ↲ **Step Out** (`Shift+F11`)
- **Variables Window**: Expand ColdFusion scopes (`VARIABLES`, `LOCAL`, `ARGUMENTS`, `ATTRIBUTES`, `REQUEST`, `SESSION`, `APPLICATION`, etc.). Complex objects and queries are recursively parsed from WDDX.
- **Watch Panel & Hover**: Add expressions to the Watch window or hover over variables in the editor to evaluate their values in real time.

---

## 🛠️ Debug Configurations (`launch.json`)

Add debug configurations to your project's `.vscode/launch.json`:

### Launch Configuration
```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "cfml",
      "request": "launch",
      "name": "Launch ColdFusion Debugger",
      "serverUrl": "http://localhost:8500",
      "username": "admin",
      "password": "your-password",
      "webRoot": "${workspaceFolder}",
      "stopOnEntry": false,
      "trace": false,
      "virtualFs": {
        "enabled": true,
        "scheme": "cfrds"
      }
    }
  ]
}
```

### Attach Configuration
```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "cfml",
      "request": "attach",
      "name": "Attach to ColdFusion Debugger",
      "serverUrl": "http://localhost:8500",
      "username": "admin",
      "password": "your-password",
      "stopOnEntry": true,
      "trace": false
    }
  ]
}
```

---

## ⚙️ Extension Settings

Configure workspace or global settings under `cfmlDebugger` in VS Code Settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `cfmlDebugger.hostname` | `string` | `"localhost"` | ColdFusion server hostname or IP address. |
| `cfmlDebugger.port` | `number` | `8500` | ColdFusion server HTTP/RDS port. |
| `cfmlDebugger.username` | `string` | `"admin"` | ColdFusion Administrator / RDS username. |
| `cfmlDebugger.password` | `string` | `""` | ColdFusion Administrator / RDS password. |
| `cfmlDebugger.path` | `string` | `"/"` | Base root path on the server. |
| `cfmlDebugger.url` | `string` | `"http://localhost:8500"` | Full ColdFusion server URL (auto-synced). |
| `cfmlDebugger.virtualFs.enabled` | `boolean` | `true` | Enables the `cfrds://` virtual filesystem provider. |
| `cfmlDebugger.virtualFs.scheme` | `string` | `"cfrds"` | URI scheme used for virtual server files. |
| `cfmlDebugger.trace` | `boolean` | `false` | Enables verbose DAP protocol trace logging in Output window. |

---

## ⌨️ Commands & Keyboard Shortcuts

### Extension Commands

| Command | Title | Category | Description |
|---|---|---|---|
| `cfmlDebugger.connect` | Connect to Server | ColdFusion Debugger | Establishes an RDS connection using configured settings. |
| `cfmlDebugger.disconnect` | Disconnect from Server | ColdFusion Debugger | Safely stops debug session and disconnects from server. |
| `cfmlDebugger.openVirtualFile` | Open Virtual File | ColdFusion Debugger | Opens a remote server file by path (e.g. `/index.cfm`). |
| `cfmlDebugger.refreshVirtualFs` | Refresh Virtual Filesystem | ColdFusion Debugger | Refreshes the Virtual Filesystem tree view. |
| `cfmlDebugger.showDebugLog` | Show Debug Log | ColdFusion Debugger | Opens the ColdFusion Debugger Output channel log. |
| `cfmlDebugger.newFile` | New File... | ColdFusion Debugger | Creates a new file in the remote filesystem. |
| `cfmlDebugger.newFolder` | New Folder... | ColdFusion Debugger | Creates a new folder in the remote filesystem. |
| `cfmlDebugger.rename` | Rename | ColdFusion Debugger | Renames a remote file or folder. |
| `cfmlDebugger.delete` | Delete | ColdFusion Debugger | Deletes a remote file or folder. |

### Context Keybindings

| Key | Command | When Clause |
|---|---|---|
| `F2` | `cfmlDebugger.rename` | Remote VFS Tree item selected |
| `Delete` | `cfmlDebugger.delete` | Remote VFS Tree item selected |

---

## 🔍 Troubleshooting & Diagnostics

### Output Channel Logs
The extension maintains an integrated logging output channel.
- Open via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) -> **CFML: Show Debug Log**
- Or view the **Output** tab in VS Code and select **ColdFusion Debugger** from the dropdown menu.

### Common Issues & Solutions

1. **Max session count reached error**:
   - *Cause*: ColdFusion allows a limited number of concurrent RDS debugging sessions.
   - *Fix*: Restart the ColdFusion Application Server or clear existing debugging sessions in CF Administrator.

2. **Cannot connect to RDS**:
   - Verify RDS is enabled in **ColdFusion Administrator -> Security -> RDS**.
   - Check firewall rules for port `8500` (or your custom CF port).
   - Ensure username/password credentials match CF Administrator RDS settings.

3. **Breakpoints not hitting**:
   - Ensure local source file paths match server web root mappings or use the `cfrds://` Virtual Filesystem to open files directly from the server.
   - Check that line numbers contain executable CFML/CFScript code.

---

## 🧑‍💻 Development & Contributing

### Directory Structure
```
src/
├── extension.ts                              # Extension entry point & command registration
├── cfml/
│   └── connectionManager.ts                  # Singleton RDS connection, event loop & teardown
├── debugAdapter/
│   ├── cfmlDebugAdapterFactory.ts            # DAP inline adapter factory
│   └── cfmlDebugSession.ts                   # DAP protocol implementation
├── panels/
│   └── cfmlSettingsViewProvider.ts           # Connection Settings webview provider & UI
├── virtualFs/
│   ├── cfmlVirtualFsProvider.ts              # In-memory FileSystemProvider (cfrds://)
│   ├── cfmlVirtualFsTreeDataProvider.ts      # VFS Tree view provider
│   └── cfmlDebugSessionsTreeDataProvider.ts  # Active Debug Sessions tree view
└── utils/
    ├── logger.ts                             # Central output channel logger
    ├── pathUtils.ts                          # Path normalization & mapping helpers
    └── wddxParser.ts                         # WDDX XML recursive structure parser
```

### Scripts

```bash
npm run compile   # Transpile TypeScript to JS
npm run watch     # Run tsc in watch mode
npm run lint      # Run ESLint check
npm run test      # Run test suite
npm run package   # Package extension into .vsix file
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
