import assert from "node:assert/strict";
import test from "node:test";

async function loadDesktop() {
    try {
        return await import("../plugins/quest-autocompleter/desktop.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Shelter desktop quest transport is not implemented");
        throw error;
    }
}

function decodeProperties(base64) {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

function fakeFetch(handler = () => ({ ok: true, status: 200, json: async () => ({}) })) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, init });
        return handler(url, init, calls.length);
    };
    return { calls, fetch };
}

const customAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "discord/1.0.9000 Chrome/120.0.6000.0 Electron/28.2.10 Safari/537.36";

test("the default desktop identity advertises an Electron version", async () => {
    const { createDesktopIdentity } = await loadDesktop();
    const identity = createDesktopIdentity({ locale: "en-US" });
    assert.match(identity.userAgent, /Electron\/\d+\.\d+\.\d+/);
    assert.match(identity.userAgent, /discord\/1\./);
    const properties = decodeProperties(identity.superProperties);
    assert.equal(properties.browser, "Discord Client");
    assert.equal(properties.browser_user_agent, identity.userAgent);
    assert.equal(properties.system_locale, "en-US");
    assert.equal(properties.os, "Windows");
    assert.match(properties.browser_version, /^\d+\./);
});

test("a custom user agent stays consistent with its super properties", async () => {
    const { createDesktopIdentity } = await loadDesktop();
    const identity = createDesktopIdentity({ userAgent: customAgent, locale: "vi" });
    const properties = decodeProperties(identity.superProperties);
    assert.equal(identity.userAgent, customAgent);
    assert.equal(properties.browser_user_agent, customAgent);
    assert.equal(properties.browser_version, "120.0.6000.0");
    assert.equal(properties.client_version, "1.0.9000");
    assert.equal(properties.system_locale, "vi");
});

test("heartbeats are posted to the quest endpoint with desktop headers", async () => {
    const { createDesktopIdentity, createDesktopTransport } = await loadDesktop();
    const { calls, fetch } = fakeFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ progress: { PLAY_ON_DESKTOP: { value: 60 } }, completed_at: null })
    }));
    const transport = createDesktopTransport(fetch, { identity: () => createDesktopIdentity({}) });
    const result = await transport.sendHeartbeat({
        userToken: "discord-test-token",
        questId: "123",
        applicationId: "999",
        executablePath: "C:\\Games\\game.exe",
        terminal: false
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://discord.com/api/v9/quests/123/heartbeat");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.maxRedirections, 0);
    assert.equal(calls[0].init.headers.Authorization, "discord-test-token");
    assert.match(calls[0].init.headers["User-Agent"], /Electron\/\d+\.\d+\.\d+/);
    assert.ok(calls[0].init.headers["X-Super-Properties"]);
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        terminal: false,
        application_id: "999",
        executable_path: "C:\\Games\\game.exe"
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.progress.PLAY_ON_DESKTOP.value, 60);
});

test("stream heartbeats carry the stream key and terminal flag", async () => {
    const { createDesktopIdentity, createDesktopTransport } = await loadDesktop();
    const { calls, fetch } = fakeFetch();
    const transport = createDesktopTransport(fetch, { identity: () => createDesktopIdentity({}) });
    await transport.sendHeartbeat({
        userToken: "discord-test-token",
        questId: "456",
        streamKey: "call:0:4321",
        terminal: true
    });
    assert.deepEqual(JSON.parse(calls[0].init.body), { terminal: true, stream_key: "call:0:4321" });
});

test("an invalid quest id is rejected before any request", async () => {
    const { createDesktopIdentity, createDesktopTransport } = await loadDesktop();
    const { calls, fetch } = fakeFetch();
    const transport = createDesktopTransport(fetch, { identity: () => createDesktopIdentity({}) });
    await assert.rejects(
        transport.sendHeartbeat({ userToken: "token", questId: "../claim-reward" }),
        /quest ID/
    );
    assert.equal(calls.length, 0);
});

test("a missing token is rejected before any request", async () => {
    const { createDesktopIdentity, createDesktopTransport } = await loadDesktop();
    const { calls, fetch } = fakeFetch();
    const transport = createDesktopTransport(fetch, { identity: () => createDesktopIdentity({}) });
    await assert.rejects(transport.sendHeartbeat({ questId: "123" }), /authentication/);
    assert.equal(calls.length, 0);
});

test("a non JSON error body still yields a status", async () => {
    const { createDesktopIdentity, createDesktopTransport } = await loadDesktop();
    const { fetch } = fakeFetch(async () => ({
        ok: false,
        status: 401,
        json: async () => { throw new Error("not json"); }
    }));
    const transport = createDesktopTransport(fetch, { identity: () => createDesktopIdentity({}) });
    const result = await transport.sendHeartbeat({ userToken: "token", questId: "123" });
    assert.deepEqual(result, { ok: false, status: 401, body: null });
});

test("the transport requires a native fetch implementation", async () => {
    const { createDesktopTransport } = await loadDesktop();
    assert.throws(() => createDesktopTransport(undefined, {}), /native HTTP/);
});
