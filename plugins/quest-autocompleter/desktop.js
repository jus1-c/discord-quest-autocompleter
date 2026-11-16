/*
 * Desktop quest transport for Dorion.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Dorion runs Discord Web inside a Tauri WebView, so Discord's own quest heartbeats are
 * rejected: the heartbeat endpoint answers 401 unless the request user agent advertises an
 * Electron version (docs.discord.food/resources/quests#send-quest-heartbeat). Tauri's native
 * HTTP client lets a single request carry that identity without touching the rest of the
 * session, so the quest stream can run through the native stack while chat stays on web.
 */

const DEFAULTS = {
    clientVersion: "1.0.9175",
    electronVersion: "32.2.7",
    chromeVersion: "128.0.6613.186"
};

function detectPlatform(probe) {
    if (/Windows NT/i.test(probe)) return "Windows";
    if (/Mac OS X|Macintosh/i.test(probe)) return "Mac OS X";
    if (/Linux|X11/i.test(probe)) return "Linux";
    return "Windows";
}

function platformToken(platform) {
    if (platform === "Mac OS X") return "Macintosh; Intel Mac OS X 10_15_7";
    if (platform === "Linux") return "X11; Linux x86_64";
    return "Windows NT 10.0; Win64; x64";
}

function defaultOsVersion(platform) {
    if (platform === "Mac OS X") return "10.15.7";
    if (platform === "Linux") return "6.6.0";
    return "10.0";
}

function matchVersion(source, pattern) {
    return source.match(pattern)?.[1];
}

function readBuildNumber() {
    const value = Number(globalThis.GLOBAL_ENV?.BUILD_NUMBER);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function readReleaseChannel() {
    const channel = globalThis.GLOBAL_ENV?.RELEASE_CHANNEL;
    return typeof channel === "string" && channel ? channel : "stable";
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === "function") return btoa(binary);
    return Buffer.from(bytes).toString("base64");
}

export function buildDesktopUserAgent({
    platform = "Windows",
    clientVersion = DEFAULTS.clientVersion,
    chromeVersion = DEFAULTS.chromeVersion,
    electronVersion = DEFAULTS.electronVersion
} = {}) {
    return `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `discord/${clientVersion} Chrome/${chromeVersion} Electron/${electronVersion} Safari/537.36`;
}

/**
 * Builds a request identity whose user agent and X-Super-Properties agree with each other.
 * The server may compare the two, so both are derived from the same source.
 */
export function createDesktopIdentity({
    userAgent,
    locale,
    clientVersion,
    electronVersion,
    chromeVersion,
    buildNumber,
    osVersion
} = {}) {
    const probe = typeof navigator !== "undefined" ? String(navigator.userAgent ?? "") : "";
    const platform = detectPlatform(probe);
    const agent = typeof userAgent === "string" && userAgent.trim()
        ? userAgent.trim()
        : buildDesktopUserAgent({ platform, clientVersion, chromeVersion, electronVersion });

    const electron = matchVersion(agent, /Electron\/([\d.]+)/);
    if (!electron) throw new Error("The desktop user agent must include an Electron version");

    const resolvedChrome = chromeVersion ?? matchVersion(agent, /Chrome\/([\d.]+)/) ?? DEFAULTS.chromeVersion;
    const resolvedClient = clientVersion ?? matchVersion(agent, /discord\/([\d.]+)/) ?? DEFAULTS.clientVersion;
    const resolvedLocale = locale ?? (typeof navigator !== "undefined" ? navigator.language : undefined) ?? "en-US";

    const properties = {
        os: platform,
        browser: "Discord Client",
        device: "",
        system_locale: resolvedLocale,
        client_version: resolvedClient,
        os_version: osVersion ?? defaultOsVersion(platform),
        os_arch: "x64",
        app_arch: "x64",
        release_channel: readReleaseChannel(),
        client_build_number: Number.isFinite(buildNumber) && buildNumber > 0 ? buildNumber : readBuildNumber(),
        native_build_number: null,
        client_event_source: null,
        browser_user_agent: agent,
        browser_version: resolvedChrome
    };

    return { userAgent: agent, superProperties: toBase64(JSON.stringify(properties)) };
}

function checkQuestId(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid quest ID");
}

/**
 * Posts quest heartbeats through a native HTTP client (Tauri) so they carry a desktop identity.
 * Only used for quests, never for the rest of the Discord session.
 */
export function createDesktopTransport(nativeFetch, { identity } = {}) {
    if (typeof nativeFetch !== "function") throw new Error("Dorion native HTTP is unavailable");
    if (typeof identity !== "function") throw new Error("Desktop identity provider is unavailable");

    async function sendHeartbeat({
        userToken,
        questId,
        streamKey,
        applicationId,
        executablePath,
        executableFingerprint,
        terminal = false,
        signal
    }) {
        checkQuestId(questId);
        if (typeof userToken !== "string" || !userToken) throw new Error("Discord authentication is unavailable");
        const { userAgent, superProperties } = identity();

        const body = { terminal: Boolean(terminal) };
        if (streamKey != null) body.stream_key = String(streamKey);
        if (applicationId != null) body.application_id = String(applicationId);
        if (executablePath != null) body.executable_path = String(executablePath);
        if (executableFingerprint != null) body.executable_fingerprint = String(executableFingerprint);

        const response = await nativeFetch(`https://discord.com/api/v9/quests/${questId}/heartbeat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: userToken,
                "User-Agent": userAgent,
                "X-Super-Properties": superProperties
            },
            body: JSON.stringify(body),
            maxRedirections: 0,
            signal
        });

        let parsed = null;
        try { parsed = await response.json(); } catch { }
        return { ok: response.ok, status: response.status, body: parsed };
    }

    return { sendHeartbeat };
}
