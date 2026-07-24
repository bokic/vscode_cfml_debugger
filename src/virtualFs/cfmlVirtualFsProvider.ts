import * as vscode from 'vscode';
import { ConnectionManager } from '../cfml/connectionManager';
import { Logger } from '../utils/logger';

/**
 * In-memory entry (used for files injected by the debug adapter,
 * not fetched live from the server).
 */
export type VirtualEntry =
    | { type: 'file';      content: Uint8Array; ctime: number; mtime: number }
    | { type: 'directory'; ctime: number; mtime: number };

/**
 * CfmlVirtualFsProvider
 *
 * Implements VS Code's FileSystemProvider for the `cfrds://` scheme.
 *
 * Read strategy (in priority order):
 *  1. In-memory store  — files injected by the debug adapter
 *  2. Live CF server   — via ConnectionManager.readFile() / browseDir()
 *
 * Write strategy:
 *  - Always writes to both the in-memory store AND the CF server
 *    (when connected).
 */
export class CfmlVirtualFsProvider implements vscode.FileSystemProvider {

    // ── Internal state ────────────────────────────────────────────────────

    /** In-memory store for debug-session-injected files. */
    private readonly _store = new Map<string, VirtualEntry>();

    /** Cache of directory listings from the live server. */
    private readonly _dirCache = new Map<string, { items: [string, vscode.FileType][]; ts: number }>();

    private static readonly DIR_CACHE_TTL_MS = 10_000;

    private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
        this._emitter.event;

    constructor(public readonly connectionManager: ConnectionManager) {
        // Invalidate directory cache when connection state changes
        connectionManager.onDidChangeState(() => {
            this._dirCache.clear();
            Logger.debug('[VirtualFs] Directory cache cleared (connection state changed).');
        });
    }

    // ── FileSystemProvider ────────────────────────────────────────────────

    watch(
        _uri: vscode.Uri,
        _options: { recursive: boolean; excludes: string[] }
    ): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        // 1. Check in-memory store
        const mem = this._store.get(uri.path);
        if (mem) {
            return {
                type:  mem.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: mem.ctime,
                mtime: mem.mtime,
                size:  mem.type === 'file' ? mem.content.byteLength : 0,
            };
        }

        // 2. Root is always a directory
        if (uri.path === '/' || uri.path === '') {
            const now = Date.now();
            return { type: vscode.FileType.Directory, ctime: now, mtime: now, size: 0 };
        }

