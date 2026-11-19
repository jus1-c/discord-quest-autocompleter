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

test("an adapter is not offered without the native transport it needs", async () => {
    const { createAdapters } = await loadAdapters();
    const adapters = createAdapters({ native: undefined, http: {} });
    assert.equal(adapters.find(quest("ACHIEVEMENT_IN_ACTIVITY")), null);
    assert.deepEqual(adapters.ids, ["acf"]);
});
