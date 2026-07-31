import * as vscode from 'vscode';
import { ConnectionManager, ConnectionState } from '../cfml/connectionManager';
import { Logger } from '../utils/logger';

const SETTINGS_KEY = 'cfmlDebugger';

interface CfmlConnectionSettings {
    hostname: string;
    port:     number;
    username: string;
    password: string;
    path:     string;
    url:      string;
}

function loadSettings(): CfmlConnectionSettings {
    const cfg = vscode.workspace.getConfiguration(SETTINGS_KEY);
    return {
        hostname: cfg.get<string>('hostname', 'localhost'),
        port:     cfg.get<number>('port',     8500),
        username: cfg.get<string>('username', 'admin'),
        password: cfg.get<string>('password', ''),
        path:     cfg.get<string>('path',     '/'),
        url:      cfg.get<string>('url',      'http://localhost:8500'),
    };
}

async function saveSetting(key: string, value: string | number): Promise<void> {
    await vscode.workspace
        .getConfiguration(SETTINGS_KEY)
        .update(key, value, vscode.ConfigurationTarget.Global);
}

/** Messages flowing extension → webview */
type ExtToWeb =
    | { command: 'settings';    settings: CfmlConnectionSettings }
    | { command: 'connState';   state: SerialState };

/** Serialisable connection state sent to the webview */
interface SerialState {
    status:         'disconnected' | 'connecting' | 'connected' | 'error';
    serverVersion?: string;
    clientVersion?: string;
    rootPath?:      string;
    dbgSessionId?:  string;
    error?:         string;
}

function toSerialState(s: ConnectionState): SerialState {
    switch (s.status) {
        case 'connected':
            return {
                status:        'connected',
                serverVersion: s.info.server_version,
                clientVersion: s.info.client_version,
                rootPath:      s.rootPath,
                dbgSessionId:  s.dbgSessionId,
            };
        case 'error':
            return { status: 'error', error: s.message };
        default:
            return { status: s.status };
    }
}

export class CfmlSettingsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'cfmlDebuggerSettings';

    private _view?: vscode.WebviewView;
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _connectionManager: ConnectionManager
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        // Dispose existing listeners if re-resolving view
        while (this._disposables.length > 0) {
            this._disposables.pop()?.dispose();
        }

        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._buildHtml(webviewView.webview);

        webviewView.onDidDispose(() => {
            while (this._disposables.length > 0) {
                this._disposables.pop()?.dispose();
            }
            this._view = undefined;
        });

        // ── Extension → Webview: push initial state after load ────────────
        this._disposables.push(
            webviewView.webview.onDidReceiveMessage(async (msg: { command: string; key?: string; value?: string | number; settings?: CfmlConnectionSettings }) => {
                switch (msg.command) {

                    case 'ready':
                        // Webview signalled it's ready — push current settings + state
                        this._postSettings();
                        this._postState();
                        break;

                    case 'saveSetting':
                        if (msg.key !== undefined && msg.value !== undefined) {
                            await saveSetting(msg.key, msg.value);
                        }
                        break;

                    case 'connect': {
                        let s = loadSettings();
                        if (msg.settings) {
                            // Persist and use the exact values from the DOM inputs
                            s = msg.settings as CfmlConnectionSettings;
                            await Promise.all([
                                saveSetting('hostname', s.hostname),
                                saveSetting('port',     s.port),
                                saveSetting('username', s.username),
                                saveSetting('password', s.password),
                                saveSetting('path',     s.path),
                                saveSetting('url',      s.url),
                            ]);
                        }
                        try {
                            await this._connectionManager.connect({
                                host:     s.hostname,
                                port:     s.port,
                                username: s.username,
                                password: s.password,
                                path:     s.path,
                            });
                        } catch (e) {
                            // State is already set to 'error' by the manager
                            Logger.error(`[SettingsPanel] connect error: ${e}`);
                            vscode.window.showErrorMessage(`ColdFusion Connection Failed: ${e}`, 'Show Debug Log').then(choice => {
                                if (choice === 'Show Debug Log') {
                                    Logger.show();
                                }
                            });
                        }
                        break;
                    }

                    case 'disconnect':
                        await this._connectionManager.disconnect();
                        break;
                }
            }),

            // ── Push state changes to the webview ─────────────────────────────
            this._connectionManager.onDidChangeState(() => {
                this._postState();
            }),

            // ── Re-push settings when changed externally ──────────────────────
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(SETTINGS_KEY)) {
                    this._postSettings();
                }
            })
        );
    }

    // ── Private ───────────────────────────────────────────────────────────

    private _post(msg: ExtToWeb): void {
        this._view?.webview.postMessage(msg);
    }

    private _postSettings(): void {
        this._post({ command: 'settings', settings: loadSettings() });
    }

    private _postState(): void {
        this._post({ command: 'connState', state: toSerialState(this._connectionManager.state) });
    }

    private _buildHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>ColdFusion Connection</title>
