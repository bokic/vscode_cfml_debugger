/**
 * Path normalization utilities for ColdFusion CFML Debugger.
 */

/**
 * Normalizes a server or virtual path string to ensure consistent forward slashes,
 * remove duplicate slashes, and format Windows vs POSIX paths correctly.
 */
export function normalizeServerPath(pathStr: string): string {
    if (!pathStr) return '/';

    // Replace Windows backslashes with forward slashes
    let normalized = pathStr.replace(/\\/g, '/');

    // Retain Windows drive letter prefix (e.g. C:/) or absolute leading slash
    const isWindowsDrive = /^[a-zA-Z]:\//.test(normalized);

    // Collapse multiple consecutive slashes
    normalized = normalized.replace(/\/{2,}/g, '/');

    if (!isWindowsDrive && !normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }

    // Strip trailing slash unless it's the root directory "/" or "C:/"
    if (normalized.length > 1 && normalized.endsWith('/') && !/^[a-zA-Z]:\/$/.test(normalized)) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
}

/**
 * Extract filename from a server or virtual URI path.
 */
export function getBasename(pathStr: string): string {
    const normalized = normalizeServerPath(pathStr);
    const parts = normalized.split('/');
    return parts.pop() || normalized;
}

/**
 * Extract parent directory path from a server or virtual URI path.
 */
export function getParentPath(pathStr: string): string {
    const normalized = normalizeServerPath(pathStr);
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) {
        return normalized.startsWith('/') ? '/' : normalized;
    }
    return normalized.slice(0, idx);
}
