import { wddxDeserialize } from "@bokic/cfrds/dist/parser";

export interface ParsedWddxVariable {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
}

export interface ParsedWddxResult {
    result: string;
    type?: string;
    variables: ParsedWddxVariable[];
    rawValue?: any;
}

/**
 * Determine the CFML type name of a value (e.g. "number", "string", "boolean", "struct", "array").
 */
export function getCfmlType(val: any, rawTypeHint?: string): string {
    if (rawTypeHint) {
        const norm = rawTypeHint.toLowerCase();
        if (["numeric", "double", "integer", "int", "long", "float"].includes(norm)) return "number";
        if (["boolean", "bool"].includes(norm)) return "boolean";
        if (["string", "varchar", "char"].includes(norm)) return "string";
        if (["struct", "hashmap", "map"].includes(norm)) return "struct";
        if (["array", "list", "vector"].includes(norm)) return "array";
        if (["date", "datetime", "timestamp"].includes(norm)) return "date";
        if (["query"].includes(norm)) return "query";
        if (["binary", "bytearray"].includes(norm)) return "binary";
        if (["component", "cfc", "object"].includes(norm)) return "component";
    }
    if (val === null || val === undefined) return "null";
    if (typeof val === "boolean") return "boolean";
    if (typeof val === "number") return "number";
    if (val instanceof Date) return "date";
    if (Buffer.isBuffer(val) || val instanceof Uint8Array) return "binary";
    if (typeof val === "string") {
        if (val.toLowerCase() === "true" || val.toLowerCase() === "false") return "boolean";
        // WDDX / CFML ISO Date string pattern (e.g. 2026-07-24T17:58:38)
        if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}:\d{2}/.test(val.trim())) return "date";
        return "string";
    }
    if (Array.isArray(val)) return "array";
    if (typeof val === "object") {
        if (val.recordcount !== undefined && val.columnlist !== undefined) return "query";
        if (val.COMPONENT_NAME || val.component_name) return "component";
        return "struct";
    }
    return typeof val;
}

/**
 * Format any deserialized JavaScript value clean value string (e.g. `100`, `"hello"`).
 */
export function formatCleanValue(val: any): string {
    if (val === null || val === undefined) {
        return "null";
    }
    if (typeof val === "boolean") {
        return `${val}`;
    }
    if (typeof val === "number") {
        return `${val}`;
    }
    if (val instanceof Date) {
        return `Date(${val.toISOString()})`;
    }
    if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
        return `Binary(${val.byteLength} bytes)`;
    }
    if (typeof val === "string") {
        return `"${val}"`;
    }
    if (Array.isArray(val)) {
        return `Array(${val.length})`;
    }
    if (typeof val === "object") {
        if (val.recordcount !== undefined && val.columnlist !== undefined) {
            return `Query(${val.recordcount} rows)`;
        }
        if (val.COMPONENT_NAME || val.component_name) {
            return `Component(${val.COMPONENT_NAME || val.component_name})`;
        }
        const keys = Object.keys(val);
        return `Struct(${keys.length})`;
    }
    return String(val);
}

/**
 * Format any deserialized JavaScript value into a CFML typed string.
 */
export function formatCfmlValue(val: any): string {
    const type = getCfmlType(val);
    const clean = formatCleanValue(val);
    if (type === "struct") return "struct";
    if (type === "array") return "array";
    return `${type}: ${clean}`;
}

/**
 * Helper to check if a value is a ColdFusion RDS metadata struct wrapper
 * (which contains keys like VARIABLE_VALUE, VARIABLE_TYPE, VARIABLE_NAME).
 */
export function isMetadataStruct(val: any): boolean {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
        return false;
    }
    const keys = Object.keys(val);
    return keys.some(k => {
        const u = k.toUpperCase();
        return u === "VARIABLE_VALUE" || u === "VARIABLE_TYPE" || u === "VARIABLE_NAME";
    });
}

/**
 * Recursively unwraps ColdFusion RDS metadata struct wrappers and 1-element wrapper arrays.
 */
export function unwrapWddxPayload(val: any): { payload: any; rawType?: string } {
    let current = val;

    // Unwrap 1-element array if the single element is a metadata struct
    while (Array.isArray(current) && current.length === 1 && isMetadataStruct(current[0])) {
        current = current[0];
    }

    if (isMetadataStruct(current)) {
        const keys = Object.keys(current);
        const valKey = keys.find(k => k.toUpperCase() === "VARIABLE_VALUE");
        const typeKey = keys.find(k => k.toUpperCase() === "VARIABLE_TYPE");
        const rawType = typeKey ? String(current[typeKey]).toLowerCase() : undefined;
        const isMetadataKey = (k: string) => k.toUpperCase().startsWith("VARIABLE_");

        let rawVal = valKey ? current[valKey] : undefined;

        // Recursively unwrap rawVal if it is wrapped in 1-element array of metadata struct or is a metadata struct
        while (Array.isArray(rawVal) && rawVal.length === 1 && isMetadataStruct(rawVal[0])) {
            rawVal = rawVal[0];
        }

        if (isMetadataStruct(rawVal)) {
            return unwrapWddxPayload(rawVal);
        }

        const payloadKeys = keys.filter(k => !isMetadataKey(k));

        let payloadObj: any;
        if (rawVal !== undefined && rawVal !== null) {
            if (Array.isArray(rawVal)) {
                payloadObj = rawVal.map(item => {
                    const unwrapped = unwrapWddxPayload(item);
                    return unwrapped.payload;
                });
            } else {
                payloadObj = rawVal;
            }
        } else if (payloadKeys.length > 0) {
            payloadObj = {};
            for (const k of payloadKeys) {
                payloadObj[k] = current[k];
            }
        } else if (rawType && ["struct", "hashmap", "map"].includes(rawType)) {
            payloadObj = {};
        } else if (rawType && ["array", "list", "vector"].includes(rawType)) {
            payloadObj = [];
        } else {
            payloadObj = rawVal;
        }

        return { payload: payloadObj, rawType };
    }

    return { payload: current };
}

/**
 * Parses WDDX XML responses returned by ColdFusion RDS GET_SINGLE_CF_VARIABLE recursively.
 */
export function parseWddxResponse(xml: string): ParsedWddxResult {
    if (!xml || !xml.trim()) {
        return { result: "null", variables: [], rawValue: null };
    }

    const deserialized = wddxDeserialize(xml);
    if (deserialized === null || deserialized === undefined) {
        return { result: "null", variables: [], rawValue: null };
    }

    const { payload, rawType } = unwrapWddxPayload(deserialized);
    const cfmlType = getCfmlType(payload, rawType);
    const cleanVal = formatCleanValue(payload);

    let variables: ParsedWddxVariable[] = [];
    if (payload !== null && typeof payload === "object") {
        if (Array.isArray(payload)) {
            variables = payload.map((v, idx) => ({
                name: `[${idx + 1}]`,
                value: formatCleanValue(v),
                type: getCfmlType(v),
                variablesReference: 0,
            }));
        } else {
            variables = Object.entries(payload).map(([k, v]) => ({
                name: k,
                value: formatCleanValue(v),
                type: getCfmlType(v),
                variablesReference: 0,
            }));
        }
    }

    return {
        result: cleanVal,
        type: cfmlType,
        variables,
        rawValue: payload,
    };
}

/**
 * Escape special XML characters in string values interpolated into WDDX packets.
 */
export function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

