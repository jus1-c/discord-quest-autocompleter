import assert from "node:assert/strict";
import test from "node:test";

async function loadAdapters() {
    try {
        return await import("../plugins/quest-autocompleter/adapters.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Shelter quest adapters are not implemented");
        throw error;
    }
}

function quest(type, extra = {}) {
    return {
        id: "1",
        config: {
            application: { id: "9" },
            taskConfig: { tasks: { [type]: { target: 5, ...extra } } }
        }
    };
}

test("the acf adapter claims only achievement quests", async () => {
    const { createAdapters } = await loadAdapters();
    const adapters = createAdapters({ native: {}, http: {} });
    assert.equal(adapters.find(quest("WATCH_VIDEO")), null);
    assert.equal(adapters.find(quest("PLAY_ON_DESKTOP")), null);
    const withNative = createAdapters({
        native: { discordsaysAuthorize() { }, discordsaysProgress() { } },
        http: { post() { }, get() { } }
    });
    const adapter = withNative.find(quest("ACHIEVEMENT_IN_ACTIVITY"));
    assert.equal(adapter.id, "acf");
});

test("the activity handshake is scoped to a channel even when the caller does not name one", async () => {
    const { createAdapters } = await loadAdapters();
    const requested = [];
    const native = {
        async request(url, options) { requested.push({ url, options }); return { ok: true, status: 200, body: {} }; },
        async discordsaysAuthorize() { return { ok: true, status: 200, body: { token: "t" } }; }
    };
    const http = {
        get: async () => ({ body: [] }),
        post: async ({ url, body }) => {
            requested.push({ url, body });
            if (url === "/oauth2/authorize") {
                return { body: { location: "https://discord.com/oauth2/authorized?code=c" } };
            }
            return { body: { ticket: "t" } };
        },
        del: async () => ({ body: {} })
    };

    const adapters = createAdapters({
        native,
        http,
        resolveChannelId: () => "999"
    });
    await adapters.grantActivity({ applicationId: "123", questId: "456", isCurrent: () => true, warn: () => { } });

    const ticketCall = requested.find(entry => entry.url === "/applications/123/proxy-tickets");
    assert.deepEqual(ticketCall.body, { use_stateless_ticket: true, channel_id: "999" });
});

test("the probe reads the application and the handshake sends what it found", async () => {
    const { createAdapters } = await loadAdapters();
    const html = `<script type=module src=/arise-frontend.ce53621c.js></script>`;
    const bundle = `fetch("/.proxy/acf"+t,{headers:{"X-Universe-ID":"ecd7bb92-1e08-4ad1-b76f-0d33c5013295"}})`;
    const sent = [];
    const native = {
        async request(url) {
            sent.push({ url });
            return url.endsWith(".js") ? { ok: true, status: 200, body: bundle } : { ok: true, status: 200, body: html };
        },
        async discordsaysAuthorize(args) {
            sent.push({ url: "authorize", headers: args.headers });
            return { ok: true, status: 200, body: { token: "t" } };
        },
        async discordsaysProgress() { return { ok: true, status: 200, body: {} }; }
    };
    const http = {
        get: async () => ({ body: [] }),
        post: async ({ url }) => url === "/oauth2/authorize"
            ? { body: { location: "https://discord.com/oauth2/authorized?code=c" } }
            : { body: { ticket: "t" } },
        del: async () => ({ body: {} })
    };

    const adapters = createAdapters({ native, http, resolveChannelId: () => "999" });
    const adapter = adapters.find({
        id: "q",
        config: { application: { id: "1557307363499712582" }, taskConfig: { tasks: { ACHIEVEMENT_IN_ACTIVITY: { target: 1 } } } }
    });
    await adapter.run({
        quest: { id: "q", config: { messages: {} }, userStatus: {} },
        task: { target: 1 },
        applicationId: "1557307363499712582",
        isCurrent: () => true,
        log: () => { },
        warn: () => { },
        sleep: async () => { }
    });

    const authorize = sent.find(entry => entry.url === "authorize");
    // Without this header the activity backend answers 500 {"message":"Env data not found"}.
    assert.equal(authorize.headers["X-Universe-ID"], "ecd7bb92-1e08-4ad1-b76f-0d33c5013295");
    assert.equal(authorize.headers["X-Discord-Hostname"], "1557307363499712582.discordsays.com");
    assert.equal(adapters.lastProbe().universeId, "ecd7bb92-1e08-4ad1-b76f-0d33c5013295");
});

test("an adapter is not offered without the native transport it needs", async () => {
    const { createAdapters } = await loadAdapters();
    const adapters = createAdapters({ native: undefined, http: {} });
    assert.equal(adapters.find(quest("ACHIEVEMENT_IN_ACTIVITY")), null);
    assert.deepEqual(adapters.ids, ["acf"]);
});
