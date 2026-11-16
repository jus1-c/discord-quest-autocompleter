import assert from "node:assert/strict";
import test from "node:test";

async function loadQuests() {
    try {
        return await import("../plugins/quest-autocompleter/quests.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Shelter quest normalizer is not implemented");
        throw error;
    }
}

export function apiQuest(id, type = "WATCH_VIDEO", target = 60) {
    return {
        id,
        config: {
            expires_at: "2999-01-01T00:00:00.000Z",
            config_version: 2,
            messages: { quest_name: `Quest ${id}` },
            application: { id: "999", name: "Game" },
            task_config_v2: { tasks: { [type]: { target } } }
        },
        user_status: {
            enrolled_at: "2020-01-01T00:00:00.000Z",
            completed_at: null,
            claimed_at: null,
            stream_progress_seconds: 0,
            traffic_metadata_sealed: "sealed",
            progress: { [type]: { value: 30 } }
        }
    };
}

test("normalizes a snake_case API quest into the engine shape", async () => {
    const { normalizeQuest } = await loadQuests();
    const quest = normalizeQuest(apiQuest("123", "PLAY_ON_DESKTOP", 900));
    assert.equal(quest.id, "123");
    assert.equal(quest.config.expiresAt, "2999-01-01T00:00:00.000Z");
    assert.equal(quest.config.configVersion, 2);
    assert.equal(quest.config.messages.questName, "Quest 123");
    assert.equal(quest.config.application.id, "999");
    assert.equal(quest.config.taskConfig.tasks.PLAY_ON_DESKTOP.target, 900);
    assert.equal(quest.userStatus.enrolledAt, "2020-01-01T00:00:00.000Z");
    assert.equal(quest.userStatus.completedAt, null);
    assert.equal(quest.userStatus.claimedAt, null);
    assert.equal(quest.userStatus.trafficMetadataSealed, "sealed");
    assert.equal(quest.userStatus.progress.PLAY_ON_DESKTOP.value, 30);
});

test("normalizes an unenrolled quest with a null user status", async () => {
    const { normalizeQuest } = await loadQuests();
    const raw = apiQuest("124");
    raw.user_status = null;
    const quest = normalizeQuest(raw);
    assert.equal(quest.userStatus, null);
});

test("accepts an already camelCase quest without losing fields", async () => {
    const { normalizeQuest } = await loadQuests();
    const quest = normalizeQuest({
        id: "125",
        config: {
            expiresAt: "2999-01-01T00:00:00.000Z",
            configVersion: 1,
            messages: { questName: "Quest 125" },
            taskConfig: { tasks: { WATCH_VIDEO: { target: 60 } } }
        },
        userStatus: { enrolledAt: "2020-01-01T00:00:00.000Z", progress: {} }
    });
    assert.equal(quest.config.expiresAt, "2999-01-01T00:00:00.000Z");
    assert.equal(quest.config.messages.questName, "Quest 125");
    assert.equal(quest.config.taskConfig.tasks.WATCH_VIDEO.target, 60);
    assert.equal(quest.userStatus.enrolledAt, "2020-01-01T00:00:00.000Z");
});

test("rejects payloads that cannot be a quest", async () => {
    const { normalizeQuest } = await loadQuests();
    assert.equal(normalizeQuest(null), null);
    assert.equal(normalizeQuest("quest"), null);
    assert.equal(normalizeQuest({}), null);
    assert.equal(normalizeQuest({ id: 123 }), null);
});
