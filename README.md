# Adobe ColdFusion / CFML Debugger for VS Code

A Visual Studio Code extension for debugging CFML applications under Adobe ColdFusion.

## What It Does

This extension lets you debug CFML code directly from VS Code by connecting to your Adobe ColdFusion server over RDS (Remote Development Services).

**Key features:**

- **Debug your code** - Set breakpoints, step through lines, inspect variables, and examine CFML scopes (variables, session, application, etc.)
- **Browse remote files** - Open and edit files on your ColdFusion server without copying them locally
- **Manage files remotely** - Create, rename, and delete files and folders on the server from the sidebar
- **Variable inspection** - Inspect complex CFML structures, queries, arrays, and objects

## Requirements

- VS Code 1.90.0 or higher
- Adobe ColdFusion server with RDS enabled

## Getting Started

1. Click the **ColdFusion Debugger** icon in the Activity Bar
2. Enter your server connection details (hostname, port, username, password)
3. Click **Connect**
4. Set breakpoints and press `F5` to start debugging

## Usage

- **Set breakpoints** by clicking in the editor gutter or pressing `F9`
- **Start debugging** with `F5` (Launch or Attach mode)
- **Step through code** with `F10` (Step Over), `F11` (Step Into), `Shift+F11` (Step Out)
- **Browse server files** in the Virtual Filesystem panel
- **Manage files** with right-click context menu or `F2` to rename, `Delete` to remove

## License

MIT License
