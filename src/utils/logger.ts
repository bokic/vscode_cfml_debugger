import * as vscode from 'vscode';

/** Severity levels for the output channel. */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Simple wrapper around a VS Code OutputChannel.
 *
 * All debug-adapter log output is routed here so the user can inspect
 * it via the "CFML: Show Debug Log" command.
 */
export class Logger {
    private static _channel: vscode.OutputChannel | undefined;

    static initialize(_context: vscode.ExtensionContext): void {
        if (!Logger._channel) {
            Logger._channel = vscode.window.createOutputChannel('ColdFusion Debugger');
        }
    }

    private static _getChannel(): vscode.OutputChannel {
        if (!Logger._channel) {
            Logger._channel = vscode.window.createOutputChannel('ColdFusion Debugger');
        }
        return Logger._channel;
    }

    static info(message: string):  void { Logger._log('INFO',  message); }
    static warn(message: string):  void { Logger._log('WARN',  message); }
    static error(message: string): void { Logger._log('ERROR', message); }
    static debug(message: string): void { Logger._log('DEBUG', message); }

    /** Reveal the output channel in the UI. */
    static show(): void {
        Logger._getChannel().show(true);
    }

    private static _log(level: string, message: string): void {
        const ts   = new Date().toISOString();
        const line = `[${ts}] [${level}] ${message}`;
        if (level === 'ERROR') {
            console.error(line);
        } else if (level === 'WARN') {
            console.warn(line);
        } else {
            console.log(line);
        }
        Logger._getChannel().appendLine(line);
    }
}
