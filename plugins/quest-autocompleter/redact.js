/*
 * Response summaries for the console.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A refused request is only useful if it says what the server answered, but the same answer
 * can carry a token or an OAuth code. Everything printed through here drops those values
 * first, so a status line can be pasted into a bug report.
 */

const SECRET_KEY = /token|code|secret|authorization|cookie|password/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;

function scrub(value, depth = 0) {
    if (typeof value === "string") return value.replace(JWT, "<jwt>").slice(0, 120);
    if (Array.isArray(value)) return depth > 2 ? "<…>" : value.slice(0, 3).map(item => scrub(item, depth + 1));
    if (value && typeof value === "object") {
        if (depth > 2) return "<…>";
        const safe = {};
        for (const [key, item] of Object.entries(value)) {
            safe[key] = SECRET_KEY.test(key) ? "<redacted>" : scrub(item, depth + 1);
        }
        return safe;
    }
    return value;
}

/** Anything that may be pasted somewhere else goes through this first. */
export function redact(value) {
    return scrub(value);
}

/** `status 500 {"message":"…"}` — the shape a console line needs to be actionable. */
export function describeResponse(result) {
    const status = Number.isInteger(result?.status) ? `status ${result.status}` : "no response";
    const body = result?.body;
    if (body === undefined || body === null) return status;
    const safe = typeof body === "object" ? scrub(body) : String(body).replace(JWT, "<jwt>").slice(0, 160);
    const text = typeof safe === "string" ? safe : JSON.stringify(safe);
    return text && text !== "{}" ? `${status} ${text}` : status;
}
