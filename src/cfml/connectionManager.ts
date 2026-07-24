import * as vscode from "vscode";
import {
  Server,
  IdeDefaultResult,
  BrowseDirItem,
  DebuggerEvent,
  CFRDS_DEBUGGER_EVENT_TYPE,
} from "@bokic/cfrds";
import { sendRdsCommand } from "@bokic/cfrds/dist/transport";
import { parseNumber, parseString } from "@bokic/cfrds/dist/parser";
import { parseWddxResponse, ParsedWddxResult } from "../utils/wddxParser";
import { Logger } from "../utils/logger";

export interface ConnectionInfo {
  host: string;
  port: number;
  username: string;
  password: string;
  path?: string;
}

export type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      server: Server;
      info: IdeDefaultResult;
      rootPath: string;
      dbgSessionId?: string;
    }
  | { status: "error"; message: string };

/**
 * ConnectionManager
 *
 * Central singleton that owns the live Server instance.
 * Fires `onDidChangeState` whenever the connection status changes so
 * all UI components can refresh.
 */
export class ConnectionManager implements vscode.Disposable {
  private _state: ConnectionState = { status: "disconnected" };

  private readonly _emitter = new vscode.EventEmitter<ConnectionState>();
  private readonly _eventEmitter = new vscode.EventEmitter<DebuggerEvent>();

  /** Subscribe to connection state changes. */
  readonly onDidChangeState: vscode.Event<ConnectionState> =
    this._emitter.event;

  /** Subscribe to incoming ColdFusion debugger events. */
  readonly onDidReceiveDebugEvent: vscode.Event<DebuggerEvent> =
    this._eventEmitter.event;

  private _isEventLoopActive = false;
  private _eventLoopSessionId?: string;

  dispose(): void {
    this.stopEventLoop();
    this.disconnect().catch((err) => {
      Logger.warn(
        `[ConnectionManager] Error during dispose disconnect: ${err}`,
      );
    });
  }

