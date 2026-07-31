// Redirect 'punycode' to userland 'punycode/' to prevent Node DEP0040 deprecation warning
try {
    const Module = require('module');
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
        if (id === 'punycode') {
            return originalRequire.call(this, 'punycode/');
        }
        return originalRequire.apply(this, arguments as any);
    };
} catch { /* ignore */ }

import * as vscode from 'vscode';
import { CfmlDebugAdapterFactory } from './debugAdapter/cfmlDebugAdapterFactory';
import { CfmlVirtualFsProvider } from './virtualFs/cfmlVirtualFsProvider';
import { CfmlVirtualFsTreeDataProvider } from './virtualFs/cfmlVirtualFsTreeDataProvider';
import { CfmlDebugSessionsTreeDataProvider } from './virtualFs/cfmlDebugSessionsTreeDataProvider';
import { CfmlSettingsViewProvider } from './panels/cfmlSettingsViewProvider';
import { ConnectionManager } from './cfml/connectionManager';
import { Logger } from './utils/logger';

let activeConnectionManager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
    Logger.initialize(context);
    Logger.info('ColdFusion CFML Debugger extension activating…');

    // ── Connection manager (singleton for the session) ──────────────────
    const connectionManager = new ConnectionManager();
    activeConnectionManager = connectionManager;
    context.subscriptions.push(connectionManager);

    // ── Virtual filesystem ───────────────────────────────────────────────
    const config     = vscode.workspace.getConfiguration('cfmlDebugger');
    const vfsEnabled = config.get<boolean>('virtualFs.enabled', true);
    const vfsScheme  = config.get<string>('virtualFs.scheme', 'cfrds');

    const virtualFsProvider = new CfmlVirtualFsProvider(connectionManager);

    if (vfsEnabled) {
        context.subscriptions.push(
            vscode.workspace.registerFileSystemProvider(
                vfsScheme,
                virtualFsProvider,
                { isCaseSensitive: true, isReadonly: false }
            )
        );
        Logger.info(`Virtual filesystem registered under scheme: ${vfsScheme}://`);
    }

    // ── Tree views ───────────────────────────────────────────────────────
    const treeProvider     = new CfmlVirtualFsTreeDataProvider(connectionManager);
    const sessionsProvider = new CfmlDebugSessionsTreeDataProvider(connectionManager);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('cfmlDebuggerVirtualFs',      treeProvider),
        vscode.window.registerTreeDataProvider('cfmlDebuggerVirtualFsDebug', treeProvider),
        vscode.window.registerTreeDataProvider('cfmlDebuggerSessions',       sessionsProvider)
    );

    // ── Settings webview panel ───────────────────────────────────────────
    const settingsProvider = new CfmlSettingsViewProvider(
        context.extensionUri,
        connectionManager
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CfmlSettingsViewProvider.viewId,
            settingsProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // ── Debug adapter factory ────────────────────────────────────────────
    const adapterFactory = new CfmlDebugAdapterFactory(context, virtualFsProvider);
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('cfml', adapterFactory)
    );

    // ── Commands ─────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('cfmlDebugger.openVirtualFile',  openVirtualFileCommand),
        vscode.commands.registerCommand('cfmlDebugger.refreshVirtualFs', () => treeProvider.refresh()),
        vscode.commands.registerCommand('cfmlDebugger.showDebugLog',     () => Logger.show()),
        vscode.commands.registerCommand('cfmlDebugger.connect', async () => {
            const cfg = vscode.workspace.getConfiguration('cfmlDebugger');
            try {
                await connectionManager.connect({
                    host:     cfg.get<string>('hostname', 'localhost'),
                    port:     cfg.get<number>('port',     8500),
                    username: cfg.get<string>('username', 'admin'),
                    password: cfg.get<string>('password', ''),
                    path:     cfg.get<string>('path',     '/'),
                });
                vscode.window.showInformationMessage('Connected to ColdFusion server!');
            } catch (e) {
                vscode.window.showErrorMessage(`Connection failed: ${e}`);
            }
        }),
        vscode.commands.registerCommand('cfmlDebugger.disconnect', async () => {
            if (vscode.debug.activeDebugSession) {
                await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
            }
            await connectionManager.disconnect();
            vscode.window.showInformationMessage('Disconnected from ColdFusion server.');
        }),
        vscode.commands.registerCommand('cfmlDebugger.rename', async (item?: any) => {
            const uri: vscode.Uri | undefined = item?.resourceUri ?? item;
            if (!uri) { return; }
            const oldName = uri.path.split('/').pop() || '';
            const newName = await vscode.window.showInputBox({
                prompt: `Enter new name for ${oldName}`,
                value: oldName,
            });
            if (!newName || newName === oldName) { return; }

            const parentPath = uri.path.substring(0, uri.path.lastIndexOf('/'));
            const newUri = uri.with({ path: `${parentPath}/${newName}` });
            try {
                await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
                treeProvider.refresh();
                vscode.window.showInformationMessage(`Renamed ${oldName} to ${newName}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to rename ${oldName}: ${err}`);
            }
        }),
        vscode.commands.registerCommand('cfmlDebugger.newFile', async (item?: any) => {
            const parentUri: vscode.Uri = item?.resourceUri ?? vscode.Uri.parse(`cfrds:${connectionManager.rootPath || '/'}`);
            const fileName = await vscode.window.showInputBox({
                prompt: 'Enter name for new file (e.g. index.cfm)',
                placeHolder: 'filename.cfm',
            });
            if (!fileName) { return; }

            const baseDir = item?.isDirectory ? parentUri.path : parentUri.path.substring(0, parentUri.path.lastIndexOf('/'));
            const sep = baseDir.endsWith('/') ? '' : '/';
            const newFileUri = vscode.Uri.parse(`cfrds:${baseDir}${sep}${fileName}`);

            try {
                await vscode.workspace.fs.writeFile(newFileUri, Buffer.from('', 'utf-8'));
                treeProvider.refresh();
                const doc = await vscode.workspace.openTextDocument(newFileUri);
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create file ${fileName}: ${err}`);
            }
        }),
        vscode.commands.registerCommand('cfmlDebugger.newFolder', async (item?: any) => {
            const parentUri: vscode.Uri = item?.resourceUri ?? vscode.Uri.parse(`cfrds:${connectionManager.rootPath || '/'}`);
            const folderName = await vscode.window.showInputBox({
                prompt: 'Enter name for new folder',
                placeHolder: 'new-folder',
            });
            if (!folderName) { return; }

            const baseDir = item?.isDirectory ? parentUri.path : parentUri.path.substring(0, parentUri.path.lastIndexOf('/'));
            const sep = baseDir.endsWith('/') ? '' : '/';
            const newFolderUri = vscode.Uri.parse(`cfrds:${baseDir}${sep}${folderName}`);

            try {
                await vscode.workspace.fs.createDirectory(newFolderUri);
                treeProvider.refresh();
                vscode.window.showInformationMessage(`Created folder ${folderName}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create folder ${folderName}: ${err}`);
            }
        }),
        vscode.commands.registerCommand('cfmlDebugger.delete', async (item?: any) => {
            const uri: vscode.Uri | undefined = item?.resourceUri ?? item;
            if (!uri) { return; }
            const name = uri.path.split('/').pop() || uri.path;
            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete '${name}' from ColdFusion server?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') { return; }

            try {
                await vscode.workspace.fs.delete(uri, { recursive: true });
                treeProvider.refresh();
                vscode.window.showInformationMessage(`Deleted ${name}`);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to delete ${name}: ${err}`);
            }
        }),
        vscode.debug.onDidChangeBreakpoints(async (e) => {
            if (!connectionManager.isConnected) { return; }
            if (vscode.debug.activeDebugSession) { return; }
            for (const bp of e.added) {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const serverPath = bp.location.uri.scheme === 'cfrds' ? bp.location.uri.path : bp.location.uri.fsPath;
                    const line = bp.location.range.start.line + 1;
                    Logger.info(`[BreakpointListener] Adding breakpoint: ${serverPath}:${line}`);
                    try {
                        await connectionManager.setBreakpoint(serverPath, line, true);
                    } catch (err) {
                        Logger.warn(`[BreakpointListener] Failed to set breakpoint: ${err}`);
                    }
                }
            }
            for (const bp of e.removed) {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const serverPath = bp.location.uri.scheme === 'cfrds' ? bp.location.uri.path : bp.location.uri.fsPath;
                    const line = bp.location.range.start.line + 1;
                    Logger.info(`[BreakpointListener] Removing breakpoint: ${serverPath}:${line}`);
                    try {
                        await connectionManager.setBreakpoint(serverPath, line, false);
                    } catch (err) {
                        Logger.warn(`[BreakpointListener] Failed to remove breakpoint: ${err}`);
                    }
                }
            }
        })
    );

    // Close any cfrds:// tabs on startup and when disconnected
    closeCfrdsTabs();

    // Sync existing breakpoints whenever connected, close cfrds tabs on disconnect
    connectionManager.onDidChangeState(async (state) => {
        if (state.status === 'connected') {
            await connectionManager.clearAllBreakpoints();
            for (const bp of vscode.debug.breakpoints) {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const serverPath = bp.location.uri.scheme === 'cfrds' ? bp.location.uri.path : bp.location.uri.fsPath;
                    const line = bp.location.range.start.line + 1;
                    Logger.info(`[ConnectionManager] Syncing existing breakpoint to server: ${serverPath}:${line}`);
                    await connectionManager.setBreakpoint(serverPath, line, true);
                }
            }
        } else if (state.status === 'disconnected') {
            closeCfrdsTabs();
        }
    });

    Logger.info('ColdFusion CFML Debugger extension activated.');
}

