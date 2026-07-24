import * as vscode from 'vscode';
import { CfmlVirtualFsProvider } from '../virtualFs/cfmlVirtualFsProvider';
import { CfmlDebugSession } from './cfmlDebugSession';
// CfmlVirtualFsProvider now requires ConnectionManager; received as a pre-built instance.

/**
 * Factory that VS Code calls to create (or locate) a debug adapter
 * for every new CFML debug session.
 *
 * Using an inline adapter (DebugAdapterInlineImplementation) means the
 * adapter runs in the same extension host process — no separate process
 * or port is needed for the skeleton. Replace with
 * DebugAdapterServer / DebugAdapterExecutable when you wire up a real
 * CF debug adapter.
 */
export class CfmlDebugAdapterFactory
    implements vscode.DebugAdapterDescriptorFactory
{
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly virtualFsProvider: CfmlVirtualFsProvider | undefined
    ) {}

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const debugSession = new CfmlDebugSession(
            session.configuration,
            this.virtualFsProvider
        );
        return new vscode.DebugAdapterInlineImplementation(debugSession);
    }
}
