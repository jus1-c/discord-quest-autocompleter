import assert from "node:assert/strict";
import test from "node:test";

async function loadAuth() {
    try {
        return await import("../plugins/quest-autocompleter/activityAuth.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Activity authorization is not implemented");
        throw error;
    }
}

test("the referrer keeps a base64 ticket intact instead of decoding its punctuation", async () => {
    const { activityReferrer } = await loadAuth();
    // A real proxy ticket is base64: "+", "/" and "=" are all possible.
    const ticket = "a+b/c+d==";
    const url = new URL(activityReferrer("123", ticket));

    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "123.discordsays.com");
    assert.equal(url.searchParams.get("discord_proxy_ticket"), ticket);
    assert.equal(url.searchParams.get("platform"), "desktop");
    assert.equal(url.searchParams.get("instance_id"), "example-cl-instance");
});

test("a raw ticket in a query string really would be corrupted", async () => {
    // The bug this guards against: an unencoded "+" is read back as a space.
    const ticket = "a+b==";
    const raw = new URL(`https://123.discordsays.com/?discord_proxy_ticket=${ticket}`);
    assert.notEqual(raw.searchParams.get("discord_proxy_ticket"), ticket);
    assert.equal(raw.searchParams.get("discord_proxy_ticket"), "a b==");
});

test("the authorization handshake sends the encoded ticket to the activity", async () => {
    const { createActivityAuth } = await loadAuth();
    const ticket = "a+b/c==";
    const calls = [];
    const http = {
        get: async () => ({ body: [] }),
        post: async ({ url }) => {
            if (url === "/oauth2/authorize") {
                return { body: { location: "https://discord.com/oauth2/authorized?code=the-code" } };
            }
            return { body: { ticket } };
        },
        del: async () => ({ body: {} })
    };
    const native = {
        async discordsaysAuthorize(args) {
            calls.push(args);
            return { ok: true, status: 200, body: { token: "activity-token" } };
        }
    };

    const auth = createActivityAuth({ native, http });
    const result = await auth.grant({ applicationId: "123", questId: "456", isCurrent: () => true, warn: () => { } });

    assert.equal(result.token, "activity-token");
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].referrer).searchParams.get("discord_proxy_ticket"), ticket);
    assert.equal(calls[0].code, "the-code");
});

test("a refused authorization reports the status and the step it failed at", async () => {
    const { createActivityAuth } = await loadAuth();
    const http = {
        get: async () => ({ body: [] }),
        post: async ({ url }) => url === "/oauth2/authorize"
            ? { body: { location: "https://discord.com/oauth2/authorized?code=the-code" } }
            : { body: { ticket: "t" } },
        del: async () => ({ body: {} })
    };
    const native = {
        async discordsaysAuthorize() {
            return { ok: false, status: 500, body: { message: "Env data not found" } };
        }
    };

    const auth = createActivityAuth({ native, http });
    await assert.rejects(
        auth.grant({ applicationId: "123", questId: "456", isCurrent: () => true, warn: () => { } }),
        error => {
            assert.equal(error.step, "authorize");
            assert.equal(error.status, 500);
            assert.match(error.message, /Env data not found/);
            return true;
        }
    );
});
