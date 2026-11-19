/*
 * Activity protocol probe.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * An activity reports quest progress through its own backend, and the plugin cannot watch that
 * backend: the activity runs in a cross-origin iframe, so nothing here sees its live traffic.
 * What is readable is the application's public frontend bundle, which is served from the same
 * host without authentication. It names the universe id the backend resolves an environment
 * from, the /.proxy/acf paths it calls, and the body its progress call sends.
 *
 * Reading it is what turns "this quest needs a hand-written recipe" into a request the plugin can
 * make on its own. Everything here is best effort: a bundle that is missing, obfuscated or built
 * by a different framework yields nulls, and the caller falls back to the generic adapter.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BUNDLE = /<script[^>]+src=["']?([^"'\s>]+\.(?:js|mjs))["']?/i;
const MAX_BUNDLE_CHARS = 8_000_000;

/** The module script a page loads, resolved against the activity host. */
export function findBundleUrl(html, appId) {
    if (typeof html !== "string" || !html) return null;
    const match = BUNDLE.exec(html);
    if (!match) return null;
    try {
        return new URL(match[1], `https://${appId}.discordsays.com/`).toString();
    } catch {
        return null;
    }
}

/** `"X-Universe-ID":"…"` — the id the activity backend resolves its environment from. */
export function findUniverseId(source) {
    if (typeof source !== "string") return null;
    const literal = /["']X-Universe-ID["']\s*:\s*["']([^"']{8,64})["']/.exec(source);
    if (literal && UUID.test(literal[1])) return literal[1];
    // Several builds read it from storage with the id as the fallback.
    const fallback = /ARISE_UNIVERSEID["']?\s*\)\s*\|\|\s*["']([^"']{8,64})["']/.exec(source);
    if (fallback && UUID.test(fallback[1])) return fallback[1];
    return null;
}

/**
 * `"X-Arise-Client": r.appVersion` — the header is a build string the application sends. The
 * literal is only used when the bundle spells one out; an expression cannot be evaluated here.
 */
export function findClientHeader(source) {
    if (typeof source !== "string") return null;
    const literal = /["']X-Arise-Client["']\s*:\s*["']([^"']{2,60})["']/.exec(source);
    if (literal) return literal[1];
    // The value is built from two literals and a template, never spelled out whole:
    //   let n="3cdce096", r="moai-prod-main", a = n ? `${r}-${n}` : r
    // which is the build string the header carries: "moai-prod-main-3cdce096".
    const built = /let\s+(\w+)\s*=\s*["']([0-9a-f]{4,16})["']\s*,\s*(\w+)\s*=\s*["']([a-z][a-z0-9-]{2,40})["']\s*,\s*\w+\s*=\s*\1\s*\?\s*`\$\{\3\}-\$\{\1\}`/.exec(source);
    if (built) return `${built[4]}-${built[2]}`;
    const version = /appVersion\s*[:=]\s*["']([^"']{4,60})["']/.exec(source);
    return version ? version[1] : null;
}

/** The `/.proxy/acf…` paths the bundle calls, without the `/acf` prefix. */
export function findAcfPaths(source) {
    if (typeof source !== "string") return [];
    const paths = [];
    for (const match of source.matchAll(/["'`]\/?\.proxy\/acf(\/[A-Za-z0-9_/-]*)?["'`]/g)) {
        const path = (match[1] ?? "").replace(/\/+$/, "");
        if (path && !paths.includes(path)) paths.push(path);
    }
    for (const match of source.matchAll(/\bh\(\s*["'](?:GET|POST|PUT|DELETE)["']\s*,\s*["']([/][A-Za-z0-9_/-]+)["']/g)) {
        if (!paths.includes(match[1])) paths.push(match[1]);
    }
    return paths;
}

/**
 * The body keys of the progress call, when the bundle spells the object out. A quest id and a
 * progress number are the two things every implementation of this backend has sent so far.
 */
export function findProgressShape(source) {
    if (typeof source !== "string") return null;
    const call = /["']\/quest\/progress["']\s*,\s*\{([^{}]{0,200})\}/.exec(source);
    if (!call) return null;
    const keys = [...new Set([...call[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(match => match[1]))];
    if (!keys.length) return null;
    return {
        keys,
        successField: /status\s*===?\s*["']ok["']/.test(source) ? "status" : null,
        successValue: /status\s*===?\s*["']ok["']/.test(source) ? "ok" : null
    };
}

/** Everything the probe can tell about one application, from its HTML and its bundle. */
export function parseActivity(appId, html, source) {
    return {
        appId,
        bundle: findBundleUrl(html, appId),
        universeId: findUniverseId(source),
        client: findClientHeader(source),
        acfPaths: findAcfPaths(source),
        progress: findProgressShape(source)
    };
}

/** The headers an activity's own client sends with every `/.proxy/acf` call. */
export function headersFromProbe(probe, { appId, hostname } = {}) {
    if (!probe) return {};
    const headers = {};
    if (probe.universeId) headers["X-Universe-ID"] = probe.universeId;
    if (appId) headers["X-Discord-Activity-Id"] = appId;
    if (hostname) headers["X-Discord-Hostname"] = hostname;
    if (probe.client) headers["X-Arise-Client"] = probe.client;
    return headers;
}

/**
 * Fetches the public bundle and reads it. `request` is the native transport, which is the only
 * thing that can reach the activity host from the renderer. Never throws: a probe that fails
 * returns nulls, because the caller's fallback is the generic adapter.
 */
export async function probeActivity({ appId, request, signal, onError }) {
    const fail = reason => {
        if (typeof onError === "function") onError(reason);
        return null;
    };
    if (typeof request !== "function") return fail("no native transport");
    if (!/^\d+$/.test(String(appId ?? ""))) return fail("application id is not numeric");
    const origin = `https://${appId}.discordsays.com/`;
    try {
        // `as: "text"` matters: these are an HTML page and a JavaScript bundle, not JSON, and a
        // JSON parse turns both into null without raising.
        const page = await request(origin, { method: "GET", as: "text", signal });
        if (page?.ok === false) return fail(`page answered ${page.status}`);
        const html = typeof page?.body === "string" ? page.body : "";
        if (!html) return fail("page body was empty");
        const bundleUrl = findBundleUrl(html, appId);
        if (!bundleUrl) return fail("page has no module script");
        const bundle = await request(bundleUrl, { method: "GET", as: "text", signal });
        if (bundle?.ok === false) return fail(`bundle answered ${bundle.status}`);
        const source = typeof bundle?.body === "string" ? bundle.body : "";
        if (!source) return fail("bundle body was empty");
        if (source.length > MAX_BUNDLE_CHARS) return fail("bundle is larger than the cap");
        return parseActivity(appId, html, source);
    } catch (error) {
        return fail(`request failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
}
