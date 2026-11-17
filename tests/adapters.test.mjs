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

test("an adapter is not offered without the native transport it needs", async () => {
    const { createAdapters } = await loadAdapters();
    const adapters = createAdapters({ native: undefined, http: {} });
    assert.equal(adapters.find(quest("ACHIEVEMENT_IN_ACTIVITY")), null);
    assert.deepEqual(adapters.ids, ["acf"]);
});
