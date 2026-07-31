import {
    DebugSession,
    InitializedEvent,
    StoppedEvent,
    TerminatedEvent,
    OutputEvent,
    Thread,
    StackFrame,
    Scope,
    Variable,
    Source,
    Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as vscode from 'vscode';
import { Server } from '@bokic/cfrds';
import { CfmlVirtualFsProvider } from '../virtualFs/cfmlVirtualFsProvider';
import { DebuggerEvent, CFRDS_DEBUGGER_EVENT_TYPE } from '@bokic/cfrds';
import { Logger } from '../utils/logger';
import { formatCleanValue, getCfmlType } from '../utils/wddxParser';
import { normalizeVfsPath } from '../utils/pathUtils';

/** Shape of the launch / attach configuration object. */
interface CfmlLaunchArguments extends DebugProtocol.LaunchRequestArguments {
    serverUrl: string;
    username?: string;
    password?: string;
    webRoot?: string;
    stopOnEntry?: boolean;
    trace?: boolean;
    virtualFs?: {
        enabled?: boolean;
        scheme?: string;
    };
}

/**
 * Core DAP session for the CFML debugger.
 *
 * This skeleton implements every required DAP lifecycle request with
 * minimal stubs so that VS Code accepts the session without errors.
 * Replace the TODO sections with real CF debug-protocol logic.
 */
export class CfmlDebugSession extends DebugSession {
    private static readonly THREAD_ID = 1;

    private _config!: CfmlLaunchArguments;
    private _breakpoints: Map<string, DebugProtocol.Breakpoint[]> = new Map();

    private _serverSessionId?: string;
    private _eventSubscription?: vscode.Disposable;

    /**
     * The CF thread name captured from the last BREAKPOINT or STEP event.
     * Required by step/continue commands which must name the thread.
     */
    private _stoppedThreadName = 'main';
    /** The server path of the file where execution is currently paused. */
    private _stoppedSource = '';
    /** The 1-based line number where execution is currently paused. */
    private _stoppedLine = 0;
    /** Raw event data captured when paused. */
    private _stoppedEventData: Record<string, any> | undefined;

    constructor(
        configuration: Record<string, unknown>,
        private readonly virtualFsProvider: CfmlVirtualFsProvider | undefined
    ) {
        super();
        this._config = configuration as unknown as CfmlLaunchArguments;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments
    ): void {
        Logger.info('DAP initializeRequest');

        response.body = response.body ?? {};

        // Capabilities advertised to VS Code
        response.body.supportsConfigurationDoneRequest   = true;
        response.body.supportsFunctionBreakpoints        = false;
        response.body.supportsConditionalBreakpoints     = false;
        response.body.supportsEvaluateForHovers          = true;
        response.body.supportsStepBack                   = false;
        response.body.supportsRestartRequest             = false;
        response.body.supportsTerminateRequest           = true;
        response.body.supportsBreakpointLocationsRequest = false;
        response.body.supportsStepInTargetsRequest       = false;
        response.body.supportsCompletionsRequest         = false;
        response.body.supportsValueFormattingOptions     = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        _args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        Logger.info('DAP configurationDoneRequest');
        this.sendResponse(response);
        // TODO: signal the CF server that we are ready to receive events
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: CfmlLaunchArguments
    ): Promise<void> {
        this._config = args;
        Logger.info(`DAP launchRequest → serverUrl=${args.serverUrl}`);
        this.sendEvent(new OutputEvent(`Connecting to ${args.serverUrl}…\n`, 'console'));

        await this._startDebugSession();

        this.sendResponse(response);

        if (args.stopOnEntry) {
            this.sendEvent(new StoppedEvent('entry', CfmlDebugSession.THREAD_ID));
        }
    }

    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: CfmlLaunchArguments
    ): Promise<void> {
        this._config = args;
        Logger.info(`DAP attachRequest → serverUrl=${args.serverUrl}`);
        this.sendEvent(new OutputEvent(`Attaching to ${args.serverUrl}…\n`, 'console'));

        await this._startDebugSession();

        this.sendResponse(response);

        if (args.stopOnEntry) {
            this.sendEvent(new StoppedEvent('entry', CfmlDebugSession.THREAD_ID));
        }
    }

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments
    ): Promise<void> {
        Logger.info('DAP disconnectRequest — ending session without closing shared RDS connection');
        this._eventSubscription?.dispose();
        this._eventSubscription = undefined;
        this._serverSessionId   = undefined;
        this.sendResponse(response);
    }

    protected async terminateRequest(
        response: DebugProtocol.TerminateResponse,
        _args: DebugProtocol.TerminateArguments
    ): Promise<void> {
        Logger.info('DAP terminateRequest — ending session without closing shared RDS connection');
        this._eventSubscription?.dispose();
        this._eventSubscription = undefined;
        this._serverSessionId   = undefined;
        this.sendEvent(new TerminatedEvent());
        this.sendResponse(response);
    }

    private async _startDebugSession(): Promise<void> {
        const cm = this.virtualFsProvider?.connectionManager;
        if (!cm) { return; }

        // If ConnectionManager is not connected, use launch/attach config parameters to connect automatically
        if (!cm.isConnected && this._config?.serverUrl) {
            try {
                const url = new URL(this._config.serverUrl);
                const host = url.hostname || 'localhost';
                const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 8500);
                const username = this._config.username || 'admin';
                const password = this._config.password || '';
                Logger.info(`[DAP] Auto-connecting ConnectionManager using launch configuration: ${host}:${port}`);
                this.sendEvent(new OutputEvent(`Auto-connecting to ColdFusion server ${host}:${port}…\n`, 'console'));
                await cm.connect({ host, port, username, password });
            } catch (err) {
                Logger.error(`[DAP] Failed to auto-connect using launch configuration: ${err}`);
            }
        }

        if (!cm.isConnected) {
            Logger.warn('[DAP] Not connected to ColdFusion server. Please connect via Connection Settings first.');
            this.sendEvent(new OutputEvent('Not connected to ColdFusion server. Use Connection Settings to connect first.\n', 'stderr'));
            return;
        }

        // Reuse the single RDS debugger session already started by ConnectionManager.
        const sessionId = cm.dbgSessionId;
        if (!sessionId) {
            Logger.warn('[DAP] ConnectionManager has no active RDS debugger session.');
            this.sendEvent(new OutputEvent('No active RDS debugger session. Disconnect and reconnect via Connection Settings.\n', 'stderr'));
            return;
        }

        this._serverSessionId = sessionId;
        Logger.info(`[DAP] Reusing ConnectionManager RDS session ID=${sessionId}`);
        this.sendEvent(new OutputEvent(`ColdFusion Debugger attached (session ID: ${sessionId})\n`, 'console'));

        // Subscribe to the ConnectionManager's shared event loop — no second poll loop.
        this._eventSubscription?.dispose();
        this._eventSubscription = cm.onDidReceiveDebugEvent(event => {
            this._handleDebugEvent(event);
        });

        // If ConnectionManager received a break/step event before this DAP session attached, handle it now!
        if (cm.lastDebugEvent) {
            Logger.info('[DAP] Processing pending lastDebugEvent from ConnectionManager');
            this._handleDebugEvent(cm.lastDebugEvent);
        }

        // Sync all breakpoints set before debug session started
        for (const [filepath, bps] of this._breakpoints.entries()) {
            for (const bp of bps) {
                if (bp.line !== undefined) {
                    try {
                        Logger.info(`[DAP] Syncing breakpoint to server: ${filepath}:${bp.line}`);
                        await cm.setBreakpoint(filepath, bp.line, true);
                    } catch (e) {
                        Logger.warn(`[DAP] Failed to sync breakpoint ${filepath}:${bp.line}: ${e}`);
                    }
                }
            }
        }
    }

    private _handleDebugEvent(event: DebuggerEvent): void {
        Logger.info(`[DAP] Received DebuggerEvent type=${event.type}: ${JSON.stringify(event.data)}`);
        switch (event.type) {

            case CFRDS_DEBUGGER_EVENT_TYPE.BREAKPOINT: {
                let source       = String(event.data.source || event.data.pathname || event.data.file || event.data.CFML_PATH || event.data.FILE || event.data.FILENAME || event.data.TEMPLATE || '');
                const line       = Number(event.data.line || event.data.req_line || event.data.act_line || 0);
                const threadName = String(event.data.thread_name || event.data.thread_id || 'main');

                source = this._resolveSourcePath(source, line);

                this._stoppedSource     = source;
                this._stoppedLine       = line;
                this._stoppedThreadName = threadName;
                this._stoppedEventData  = event.data as Record<string, any>;
                Logger.info(`[DAP] Breakpoint hit: source="${source}" line=${line} thread=${threadName}`);
                this.sendEvent(new OutputEvent(`Breakpoint hit: ${source}:${line}\n`, 'console'));
                this.sendEvent(new StoppedEvent('breakpoint', CfmlDebugSession.THREAD_ID));
                break;
            }

            case CFRDS_DEBUGGER_EVENT_TYPE.STEP: {
                let source       = String(event.data.source || event.data.pathname || event.data.file || event.data.CFML_PATH || event.data.FILE || event.data.FILENAME || event.data.TEMPLATE || '');
                const line       = Number(event.data.line || event.data.req_line || event.data.act_line || 0);
                const threadName = String(event.data.thread_name || event.data.thread_id || 'main');

                source = this._resolveSourcePath(source, line);

                this._stoppedSource     = source;
                this._stoppedLine       = line;
                this._stoppedThreadName = threadName;
                this._stoppedEventData  = event.data as Record<string, any>;
                Logger.info(`[DAP] Step event: source="${source}" line=${line} thread=${threadName}`);
                this.sendEvent(new OutputEvent(`Step: ${source}:${line}\n`, 'console'));
                this.sendEvent(new StoppedEvent('step', CfmlDebugSession.THREAD_ID));
                break;
            }

            case CFRDS_DEBUGGER_EVENT_TYPE.BREAKPOINT_SET: {
                const pathname = String(event.data.pathname || '');
                const reqLine  = Number(event.data.req_line || 0);
                const actLine  = Number(event.data.act_line || 0);
                Logger.info(`[DAP] Breakpoint set confirmed: ${pathname} req=${reqLine} act=${actLine}`);
                break;
            }

            default:
                Logger.info(`[DAP] Unhandled event type=${event.type}: ${JSON.stringify(event.data)}`);
                break;
        }
    }

    private _resolveSourcePath(source: string, line: number): string {
        let raw = source;
        if (!raw && line > 0) {
            // Try exact line match against set breakpoints in DAP session
            for (const [filePath, bps] of this._breakpoints.entries()) {
                if (bps.some(bp => bp.line === line)) {
                    raw = filePath;
                    break;
                }
            }
        }

        if (!raw) return '';
        return normalizeVfsPath(raw);
    }

    // ── Breakpoints ───────────────────────────────────────────────────────

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const rawPath = args.source.path ?? '';
        const serverPath = normalizeVfsPath(rawPath);
        Logger.info(`DAP setBreakPointsRequest: ${rawPath} -> normalized: ${serverPath} (${args.breakpoints?.length ?? 0} breakpoints)`);

        const reqLines = new Set<number>((args.breakpoints ?? []).map(bp => bp.line));
        const prevBps = this._breakpoints.get(rawPath) ?? this._breakpoints.get(serverPath) ?? [];
        const prevLines = new Set<number>(prevBps.map(bp => bp.line).filter((l): l is number => typeof l === 'number'));

        // Route all breakpoint changes through ConnectionManager so there is exactly
        // one caller path to the server (uses the shared RDS session ID).
        const cm = this.virtualFsProvider?.connectionManager;

        // Sync added breakpoints to ColdFusion RDS server
        for (const line of reqLines) {
            if (line !== undefined && !prevLines.has(line)) {
                Logger.info(`[DAP] Adding breakpoint on ${serverPath}:${line}`);
                if (cm?.isConnected) {
                    try {
                        await cm.setBreakpoint(serverPath, line, true);
                    } catch (e) {
                        Logger.warn(`[DAP] Failed to set server breakpoint: ${e}`);
                    }
                }
            }
        }

        // Sync removed breakpoints to ColdFusion RDS server
        for (const line of prevLines) {
            if (line !== undefined && !reqLines.has(line)) {
                Logger.info(`[DAP] Removing breakpoint on ${serverPath}:${line}`);
                if (cm?.isConnected) {
                    try {
                        await cm.setBreakpoint(serverPath, line, false);
                    } catch (e) {
                        Logger.warn(`[DAP] Failed to remove server breakpoint: ${e}`);
                    }
                }
            }
        }

        const breakpoints: DebugProtocol.Breakpoint[] = (args.breakpoints ?? []).map(
            bp => new Breakpoint(true, bp.line, undefined, new Source(args.source.name ?? serverPath, rawPath))
        );

        this._breakpoints.set(rawPath, breakpoints);
        this._breakpoints.set(serverPath, breakpoints);

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    // ── Threads ───────────────────────────────────────────────────────────

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        Logger.info(`DAP threadsRequest thread=${this._stoppedThreadName}`);
        response.body = {
            threads: [new Thread(CfmlDebugSession.THREAD_ID, this._stoppedThreadName || 'main')]
        };
        this.sendResponse(response);
    }

    // ── Stack frames ──────────────────────────────────────────────────────

    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        _args: DebugProtocol.StackTraceArguments
    ): void {
        const sourcePath = this._resolveSourcePath(this._stoppedSource, this._stoppedLine);
        const line = this._stoppedLine > 0 ? this._stoppedLine : 1;
        Logger.info(`DAP stackTraceRequest: sourcePath="${sourcePath}" line=${line}`);
        if (this._stoppedEventData) {
            Logger.info(`[CallStack Diagnostic] _stoppedEventData: ${JSON.stringify(this._stoppedEventData)}`);
        }

        const name = sourcePath ? (sourcePath.split(/[\\/]/).pop() ?? sourcePath) : 'CFML File';
        let srcUri = sourcePath;
        if (sourcePath && !sourcePath.startsWith('cfrds:') && !/^[a-zA-Z]:[\\/]/.test(sourcePath)) {
            const cleanPath = sourcePath.startsWith('/') ? sourcePath : '/' + sourcePath;
            srcUri = `cfrds://${cleanPath}`;
        }
        const src  = sourcePath ? new Source(name, srcUri) : undefined;
        const topFrame = new StackFrame(0, name, src, line, 0);

        const stackFrames: StackFrame[] = [topFrame];

        // Safely parse additional CF_TRACE frames if present
        if (this._stoppedEventData && Array.isArray(this._stoppedEventData.CF_TRACE)) {
            const traces = this._stoppedEventData.CF_TRACE as string[];
            // Trace items look like "/app/test.cfm:11"
            traces.slice(1).forEach((traceStr, idx) => {
                let framePath = traceStr;
                let frameLine = 1;
                const lastColon = traceStr.lastIndexOf(':');
                if (lastColon > 0) {
                    const parsedLine = Number(traceStr.substring(lastColon + 1));
                    if (!isNaN(parsedLine) && parsedLine > 0) {
                        framePath = traceStr.substring(0, lastColon);
                        frameLine = parsedLine;
                    }
                }
                const resolved = this._resolveSourcePath(framePath, frameLine);
                const frameName = resolved ? (resolved.split(/[\\/]/).pop() ?? resolved) : `Frame ${idx + 1}`;
                let frameUri = resolved;
                if (resolved && !resolved.startsWith('cfrds:') && !/^[a-zA-Z]:[\\/]/.test(resolved)) {
                    const cleanPath = resolved.startsWith('/') ? resolved : '/' + resolved;
                    frameUri = `cfrds://${cleanPath}`;
                }
                const frameSrc = resolved ? new Source(frameName, frameUri) : undefined;
                stackFrames.push(new StackFrame(idx + 1, `${frameName}:${frameLine}`, frameSrc, frameLine, 0));
            });
        }

        response.body = {
            stackFrames,
            totalFrames: stackFrames.length
        };
        this.sendResponse(response);
    }

    // ── Scopes & variables ────────────────────────────────────────────────

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        _args: DebugProtocol.ScopesArguments
    ): void {
        Logger.info('DAP scopesRequest');
        this._resetVarHandles();

        response.body = {
            scopes: [
                new Scope('VARIABLES', 1, true),
                new Scope('LOCAL', 2, true),
                new Scope('ARGUMENTS', 3, true),
                new Scope('ATTRIBUTES', 4, true),
                new Scope('CALLER', 5, true),
                new Scope('CFCATCH', 6, true),
                new Scope('CFFILE', 7, true),
                new Scope('CFHTTP', 8, true),
                new Scope('REQUEST', 9, true),
                new Scope('URL', 10, true),
                new Scope('FORM', 11, true),
                new Scope('COOKIE', 12, true),
                new Scope('CGI', 13, true),
                new Scope('SESSION', 14, true),
                new Scope('APPLICATION', 15, true),
                new Scope('SERVER', 16, true),
                new Scope('CLUSTER', 17, true),
            ]
        };
        this.sendResponse(response);
    }

    private _nextVarRef = 100;
    private _varHandles = new Map<number, { val: any; depth: number }>();

    private _resetVarHandles(): void {
        this._varHandles.clear();
        this._nextVarRef = 100;
    }

    private static readonly MAX_STRUCT_DEPTH = 10;

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        Logger.info(`DAP variablesRequest ref=${args.variablesReference}`);
        const cm = this.virtualFsProvider?.connectionManager;

        // Dynamic handle expansion for nested structs/arrays (ref >= 100)
        if (args.variablesReference >= 100) {
            const handle = this._varHandles.get(args.variablesReference);
            const rawObj = handle?.val;
            const currentDepth = handle?.depth ?? 0;
            const vars: Variable[] = [];

            if (rawObj && typeof rawObj === 'object') {
                const allowChild = currentDepth < CfmlDebugSession.MAX_STRUCT_DEPTH;
                if (Array.isArray(rawObj)) {
                    rawObj.forEach((val, idx) => {
                        const isObj = typeof val === 'object' && val !== null;
                        const childRef = (isObj && allowChild && this._nextVarRef <= 100_000) ? this._nextVarRef++ : 0;
                        if (childRef > 0) {
                            this._varHandles.set(childRef, { val, depth: currentDepth + 1 });
                        }
                        const displayVal = (isObj && !allowChild) ? '[Max Depth Reached]' : formatCleanValue(val);
                        const v = new Variable(`[${idx + 1}]`, displayVal, childRef) as any;
                        v.type = getCfmlType(val);
                        vars.push(v);
                    });
                } else {
                    Object.entries(rawObj).forEach(([k, val]) => {
                        const isObj = typeof val === 'object' && val !== null;
                        const childRef = (isObj && allowChild && this._nextVarRef <= 100_000) ? this._nextVarRef++ : 0;
                        if (childRef > 0) {
                            this._varHandles.set(childRef, { val, depth: currentDepth + 1 });
                        }
                        const displayVal = (isObj && !allowChild) ? '[Max Depth Reached]' : formatCleanValue(val);
                        const v = new Variable(k, displayVal, childRef) as any;
                        v.type = getCfmlType(val);
                        vars.push(v);
                    });
                }
            }
            response.body = { variables: vars };
            this.sendResponse(response);
            return;
        }

        if (!cm?.isConnected) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        const scopeMap: Record<number, string> = {
            1: 'variables',
            2: 'local',
            3: 'arguments',
            4: 'attributes',
            5: 'caller',
            6: 'cfcatch',
            7: 'cffile',
            8: 'cfhttp',
            9: 'request',
            10: 'url',
            11: 'form',
            12: 'cookie',
            13: 'cgi',
            14: 'session',
            15: 'application',
            16: 'server',
            17: 'cluster',
        };
        const scopeName = scopeMap[args.variablesReference] || 'variables';

        try {
            const res = await cm.evaluateExpression(this._stoppedThreadName, scopeName);
            const vars: Variable[] = [];

            if (res.rawValue && typeof res.rawValue === 'object') {
                const rawObj = res.rawValue;
                if (Array.isArray(rawObj)) {
                    rawObj.forEach((val, idx) => {
                        const isObj = typeof val === 'object' && val !== null;
                        const childRef = (isObj && this._nextVarRef <= 100_000) ? this._nextVarRef++ : 0;
                        if (childRef > 0) {
                            this._varHandles.set(childRef, { val, depth: 1 });
                        }
                        const v = new Variable(`[${idx + 1}]`, formatCleanValue(val), childRef) as any;
                        v.type = getCfmlType(val);
                        vars.push(v);
                    });
                } else {
                    Object.entries(rawObj).forEach(([k, val]) => {
                        const isObj = typeof val === 'object' && val !== null;
                        const childRef = (isObj && this._nextVarRef <= 100_000) ? this._nextVarRef++ : 0;
                        if (childRef > 0) {
                            this._varHandles.set(childRef, { val, depth: 1 });
                        }
                        const v = new Variable(k, formatCleanValue(val), childRef) as any;
                        v.type = getCfmlType(val);
                        vars.push(v);
                    });
                }
            } else {
                vars.push(...res.variables.map(item => {
                    const v = new Variable(item.name, item.value) as any;
                    if (item.type) v.type = item.type;
                    return v;
                }));
            }

            response.body = { variables: vars };
        } catch (e) {
            Logger.warn(`[DAP] variablesRequest error: ${e}`);
            response.body = { variables: [] };
        }
        this.sendResponse(response);
    }

    // ── Execution control ─────────────────────────────────────────────────

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        _args: DebugProtocol.ContinueArguments
    ): Promise<void> {
        Logger.info(`DAP continueRequest thread=${this._stoppedThreadName}`);
        response.body = { allThreadsContinued: true };
        this.sendResponse(response);
        await this._execControl((server, sid) =>
            server.debuggerContinue(sid, this._stoppedThreadName)
        );
    }

    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        _args: DebugProtocol.NextArguments
    ): Promise<void> {
        Logger.info(`DAP nextRequest (step over) thread=${this._stoppedThreadName}`);
        this.sendResponse(response);
        await this._execControl((server, sid) =>
            server.debuggerStepOver(sid, this._stoppedThreadName)
        );
    }

    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        _args: DebugProtocol.StepInArguments
    ): Promise<void> {
        Logger.info(`DAP stepInRequest thread=${this._stoppedThreadName}`);
        this.sendResponse(response);
        await this._execControl((server, sid) =>
            server.debuggerStepIn(sid, this._stoppedThreadName)
        );
    }

    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        _args: DebugProtocol.StepOutArguments
    ): Promise<void> {
        Logger.info(`DAP stepOutRequest thread=${this._stoppedThreadName}`);
        this.sendResponse(response);
        await this._execControl((server, sid) =>
            server.debuggerStepOut(sid, this._stoppedThreadName)
        );
    }

    /**
     * Helper that runs an execution-control command through the shared server
     * connection.  Logs and swallows errors so the UI is never left in a broken
     * state if the server call fails.
     */
    private async _execControl(
        fn: (server: Server, sessionId: string) => Promise<void>
    ): Promise<void> {
        const cm = this.virtualFsProvider?.connectionManager;
        if (!cm?.isConnected || !cm.server || !cm.dbgSessionId) {
            Logger.warn('[DAP] _execControl: not connected or no active session');
            return;
        }
        cm.clearLastDebugEvent();
        try {
            await fn(cm.server, cm.dbgSessionId);
        } catch (e) {
            Logger.warn(`[DAP] _execControl error: ${e}`);
        }
    }

    // ── Evaluate ──────────────────────────────────────────────────────────

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        Logger.info(`DAP evaluateRequest context=${args.context} expr=${args.expression}`);
        const cm = this.virtualFsProvider?.connectionManager;
        if (cm?.isConnected) {
            try {
                const res = await cm.evaluateExpression(
                    this._stoppedThreadName,
                    args.expression
                );
                let varRef = 0;
                if (res.rawValue && typeof res.rawValue === 'object') {
                    varRef = this._nextVarRef++;
                    this._varHandles.set(varRef, res.rawValue);
                }
                response.body = {
                    result: res.result,
                    type: res.type,
                    variablesReference: varRef
                };
            } catch (e) {
                Logger.warn(`[DAP] evaluateRequest error: ${e}`);
                response.body = { result: `(error: ${e})`, variablesReference: 0 };
            }
        } else {
            response.body = { result: '(not connected)', variablesReference: 0 };
        }
        this.sendResponse(response);
    }
}
