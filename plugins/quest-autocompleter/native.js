/*
 * Adapted from the Vencord QuestAutocompleter plugin on 2026-11-16.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const solverHosts = {
    capsolver: "api.capsolver.com",
    twocaptcha: "api.2captcha.com"
};

function checkId(value, name) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Invalid ${name}`);
}

function checkActivity(appId, questId, referrer) {
    checkId(appId, "application ID");
    checkId(questId, "quest ID");
    const url = new URL(referrer);
    if (url.protocol !== "https:" || url.host !== `${appId}.discordsays.com` || url.username || url.password) {
        throw new Error("Invalid activity referrer");
    }
}

function activityUrl(appId, path, ticket) {
    const url = new URL(`https://${appId}.discordsays.com${path}`);
    // The activity proxy reads the session ticket from the iframe URL; a native request has no
    // iframe and no cookies, so the ticket is repeated in the query as well as in the Referer.
    if (ticket) url.searchParams.set("discord_proxy_ticket", ticket);
    return url.toString();
}

function delay(ms, signal) {
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("Cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export function createNative(nativeFetch) {
    /**
     * `as` says how to read the response body: "json" for the Discord API, "text" for the public
     * activity pages and bundles the probe reads. Parsing everything as JSON silently turned a
     * readable HTML page and module script into null, which made every probe look empty.
     */
    async function request(url, { method = "POST", headers = {}, body, as = "json", signal } = {}) {
        if (typeof nativeFetch !== "function") throw new Error("Dorion native HTTP is unavailable");
        const response = await nativeFetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            maxRedirections: 0,
            signal
        });
        if (as === "text") {
            let text = null;
            try { text = await response.text(); } catch { }
            return { ok: response.ok, status: response.status, body: text };
        }
        let parsed = null;
        try { parsed = await response.json(); } catch { }
        return { ok: response.ok, status: response.status, body: parsed };
    }

    async function claimReward({ userToken, questId, captchaToken, trafficMetadataSealed, signal }) {
        checkId(questId, "quest ID");
        if (typeof userToken !== "string" || !userToken) throw new Error("Discord authentication is unavailable");
        const headers = { "Content-Type": "application/json", Authorization: userToken };
        if (captchaToken) headers["X-Captcha-Key"] = captchaToken;
        return request(`https://discord.com/api/v9/quests/${questId}/claim-reward`, {
            headers,
            body: {
                platform: 0,
                location: 11,
                is_targeted: false,
                metadata_sealed: null,
                traffic_metadata_sealed: trafficMetadataSealed ?? null
            },
            signal
        });
    }

    async function discordsaysAuthorize({ appId, questId, referrer, code, ticket, headers, body, userAgent, signal }) {
        checkActivity(appId, questId, referrer);
        if (typeof code !== "string" || !code) throw new Error("Invalid activity authorization code");
        const identity = userAgent ? { "User-Agent": userAgent } : {};
        return request(activityUrl(appId, "/.proxy/acf/authorize", ticket), {
            headers: {
                "Content-Type": "application/json",
                ...identity,
                "X-Auth-Token": "",
                "X-Discord-Quest-ID": questId,
                Referer: referrer,
                ...(headers ?? {})
            },
            // The activity's own client sends both fields; several servers reject a body with
            // only the code.
            body: { activityId: appId, code, ...(body ?? {}) },
            signal
        });
    }

    async function discordsaysProgress({ appId, questId, referrer, ticket, token, progress, headers, body, userAgent, signal }) {
        checkActivity(appId, questId, referrer);
        if (!Number.isFinite(progress) || progress < 0) throw new Error("Invalid activity progress");
        const identity = userAgent ? { "User-Agent": userAgent } : {};
        return request(activityUrl(appId, "/.proxy/acf/quest/progress", ticket), {
            headers: {
                "Content-Type": "application/json",
                ...identity,
                "X-Auth-Token": token,
                "X-Discord-Quest-ID": questId,
                Referer: referrer,
                ...(headers ?? {})
            },
            // The activity's own client sends both fields: it reads the quest id back out of the
            // body, not only out of the header.
            body: { progress: Math.floor(progress), quest_id: questId, ...(body ?? {}) },
            signal
        });
    }

    async function solveCaptcha({ service, apiKey, websiteUrl, siteKey, signal }) {
        if (!apiKey || !siteKey || websiteUrl !== "https://discord.com/") throw new Error("Invalid captcha configuration");
        const headers = { "Content-Type": "application/json" };
        if (service === "nopecha") {
            const created = await request("https://api.nopecha.com/token/", {
                headers,
                body: { key: apiKey, type: "hcaptcha", sitekey: siteKey, url: websiteUrl },
                signal
            });
            if (!created.ok || created.body?.error || !created.body?.data) throw new Error("NopeCHA task creation failed");
            for (let attempt = 0; attempt < 24; attempt++) {
                await delay(5000, signal);
                const url = `https://api.nopecha.com/token/?key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(created.body.data)}`;
                const result = await request(url, { method: "GET", signal });
                if (result.body?.error === 14) continue;
                if (!result.ok || result.body?.error || !result.body?.data) throw new Error("NopeCHA solve failed");
                return { token: result.body.data };
            }
            throw new Error("Captcha solve timed out");
        }

        const host = solverHosts[service];
        if (!host) throw new Error("Unknown captcha service");
        const created = await request(`https://${host}/createTask`, {
            headers,
            body: {
                clientKey: apiKey,
                task: { type: "HCaptchaTaskProxyLess", websiteURL: websiteUrl, websiteKey: siteKey }
            },
            signal
        });
        if (!created.ok || created.body?.errorId !== 0 || !created.body?.taskId) throw new Error("Captcha task creation failed");
        for (let attempt = 0; attempt < 24; attempt++) {
            await delay(5000, signal);
            const result = await request(`https://${host}/getTaskResult`, {
                headers,
                body: { clientKey: apiKey, taskId: created.body.taskId },
                signal
            });
            if (!result.ok || result.body?.errorId !== 0) throw new Error("Captcha solve failed");
            if (result.body.status === "ready") {
                const token = result.body.solution?.gRecaptchaResponse;
                if (!token) throw new Error("Captcha solver returned no token");
                return { token };
            }
        }
        throw new Error("Captcha solve timed out");
    }

    return { claimReward, discordsaysAuthorize, discordsaysProgress, solveCaptcha, request };
}