        // 3. Ask the server by browsing the parent directory
        if (this.connectionManager.isConnected) {
            const serverPath = this._toServerPath(uri.path);
            const parentPath = this._parentPath(serverPath);
            const name = serverPath.split('/').pop() ?? '';
            try {
                const entries = await this._readDirFromServer(parentPath);
                const match = entries.find(([n]) => n === name);
                if (match) {
                    const now = Date.now();
                    return { type: match[1], ctime: now, mtime: now, size: 0 };
                }
            } catch { /* fall through */ }
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const results: [string, vscode.FileType][] = [];

        // Merge in-memory children
        const prefix = uri.path.endsWith('/') ? uri.path : uri.path + '/';
        for (const [p, entry] of this._store) {
            if (!p.startsWith(prefix)) { continue; }
            const rel = p.slice(prefix.length);
            if (!rel || rel.includes('/')) { continue; }
            results.push([
                rel,
                entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
            ]);
        }

        // Merge live server entries
        if (this.connectionManager.isConnected) {
            try {
                const serverPath = this._toServerPath(uri.path);
                const serverEntries = await this._readDirFromServer(serverPath);
                for (const se of serverEntries) {
                    if (!results.some(([n]) => n === se[0])) {
                        results.push(se);
                    }
                }
            } catch (e) {
                Logger.warn(`[VirtualFs] readDirectory server error for ${uri.path}: ${e}`);
            }
        }

        return results;
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        // 1. In-memory store
        const mem = this._store.get(uri.path);
        if (mem) {
            if (mem.type !== 'file') {
                throw vscode.FileSystemError.FileIsADirectory(uri);
            }
            return mem.content;
        }

        // 2. Live server
        if (this.connectionManager.isConnected) {
            try {
                const serverPath = this._toServerPath(uri.path);
                Logger.info(`[VirtualFs] readFile from server: ${serverPath}`);
                const data = await this.connectionManager.readFile(serverPath);
                // Cache in in-memory store so VS Code can re-read without hitting the server
                const now = Date.now();
                this._store.set(uri.path, { type: 'file', content: data, ctime: now, mtime: now });
                return data;
            } catch (e) {
                Logger.error(`[VirtualFs] readFile failed for ${uri.path}: ${e}`);
                throw vscode.FileSystemError.FileNotFound(uri);
            }
        }

        throw vscode.FileSystemError.FileNotFound(uri);
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        if (this.connectionManager.isConnected && this.connectionManager.server) {
            const serverPath = this._toServerPath(uri.path);
            try {
                await this.connectionManager.server.dirCreate(serverPath);
                Logger.info(`[VirtualFs] Created directory on ColdFusion server: ${serverPath}`);
            } catch (e) {
                const msg = String(e);
                if (msg.includes("already exists") || msg.includes("File exists")) {
                    Logger.warn(`[VirtualFs] Directory already exists on server: ${serverPath}`);
                } else {
                    Logger.error(`[VirtualFs] Failed to create directory on server ${serverPath}: ${e}`);
                    throw vscode.FileSystemError.Unavailable(`Failed to create directory: ${e}`);
                }
            }
        }
        const now = Date.now();
        this._store.set(uri.path, { type: 'directory', ctime: now, mtime: now });
        this._dirCache.clear();
        this._fireChange(uri, vscode.FileChangeType.Created);
    }

    async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        const existing = this._store.get(uri.path);
        if (existing?.type === 'directory') { throw vscode.FileSystemError.FileIsADirectory(uri); }
        if (!existing && !options.create)   { throw vscode.FileSystemError.FileNotFound(uri); }
        if (existing  && !options.overwrite){ throw vscode.FileSystemError.FileExists(uri); }

        const isNew = !existing;
        const now   = Date.now();
        this._store.set(uri.path, {
            type: 'file', content, ctime: existing?.ctime ?? now, mtime: now,
        });

        if (this.connectionManager.isConnected && this.connectionManager.server) {
            const serverPath = this._toServerPath(uri.path);
            try {
                const strContent = Buffer.from(content).toString('utf-8');
                await this.connectionManager.server.fileWrite(serverPath, strContent);
                Logger.info(`[VirtualFs] Persisted file to ColdFusion server: ${serverPath}`);
            } catch (e) {
                Logger.error(`[VirtualFs] Failed to write file to server ${serverPath}: ${e}`);
                vscode.window.showErrorMessage(`Failed to save file to ColdFusion server (${serverPath}): ${e}`);
                throw vscode.FileSystemError.Unavailable(uri);
            }
        }