export function closeCfrdsTabs(): void {
    try {
        const tabsToClose: vscode.Tab[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                let isCfrds = false;
                if (tab.input instanceof vscode.TabInputText) {
                    isCfrds = tab.input.uri?.scheme === 'cfrds';
                } else if (tab.input instanceof vscode.TabInputTextDiff) {
                    isCfrds = tab.input.modified?.scheme === 'cfrds' || tab.input.original?.scheme === 'cfrds';
                } else if (tab.input && typeof tab.input === 'object') {
                    const inputObj = tab.input as any;
                    if (inputObj.uri?.scheme === 'cfrds' || inputObj.modified?.scheme === 'cfrds' || inputObj.original?.scheme === 'cfrds') {
                        isCfrds = true;
                    }
                }
                if (isCfrds) {
                    tabsToClose.push(tab);
                }
            }
        }
        if (tabsToClose.length > 0) {
            vscode.window.tabGroups.close(tabsToClose);
            Logger.info(`[Extension] Closed ${tabsToClose.length} cfrds:// tabs.`);
        }
    } catch (e) {
        Logger.warn(`[Extension] Error closing cfrds tabs: ${e}`);
    }
}

export async function deactivate(): Promise<void> {
    Logger.info('ColdFusion CFML Debugger extension deactivating…');
    closeCfrdsTabs();
    if (activeConnectionManager) {
        try {
            await activeConnectionManager.disconnect();
        } catch (err) {
            Logger.warn(`[Extension] Error disconnecting on deactivate: ${err}`);
        }
        activeConnectionManager = undefined;
    }
    closeCfrdsTabs();
    Logger.info('ColdFusion CFML Debugger extension deactivated.');
}

// ── Command implementations ───────────────────────────────────────────────

async function openVirtualFileCommand(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        const input = await vscode.window.showInputBox({
            prompt:      'Enter a virtual CFML file path (e.g. /index.cfm)',
            placeHolder: '/path/to/file.cfm',
        });
        if (!input) { return; }
        uri = vscode.Uri.parse(`cfrds:/${input}`);
    }
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to open virtual file: ${err}`);
    }
}