  // ── Public accessors ──────────────────────────────────────────────────

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state.status === "connected";
  }

  get server(): Server | undefined {
    return this._state.status === "connected" ? this._state.server : undefined;
  }

  get dbgSessionId(): string | undefined {
    return this._state.status === "connected"
      ? this._state.dbgSessionId
      : undefined;
  }

  get rootPath(): string {
    return this._state.status === "connected" ? this._state.rootPath : "/";
  }

  // ── Connection control ────────────────────────────────────────────────

  async connect(cfg: ConnectionInfo): Promise<void> {
    if (this._state.status === "connecting") {
      Logger.warn(
        "[ConnectionManager] Already connecting — ignoring duplicate call.",
      );
      return;
    }

    this._setState({ status: "connecting" });
    Logger.info(
      `[ConnectionManager] Connecting to ColdFusion server ${cfg.host}:${cfg.port}...`,
    );

    const server = new Server(cfg.host, cfg.port, cfg.username, cfg.password);
    // ColdFusion long-polling requests must block on the client until the server responds.
    // Set socket timeout to 0 (disabled) so Node.js never aborts long-poll requests on our side.
    if ((server as any).ctx) {
      (server as any).ctx.timeout = 0;
    }

    try {
      const info: IdeDefaultResult = {
        num1: 0,
        server_version: "ColdFusion Server",
        client_version: "1.0.0",
        num2: 0,
        num3: 0,
      };

      // Discover the CF root directory (verifies RDS connection)
      let rootPath = cfg.path && cfg.path !== "/" ? cfg.path : "/";
      const cfRoot = await server.cfRootDir();
      Logger.info(
        `[ConnectionManager] server.cfRootDir() -> ${JSON.stringify(cfRoot)}`,
      );
      if (!cfg.path || cfg.path === "/") {
        rootPath = cfRoot || "/";
      }

      // Start ColdFusion RDS Debugger Session
      let dbgSessionId: string | undefined;
      try {
        dbgSessionId = await server.debuggerStart();
        Logger.info(
          `[ConnectionManager] server.debuggerStart() -> ${JSON.stringify(dbgSessionId)}`,
        );
      } catch (e) {
        const errStr = String(e);
        Logger.warn(
          `[ConnectionManager] server.debuggerStart() thrown error: ${errStr}`,
        );
        if (
          errStr.includes("Max session count reached") ||
          errStr.includes("Cannot start a new session")
        ) {
          vscode.window.showErrorMessage(
            "ColdFusion RDS Debugger Error: Max session count reached. Cannot start a new debug session. Please restart ColdFusion.",
            { modal: true },
            "OK",
          );
        } else {
          vscode.window.showErrorMessage(
            `ColdFusion RDS Debugger Error: Failed to start debug session (${errStr})`,
          );
        }
      }

      Logger.info(
        `[ConnectionManager] Connected successfully! Active VFS root path: ${rootPath}`,
      );
      this._setState({
        status: "connected",
        server,
        info,
        rootPath,
        dbgSessionId,
      });

      if (dbgSessionId) {
        this.startEventLoop(dbgSessionId);
        if (!vscode.debug.activeDebugSession) {
          Logger.info(
            "[ConnectionManager] Auto-starting VS Code DAP debug session on connect...",
          );
          vscode.debug
            .startDebugging(undefined, {
              type: "cfml",
              name: "ColdFusion Debugger",
              request: "attach",
              serverUrl: `http://${cfg.host}:${cfg.port}`,
            })
            .then(
              (ok) =>
                Logger.info(
                  `[ConnectionManager] Auto-start debug session result: ${ok}`,
                ),
              (err) =>
                Logger.warn(
                  `[ConnectionManager] Failed to auto-start debug session: ${err}`,
                ),
            );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error(`[ConnectionManager] Connection failed: ${msg}`);
      this._setState({ status: "error", message: msg });
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.stopEventLoop();

    // Stop active VS Code debug session and wait for termination promise to complete
    if (vscode.debug.activeDebugSession) {
      const currentSession = vscode.debug.activeDebugSession;
      const sessionTerminatedPromise = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((session) => {
          if (session.id === currentSession.id) {
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 3000);
      });

      try {
        await vscode.debug.stopDebugging(currentSession);
        await sessionTerminatedPromise;
      } catch (e) {
        Logger.warn(
          `[ConnectionManager] Error stopping active debug session: ${e}`,
        );
      }
    }

    if (this._state.status === "connected") {
      const server = this._state.server;
      const sessionId = this._state.dbgSessionId;

      // Update state to disconnected immediately so UI updates right away
      this._setState({ status: "disconnected" });

      // Immediately destroy the agent sockets so the blocking long-poll HTTP request is aborted!
      try {
        if ((server as any).ctx?.agent) {
          (server as any).ctx.agent.destroy();
        }
      } catch (e) {
        Logger.warn(
          `[ConnectionManager] Error destroying agent sockets on disconnect: ${e}`,
        );
      }

      if (sessionId) {
        try {
          // Re-create temporary agent to send clean teardown commands
          if ((server as any).ctx) {
            (server as any).ctx.agent = new (require("http").Agent)({
              keepAlive: false,
            });
          }
          await server.debuggerClearAllBreakpoints(sessionId);
          Logger.info(
            `[ConnectionManager] Cleared breakpoints on disconnect for session ID=${sessionId}`,
          );
        } catch (e) {
          Logger.warn(
            `[ConnectionManager] FAILED to clear breakpoints on disconnect: ${e}`,
          );
        }
        const threadName =
          this._lastThreadName ||
          (this._lastDebugEvent?.data
            ? String(
                this._lastDebugEvent.data.thread_name ||
                  this._lastDebugEvent.data.thread_id ||
                  this._lastDebugEvent.data.THREAD ||
                  this._lastDebugEvent.data.THREAD_ID ||
                  "main",
              )
            : "main");
        if (threadName) {
          try {
            await server.debuggerContinue(sessionId, threadName);
            Logger.info(
              `[ConnectionManager] Executed continue command on disconnect for session ID=${sessionId}, thread=${threadName}`,
            );
          } catch (e) {
            Logger.warn(
              `[ConnectionManager] FAILED to execute continue command on disconnect: ${e}`,
            );
          }
        }
        try {
          await server.debuggerStop(sessionId);
          Logger.info(
            `[ConnectionManager] Stopped debugger session on disconnect for session ID=${sessionId}`,
          );
        } catch (e) {
          Logger.warn(
            `[ConnectionManager] FAILED to stop debugger session on disconnect: ${e}`,
          );
        }
      }
      try {
        await server.close();
      } catch (e) {
        Logger.warn(`[ConnectionManager] Error closing server: ${e}`);
      }
    } else {
      this._setState({ status: "disconnected" });
    }
    Logger.info("[ConnectionManager] Disconnected.");
  }

  // ── Debugger Event Loop ───────────────────────────────────────────────

  startEventLoop(sessionId: string): void {
    if (this._isEventLoopActive && this._eventLoopSessionId === sessionId) {
      return;
    }
    this.stopEventLoop();
    this._isEventLoopActive = true;
    this._eventLoopSessionId = sessionId;
    this._runEventLoop(sessionId);
  }

  stopEventLoop(): void {
    this._isEventLoopActive = false;
    this._eventLoopSessionId = undefined;
  }

  private _lastDebugEvent?: DebuggerEvent;
  private _lastThreadName?: string;

  get lastDebugEvent(): DebuggerEvent | undefined {
    return this._lastDebugEvent;
  }

  get lastThreadName(): string | undefined {
    return this._lastThreadName;
  }

  clearLastDebugEvent(): void {
    this._lastDebugEvent = undefined;
  }

  private async _runEventLoop(sessionId: string): Promise<void> {
    Logger.info(
      `[ConnectionManager] Started debugger event polling loop for session ID=${sessionId}`,
    );
    while (this._isEventLoopActive && this._eventLoopSessionId === sessionId) {
      if (this._state.status !== "connected") {
        break;
      }
      try {
        const event = await this._state.server.debuggerAllFetchFlagsEnabled(
          sessionId,
          false,
          false,
          false,
          true,
          false,
        );
        if (
          !this._isEventLoopActive ||
          this._eventLoopSessionId !== sessionId
        ) {
          break;
        }
        if (event) {
          if (event.type !== CFRDS_DEBUGGER_EVENT_TYPE.BREAKPOINT_SET) {
            if (
              event.type === CFRDS_DEBUGGER_EVENT_TYPE.BREAKPOINT ||
              event.type === CFRDS_DEBUGGER_EVENT_TYPE.STEP
            ) {
              this._lastDebugEvent = event;
              const tName = String(
                event.data?.thread_name ||
                  event.data?.thread_id ||
                  event.data?.THREAD ||
                  event.data?.THREAD_ID ||
                  "",
              );
              if (tName) {
                this._lastThreadName = tName;
              }
            }
            this._eventEmitter.fire(event);

            if (!vscode.debug.activeDebugSession) {
              Logger.info(
                "[ConnectionManager] Breakpoint/Step event received with no active VS Code debug session. Auto-starting DAP session...",
              );
              const host =
                this._state.status === "connected"
                  ? this._state.server.getHost()
                  : "localhost";
              const port =
                this._state.status === "connected"
                  ? this._state.server.getPort()
                  : 8500;
              vscode.debug
                .startDebugging(undefined, {
                  type: "cfml",
                  name: "ColdFusion Debugger",
                  request: "attach",
                  serverUrl: `http://${host}:${port}`,
                })
                .then(
                  (ok) =>
                    Logger.info(
                      `[ConnectionManager] Auto-start debug session result: ${ok}`,
                    ),
                  (err) =>
                    Logger.warn(
                      `[ConnectionManager] Failed to auto-start debug session: ${err}`,
                    ),
                );
            }
          }
        } else {
          // If no event is returned, wait a brief tick before polling again
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (err) {
        if (
          !this._isEventLoopActive ||
          this._eventLoopSessionId !== sessionId
        ) {
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        Logger.warn(
          `[ConnectionManager] Error fetching debugger events: ${msg}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    Logger.info(
      `[ConnectionManager] Stopped debugger event polling loop for session ID=${sessionId}`,
    );
  }

  async setBreakpoint(
    filepath: string,
    line: number,
    enable: boolean,
  ): Promise<void> {
    if (this._state.status !== "connected" || !this._state.dbgSessionId) {
      Logger.warn(
        `[ConnectionManager] Cannot set breakpoint ${filepath}:${line} — no active RDS debug session.`,
      );
      return;
    }
    const actionName = enable ? "Add" : "Remove";
    Logger.info(
      `[ConnectionManager] ${actionName} breakpoint on server: ${filepath}:${line}`,
    );
    const res = await this._state.server.debuggerBreakpoint(
      this._state.dbgSessionId,
      filepath,
      line,
      enable,
    );
    Logger.info(
      `[ConnectionManager] server.debuggerBreakpoint("${this._state.dbgSessionId}", "${filepath}", ${line}, ${enable}) -> ${JSON.stringify(res)}`,
    );
  }

  async evaluateExpression(
    threadName: string,
    expression: string,
  ): Promise<ParsedWddxResult> {
    if (this._state.status !== "connected" || !this._state.dbgSessionId) {
      return { result: "(not connected)", variables: [] };
    }
    const server = this._state.server;
    const sessionName = this._state.dbgSessionId;
    const wddx = `<wddxPacket version='1.0'><header/><data><array length='1'><struct type='java.util.HashMap'><var name='COMMAND'><string>GET_SINGLE_CF_VARIABLE</string></var><var name='VARIABLE_NAME'><string>${expression}</string></var><var name='THREAD'><string>${threadName || "main"}</string></var></struct></array></data></wddxPacket>`;

    try {
      const raw = await sendRdsCommand((server as any).ctx, "DBGREQUEST", [
        "DBG_REQUEST",
        sessionName,
        wddx,
      ]);
      const [, offset] = parseNumber(raw, 0);
      const [wddxXml] = parseString(raw, offset);
      Logger.info(
        `[ConnectionManager] evaluateExpression("${expression}") -> ${wddxXml}`,
      );
      return parseWddxResponse(wddxXml);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.warn(
        `[ConnectionManager] evaluateExpression("${expression}") failed: ${msg}`,
      );
      return { result: `Error: ${msg}`, variables: [] };
    }
  }

  // ── Directory browsing (convenience) ──────────────────────────────────

  /**
   * Browse a directory on the CF server.
   * Throws if not connected.
   */
  async browseDir(path: string): Promise<BrowseDirItem[]> {
    const srv = this._requireServer();
    Logger.debug(`[ConnectionManager] browseDir: ${path}`);
    return await srv.browseDir(path);
  }

  /**
   * Read a file's raw bytes from the CF server.
   * Throws if not connected.
   */
  async readFile(path: string): Promise<Buffer> {
    const srv = this._requireServer();
    Logger.debug(`[ConnectionManager] readFile: ${path}`);
    const fc = await srv.fileRead(path);
    return fc.data;
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _setState(state: ConnectionState): void {
    this._state = state;
    this._emitter.fire(state);
  }

  private _requireServer(): Server {
    if (this._state.status !== "connected") {
      throw new Error("Not connected to a ColdFusion server.");
    }
    return this._state.server;
  }
}
