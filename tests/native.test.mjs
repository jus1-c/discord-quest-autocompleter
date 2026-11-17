import assert from "node:assert/strict";
import test from "node:test";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

async function loadNative() {
    try {
        return await import("../plugins/quest-autocompleter/native.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Dorion native transport is not implemented");
        throw error;
    }
}

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

async function nextTurn() {
    await new Promise(resolve => setImmediate(resolve));
}

test("claim sends the Discord token only to the Discord quest endpoint without redirects", async () => {
    const { createNative } = await loadNative();
    const requests = [];
    const native = createNative(async (url, options) => {
        requests.push({ url, options });
        return response({ claimed_at: "2026-11-16T00:00:00Z" });
    });
    const result = await native.claimReward({
        userToken: "discord-test-token",
        questId: "123",
        captchaToken: "captcha-test-token",
        trafficMetadataSealed: "sealed"
    });
    assert.equal(result.body.claimed_at, "2026-11-16T00:00:00Z");
    assert.equal(requests[0].url, "https://discord.com/api/v9/quests/123/claim-reward");
    assert.equal(requests[0].options.headers.Authorization, "discord-test-token");
    assert.equal(requests[0].options.headers["X-Captcha-Key"], "captcha-test-token");
    assert.equal(requests[0].options.maxRedirections, 0);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        platform: 0,
        location: 11,
        is_targeted: false,
        metadata_sealed: null,
        traffic_metadata_sealed: "sealed"
    });
});

test("Tauri's guest client forwards the claim and no-redirect policy to IPC", async () => {
    const { createNative } = await loadNative();
    const originalWindow = globalThis.window;
    let config;
    let bodyRead = false;
    globalThis.window = {
        __TAURI_INTERNALS__: {
            async invoke(command, args) {
                if (command === "plugin:http|fetch") {
                    config = args.clientConfig;
                    return 1;
                }
                if (command === "plugin:http|fetch_send") {
                    return { status: 403, statusText: "Forbidden", url: config.url, headers: [], rid: 2 };
                }
                if (command === "plugin:http|fetch_read_body") {
                    if (bodyRead) return new Uint8Array([1]).buffer;
                    bodyRead = true;
                    return new Uint8Array([...new TextEncoder().encode('{"captcha_sitekey":"site-key"}'), 0]).buffer;
                }
                throw new Error(`Unexpected IPC command ${command}`);
            }
        }
    };
    try {
        const result = await createNative(tauriFetch).claimReward({ userToken: "discord-test-token", questId: "123" });
        assert.equal(result.status, 403);
        assert.equal(result.body.captcha_sitekey, "site-key");
        assert.equal(config.url, "https://discord.com/api/v9/quests/123/claim-reward");
        assert.equal(config.maxRedirections, 0);
        assert.equal(new Map(config.headers).get("authorization"), "discord-test-token");
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
});

test("achievement requests reject a mismatched or insecure referrer", async () => {
    const { createNative } = await loadNative();
    let calls = 0;
    const native = createNative(async () => { calls++; return response({}); });
    await assert.rejects(native.discordsaysAuthorize({
        appId: "123",
        questId: "456",
        referrer: "https://evil.example/",
        code: "test"
    }));
    await assert.rejects(native.discordsaysAuthorize({
        appId: "123",
        questId: "456",
        referrer: "http://123.discordsays.com/",
        code: "test"
    }));
    assert.equal(calls, 0);
});

test("an activity authorize request carries the activity's own protocol", async () => {
    const { createNative } = await loadNative();
    const requests = [];
    const native = createNative(async (url, options) => {
        requests.push({ url, options });
        return response({ token: "activity-token" });
    });
    const referrer = "https://123.discordsays.com/?discord_proxy_ticket=ticket-value";
    const result = await native.discordsaysAuthorize({
        appId: "123",
        questId: "456",
        referrer,
        ticket: "ticket-value",
        code: "oauth-code",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0 Safari/537.36",
        headers: { "X-Arise-Client": "astronaut-prod-main-46567f6" }
    });
    assert.deepEqual(result.body, { token: "activity-token" });
    assert.equal(requests.length, 1);
    const [request] = requests;
    const url = new URL(request.url);
    assert.equal(url.host, "123.discordsays.com");
    assert.equal(url.pathname, "/.proxy/acf/authorize");
    assert.equal(url.searchParams.get("discord_proxy_ticket"), "ticket-value");
    const headers = request.options.headers;
    assert.equal(headers.Referer, referrer);
    assert.equal(headers["X-Arise-Client"], "astronaut-prod-main-46567f6");
    assert.match(headers["User-Agent"], /Chrome/);
    assert.equal(headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(request.options.body), {
        activityId: "123",
        code: "oauth-code"
    });
});

test("CapSolver polls the selected solver and returns the solved token", async t => {
    const { createNative } = await loadNative();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const requests = [];
    const native = createNative(async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith("/createTask")) return response({ errorId: 0, taskId: 77 });
        return response({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "solved" } });
    });
    const solving = native.solveCaptcha({
        service: "capsolver",
        apiKey: "solver-test-key",
        websiteUrl: "https://discord.com/",
        siteKey: "site-key"
    });
    await nextTurn();
    t.mock.timers.tick(5000);
    assert.deepEqual(await solving, { token: "solved" });
    assert.deepEqual(requests.map(request => request.url), [
        "https://api.capsolver.com/createTask",
        "https://api.capsolver.com/getTaskResult"
    ]);
    assert.ok(requests.every(request => request.options.maxRedirections === 0));
    assert.deepEqual(JSON.parse(requests[1].options.body), { clientKey: "solver-test-key", taskId: 77 });
});

test("aborting a captcha solve prevents another solver request", async () => {
    const { createNative } = await loadNative();
    const controller = new AbortController();
    const requests = [];
    const native = createNative(async (url, options) => {
        requests.push({ url, options });
        return response({ errorId: 0, taskId: 77 });
    });
    const solving = native.solveCaptcha({
        service: "twocaptcha",
        apiKey: "solver-test-key",
        websiteUrl: "https://discord.com/",
        siteKey: "site-key",
        signal: controller.signal
    });
    await nextTurn();
    controller.abort();
    await assert.rejects(solving);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.2captcha.com/createTask");
});

test("NopeCHA polling sends its key only to NopeCHA", async t => {
    const { createNative } = await loadNative();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const requests = [];
    const native = createNative(async (url, options) => {
        requests.push({ url, options });
        return response(requests.length === 1 ? { data: "task" } : { data: "solved" });
    });
    const solving = native.solveCaptcha({
        service: "nopecha",
        apiKey: "solver-test-key",
        websiteUrl: "https://discord.com/",
        siteKey: "site-key"
    });
    await nextTurn();
    t.mock.timers.tick(5000);
    assert.deepEqual(await solving, { token: "solved" });
    assert.ok(requests.every(request => new URL(request.url).hostname === "api.nopecha.com"));
    assert.equal(requests[1].options.method, "GET");
    assert.equal(requests[1].options.maxRedirections, 0);
});