        this._dirCache.clear();
        this._fireChange(uri, isNew ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed);
    }

    async delete(uri: vscode.Uri, _options: { recursive: boolean }): Promise<void> {
        if (this.connectionManager.isConnected && this.connectionManager.server) {
            const serverPath = this._toServerPath(uri.path);
            try {
                // Check if directory or file in memory store
                const entry = this._store.get(uri.path);
                if (entry?.type === 'directory') {
                    await this.connectionManager.server.dirRemove(serverPath);
                } else {
                    try {
                        await this.connectionManager.server.fileRemove(serverPath);
                    } catch {
                        // Fallback to dirRemove if fileRemove fails
                        await this.connectionManager.server.dirRemove(serverPath);
                    }
                }
                Logger.info(`[VirtualFs] Deleted server item: ${serverPath}`);
            } catch (e) {
                Logger.error(`[VirtualFs] Delete failed for ${uri.path}: ${e}`);
                throw vscode.FileSystemError.Unavailable(`Delete failed: ${e}`);
            }
        }

        for (const p of this._store.keys()) {
            if (p === uri.path || p.startsWith(uri.path + '/')) {
                this._store.delete(p);
            }
        }
        this._dirCache.clear();
        this._fireChange(uri, vscode.FileChangeType.Deleted);
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        options: { overwrite: boolean }
    ): Promise<void> {
        if (this.connectionManager.isConnected) {
            const oldServerPath = this._toServerPath(oldUri.path);
            const newServerPath = this._toServerPath(newUri.path);
            try {
                const server = this.connectionManager.server;
                if (server) {
                    await server.fileRename(oldServerPath, newServerPath);
                    Logger.info(`[VirtualFs] Renamed server item ${oldServerPath} -> ${newServerPath}`);
                }
            } catch (e) {
                Logger.error(`[VirtualFs] Rename failed for ${oldUri.path}: ${e}`);
                throw vscode.FileSystemError.Unavailable(`Rename failed: ${e}`);
            }
        }

        const entry = this._store.get(oldUri.path);
        if (entry) {
            this._store.delete(oldUri.path);
            this._store.set(newUri.path, entry);
        }
        this._dirCache.clear();
        this._fireChange(oldUri, vscode.FileChangeType.Deleted);
        this._fireChange(newUri, vscode.FileChangeType.Created);
    }

    // ── Public helpers ────────────────────────────────────────────────────

    /**
     * Inject a server-side source file (called by the debug adapter).
     */
    provideFile(uri: vscode.Uri, content: string): void {
        const encoded = Buffer.from(content, 'utf8');
        this.writeFile(uri, encoded, { create: true, overwrite: true });
    }

    entries(): IterableIterator<[string, VirtualEntry]> {
        return this._store.entries();
    }

    clear(): void {
        this._store.clear();
        this._dirCache.clear();
        Logger.info('[VirtualFs] Store cleared.');
    }

    /** Invalidate the cached listing for a single directory. */
    invalidateDir(path: string): void {
        this._dirCache.delete(path);
    }

    // ── Private helpers ───────────────────────────────────────────────────

    private _toServerPath(vfsPath: string): string {
        const root = this.connectionManager.rootPath || '/';
        if (!vfsPath || vfsPath === '/') {
            return root;
        }
        if (/^[a-zA-Z]:[\\/]/.test(vfsPath)) {
            return vfsPath;
        }
        if (root === '/' || vfsPath.startsWith(root)) {
            return vfsPath;
        }
        const cleanRoot = (root.endsWith('/') || root.endsWith('\\')) ? root.slice(0, -1) : root;
        const cleanVfs  = vfsPath.startsWith('/') ? vfsPath : '/' + vfsPath;
        return `${cleanRoot}${cleanVfs}`;
    }

    private async _readDirFromServer(
        path: string
    ): Promise<[string, vscode.FileType][]> {
        const serverPath = this._toServerPath(path);

        // Check cache
        const cached = this._dirCache.get(serverPath);
        if (cached && Date.now() - cached.ts < CfmlVirtualFsProvider.DIR_CACHE_TTL_MS) {
            return cached.items;
        }

        const rawItems = await this.connectionManager.browseDir(serverPath);
        const items: [string, vscode.FileType][] = rawItems.map(item => [
            item.name,
            item.kind === 'D' ? vscode.FileType.Directory : vscode.FileType.File,
        ]);

        this._dirCache.set(serverPath, { items, ts: Date.now() });
        return items;
    }

    private _parentPath(p: string): string {
        const idx = p.lastIndexOf('/');
        return idx <= 0 ? '/' : p.slice(0, idx);
    }

    private _fireChange(uri: vscode.Uri, type: vscode.FileChangeType): void {
        this._emitter.fire([{ type, uri }]);
    }
}
