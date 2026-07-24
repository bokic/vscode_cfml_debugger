import * as vscode from 'vscode';
import { ConnectionManager } from '../cfml/connectionManager';

/**
 * A tree item representing a single active debug session.
 */
export class DebugSessionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly session: vscode.DebugSession
    ) {
        super(session.name, vscode.TreeItemCollapsibleState.None);
        this.description = session.configuration.serverUrl as string | undefined;
        this.tooltip     = `Session: ${session.id}`;
        this.iconPath    = new vscode.ThemeIcon('debug-alt');
        this.contextValue = 'cfmlDebugSession';
    }
}

/**
 * CfmlDebugSessionsTreeDataProvider
 *
 * Shows all currently active CFML debug sessions in the sidebar panel.
 * Listens to VS Code debug session lifecycle events to stay current.
 */
export class CfmlDebugSessionsTreeDataProvider
    implements vscode.TreeDataProvider<vscode.TreeItem>
{
    private readonly _onDidChangeTreeData =
        new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<
        vscode.TreeItem | undefined | null | void
    > = this._onDidChangeTreeData.event;

    constructor(private readonly connectionManager?: ConnectionManager) {
        if (connectionManager) {
            connectionManager.onDidChangeState(() => {
                this.refresh();
            });
        }
        vscode.debug.onDidStartDebugSession(session => {
            if (session.type === 'cfml') { this.refresh(); }
        });
        vscode.debug.onDidTerminateDebugSession(session => {
            if (session.type === 'cfml') { this.refresh(); }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(_element?: vscode.TreeItem): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];

        if (this.connectionManager?.isConnected && this.connectionManager.dbgSessionId) {
            const rdsItem = new vscode.TreeItem(
                `RDS Session: ${this.connectionManager.dbgSessionId}`,
                vscode.TreeItemCollapsibleState.None
            );
            rdsItem.description = 'ColdFusion RDS Debugger';
            rdsItem.tooltip     = `Active RDS Debugger Session ID: ${this.connectionManager.dbgSessionId}`;
            rdsItem.iconPath    = new vscode.ThemeIcon('radio-tower');
            rdsItem.contextValue = 'cfmlRdsSession';
            items.push(rdsItem);
        }

        if (vscode.debug.activeDebugSession?.type === 'cfml') {
            items.push(new DebugSessionTreeItem(vscode.debug.activeDebugSession));
        }

        return items;
    }
}
