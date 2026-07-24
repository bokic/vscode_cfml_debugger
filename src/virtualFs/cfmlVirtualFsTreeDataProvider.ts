import * as vscode from 'vscode';
import { ConnectionManager } from '../cfml/connectionManager';
import { Logger } from '../utils/logger';

/**
 * Tree item representing a file or directory on the CF server.
 */
export class VirtualFsTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly resourceUri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly isDirectory: boolean,
        public readonly serverPath: string
    ) {
        super(label, collapsibleState);
        this.tooltip = serverPath;

        if (!isDirectory) {
            this.command = {
                command:   'vscode.open',
                title:     'Open File',
                arguments: [resourceUri],
            };
            this.iconPath = new vscode.ThemeIcon('file-code');
            this.contextValue = 'cfmlFile';
        } else {
            this.iconPath = new vscode.ThemeIcon('folder');
            this.contextValue = 'cfmlDirectory';
        }
    }
}

/**
 * Placeholder shown in the tree when there is no active connection.
 */
class PlaceholderItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'cfmlPlaceholder';
    }
}

/**
 * CfmlVirtualFsTreeDataProvider
 *
 * Populates the "Virtual Filesystem" panel by browsing directories
 * on the live ColdFusion server via ConnectionManager.browseDir().
 *
 * - Disconnected → shows a "Not connected" placeholder.
 * - Connecting   → shows a "Connecting…" placeholder.
 * - Error        → shows the error message.
 * - Connected    → lazy-loads the CF server directory tree.
 */
export class CfmlVirtualFsTreeDataProvider
    implements vscode.TreeDataProvider<vscode.TreeItem>
{
    private readonly _onDidChangeTreeData =
        new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(private readonly connectionManager: ConnectionManager) {
        // Refresh the tree whenever the connection state changes
        connectionManager.onDidChangeState(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const state = this.connectionManager.state;

        // ── Not connected / error / connecting ────────────────────────────
        if (!element) {
            if (state.status === 'disconnected') {
                return [new PlaceholderItem('Not connected — use Connection Settings to connect', 'plug')];
            }
            if (state.status === 'connecting') {
                return [new PlaceholderItem('Connecting to server…', 'loading~spin')];
            }
            if (state.status === 'error') {
                return [new PlaceholderItem(`Connection error: ${state.message}`, 'error')];
            }
        }

        // ── Connected — browse the server ─────────────────────────────────
        if (state.status !== 'connected') { return []; }

        const parentServerPath = element instanceof VirtualFsTreeItem
            ? element.serverPath
            : state.rootPath;

        try {
            const items = await this.connectionManager.browseDir(parentServerPath);

            // Sort: directories first, then files, both alphabetically
            items.sort((a, b) => {
                if (a.kind !== b.kind) { return a.kind === 'D' ? -1 : 1; }
                return a.name.localeCompare(b.name);
            });

            return items.map(item => {
                const isDir       = item.kind === 'D';
                const sep         = parentServerPath.endsWith('/') ? '' : '/';
                const serverPath  = parentServerPath + sep + item.name;
                const uri         = vscode.Uri.parse(`cfrds:${serverPath}`);
                const state       = isDir
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None;

                return new VirtualFsTreeItem(item.name, uri, state, isDir, serverPath);
            });
        } catch (e) {
            Logger.error(`[VirtualFsTree] browseDir failed for ${parentServerPath}: ${e}`);
            return [new PlaceholderItem(`Error loading directory: ${e}`, 'error')];
        }
    }
}