<style nonce="${nonce}">
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 10px 8px 24px;
  }

  /* ── Connection status bar ── */
  .status-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    border-radius: 3px;
    margin-bottom: 12px;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.1));
    font-size: 11px;
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.3s;
  }
  .status-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-sub  { font-size: 10px; opacity: 0.65; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .dot-disconnected { background: var(--vscode-testing-iconFailed, #f44); }
  .dot-connecting   { background: var(--vscode-charts-yellow, #f90); animation: pulse 1s infinite; }
  .dot-connected    { background: var(--vscode-testing-iconPassed, #4c4); }
  .dot-error        { background: var(--vscode-editorError-foreground, #f44); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }

  /* ── Section headers ── */
  .section-title {
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    opacity: 0.7; margin-bottom: 9px; padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  }

  /* ── Form fields ── */
  .form-group { display: flex; flex-direction: column; gap: 3px; margin-bottom: 9px; }

  label { font-size: 11px; color: var(--vscode-descriptionForeground); user-select: none; }

  input {
    width: 100%; height: 26px; padding: 0 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input:disabled { opacity: 0.5; }
  input[type="number"] { -moz-appearance: textfield; }
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; }

  .url-row { display: flex; gap: 4px; }
  .url-row input { flex: 1; }

  .icon-btn {
    flex-shrink: 0; width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; cursor: pointer;
    color: var(--vscode-foreground); font-size: 13px;
    transition: background 0.15s;
  }
  .icon-btn:hover { background: var(--vscode-list-hoverBackground); }
  .icon-btn:disabled { opacity: 0.4; cursor: default; }

  .divider { margin: 12px 0 9px; border: none; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, #555); }

  /* ── Connect / Disconnect buttons ── */
  .btn-row { display: flex; gap: 6px; margin-top: 12px; }

  .btn {
    flex: 1; height: 28px; border-radius: 2px; border: none;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    cursor: pointer; font-weight: 500; transition: opacity 0.15s;
  }
  .btn:disabled { opacity: 0.4; cursor: default; }

  .btn-connect {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-connect:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }

  .btn-disconnect {
    background: var(--vscode-button-secondaryBackground, #555);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .btn-disconnect:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #666); }

  /* ── Info block shown after connect ── */
  .server-info {
    display: none;
    margin-top: 10px;
    padding: 6px 8px;
    font-size: 11px;
    border-radius: 3px;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.1));
    line-height: 1.6;
  }
  .server-info.show { display: block; }
  .info-label { opacity: 0.65; }

  /* ── Save indicator ── */
  .save-indicator {
    display: none; align-items: center; gap: 5px;
    font-size: 10px; color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
    margin-top: 4px;
  }
  .save-indicator.show { display: flex; animation: fadeout 2s forwards; }
  @keyframes fadeout { 0%,70%{opacity:1} 100%{opacity:0} }
</style>
</head>
<body>

<!-- Connection status bar -->
<div class="status-bar" id="status-bar">
  <div class="status-dot dot-disconnected" id="status-dot"></div>
  <div>
    <div class="status-text" id="status-text">Not connected</div>
    <div class="status-sub"  id="status-sub"></div>
  </div>
</div>

<div class="section-title">&#9881; Connection Settings</div>

<div class="form-group">
  <label for="hostname">Hostname</label>
  <input id="hostname" type="text" placeholder="localhost" data-key="hostname"/>
</div>
<div class="form-group">
  <label for="port">Port</label>
  <input id="port" type="number" placeholder="8500" min="1" max="65535" data-key="port" data-type="number"/>
</div>

<hr class="divider"/>

<div class="form-group">
  <label for="username">Username</label>
  <input id="username" type="text" placeholder="admin" data-key="username"/>
</div>
<div class="form-group">
  <label for="password">Password</label>
  <input id="password" type="password" placeholder="(empty)" data-key="password"/>
</div>

<hr class="divider"/>

<div class="form-group">
  <label for="path">Path</label>
  <input id="path" type="text" placeholder="/" data-key="path"/>
</div>
<div class="form-group">
  <label for="url">URL</label>
  <div class="url-row">
    <input id="url" type="text" placeholder="http://localhost:8500" data-key="url"/>
    <button class="icon-btn" id="sync-url" title="Rebuild URL from hostname / port / path">&#8635;</button>
  </div>
</div>

<div class="save-indicator" id="save-indicator">&#10003; Saved</div>

<!-- Connect / Disconnect buttons -->
<div class="btn-row">
  <button class="btn btn-connect"    id="btn-connect"    title="Connect to ColdFusion server">Connect</button>
  <button class="btn btn-disconnect" id="btn-disconnect" title="Disconnect" disabled>Disconnect</button>
</div>

<!-- Server info (shown after successful connection) -->
<div class="server-info" id="server-info">
  <div><span class="info-label">CF Server:&nbsp;</span><span id="info-server-version">—</span></div>
  <div><span class="info-label">Client:&nbsp;&nbsp;&nbsp;&nbsp;</span><span id="info-client-version">—</span></div>
  <div><span class="info-label">Root path:&nbsp;</span><span id="info-root-path">—</span></div>
  <div><span class="info-label">Session ID:&nbsp;</span><span id="info-dbg-session">—</span></div>
</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();

  // ── Helpers ──────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function showSaved() {
    const ind = el('save-indicator');
    ind.classList.remove('show');
    void ind.offsetWidth;
    ind.classList.add('show');
  }

  function persist(key, value) {
    vscode.postMessage({ command: 'saveSetting', key, value });
    showSaved();
  }

  function buildUrl() {
    const host  = el('hostname').value.trim() || 'localhost';
    const port  = el('port').value.trim()     || '8500';
    const path  = el('path').value.trim()     || '/';
    return 'http://' + host + ':' + port + (path.startsWith('/') ? path : '/' + path);
  }

  // ── Apply settings from extension ────────────────────────────────────────
  function applySettings(s) {
    el('hostname').value = s.hostname;
    el('port').value     = String(s.port);
    el('username').value = s.username;
    el('password').value = s.password;
    el('path').value     = s.path;
    el('url').value      = s.url;
  }

  // ── Apply connection state from extension ─────────────────────────────────
  function applyState(state) {
    const dot   = el('status-dot');
    const text  = el('status-text');
    const sub   = el('status-sub');
    const info  = el('server-info');
    const btnC  = el('btn-connect');
    const btnD  = el('btn-disconnect');
    const inputs = document.querySelectorAll('input[data-key]');

    dot.className  = 'status-dot dot-' + state.status;
    info.classList.remove('show');

    switch (state.status) {
      case 'disconnected':
        text.textContent = 'Not connected';
        sub.textContent  = '';
        btnC.disabled = false;
        btnD.disabled = true;
        inputs.forEach(i => i.disabled = false);
        break;

      case 'connecting':
        text.textContent = 'Connecting…';
        sub.textContent  = '';
        btnC.disabled = true;
        btnD.disabled = true;
        inputs.forEach(i => i.disabled = true);
        break;

      case 'connected':
        text.textContent = 'Connected';
        sub.textContent  = el('hostname').value + ':' + el('port').value;
        btnC.disabled = true;
        btnD.disabled = false;
        inputs.forEach(i => i.disabled = true);
        // Show server info block
        el('info-server-version').textContent = state.serverVersion || '—';
        el('info-client-version').textContent = state.clientVersion || '—';
        el('info-root-path').textContent      = state.rootPath      || '—';
        el('info-dbg-session').textContent     = state.dbgSessionId  || '—';
        info.classList.add('show');
        break;

      case 'error':
        text.textContent = 'Connection failed';
        sub.textContent  = state.error || '';
        btnC.disabled = false;
        btnD.disabled = true;
        inputs.forEach(i => i.disabled = false);
        break;
    }
  }

  // ── Message handler ───────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.command === 'settings')   { applySettings(msg.settings); }
    if (msg.command === 'connState')  { applyState(msg.state); }
  });

  // ── Save on change ────────────────────────────────────────────────────────
  document.querySelectorAll('input[data-key]').forEach(function (input) {
    input.addEventListener('change', function () {
      const key   = this.getAttribute('data-key');
      const isNum = this.getAttribute('data-type') === 'number';
      const val   = isNum ? Number(this.value) : this.value;
      persist(key, val);

      if (['hostname', 'port', 'path'].includes(key)) {
        const newUrl = buildUrl();
        el('url').value = newUrl;
        persist('url', newUrl);
      }
    });
  });

  el('sync-url').addEventListener('click', function () {
    const newUrl = buildUrl();
    el('url').value = newUrl;
    persist('url', newUrl);
  });

  el('btn-connect').addEventListener('click', function () {
    const currentSettings = {
      hostname: el('hostname').value.trim() || 'localhost',
      port:     Number(el('port').value.trim()) || 8500,
      username: el('username').value.trim() || 'admin',
      password: el('password').value,
      path:     el('path').value.trim() || '/',
      url:      el('url').value.trim() || buildUrl(),
    };
    vscode.postMessage({ command: 'connect', settings: currentSettings });
  });

  el('btn-disconnect').addEventListener('click', function () {
    vscode.postMessage({ command: 'disconnect' });
  });

  // ── Signal ready to receive initial state ─────────────────────────────────
  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
