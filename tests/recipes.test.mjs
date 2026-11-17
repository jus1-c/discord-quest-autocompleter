import assert from "node:assert/strict";
import test from "node:test";

async function loadRecipes() {
    try {
        return await import("../plugins/quest-autocompleter/recipes.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Shelter quest recipes are not implemented");
        throw error;
    }
}

const valid = {
    id: "example",
    match: { applicationId: "999", taskTypes: ["ACHIEVEMENT_IN_ACTIVITY"], eventName: "progress" },
    report: {
        url: "https://discord.com/api/v9/quests/{questId}/heartbeat",
        body: { application_id: "{applicationId}", event: "{eventName}", value: "{value}" },
        valueField: "progress.ACHIEVEMENT_IN_ACTIVITY.value",
        step: 2,
        intervalSeconds: 20
    }
};

test("a valid recipe is parsed with its match conditions", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([valid]));
    assert.deepEqual(result.errors, []);
    assert.equal(result.recipes.length, 1);
    assert.equal(result.recipes[0].id, "example");
    assert.equal(result.recipes[0].report.step, 2);
});

test("an empty string means no custom adapters", async () => {
    const { parseRecipes, describeRecipes } = await loadRecipes();
    assert.deepEqual(parseRecipes("").recipes, []);
    assert.equal(describeRecipes(""), "No custom adapters.");
});

test("broken JSON is reported instead of thrown", async () => {
    const { parseRecipes, describeRecipes } = await loadRecipes();
    const result = parseRecipes("{ nope");
    assert.equal(result.recipes.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(describeRecipes("{ nope"), /JSON/i);
});

test("a recipe must state what it matches", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{ ...valid, match: {} }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /match/i);
});

test("foreign hosts are rejected", async () => {
    const { parseRecipes } = await loadRecipes();
    for (const url of [
        "https://evil.example/steal",
        "http://discord.com/api/v9/quests/{questId}/heartbeat",
        "https://discord.com.evil.example/api/v9/quests/{questId}/heartbeat"
    ]) {
        const result = parseRecipes(JSON.stringify([{ ...valid, report: { ...valid.report, url } }]));
        assert.equal(result.recipes.length, 0, url);
        assert.match(result.errors[0], /URL|host/i, url);
    }
});

test("a recipe cannot set its own authorization header", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        ...valid,
        report: { ...valid.report, headers: { Authorization: "stolen" } }
    }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /Authorization/i);
});

test("unknown placeholders are rejected", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        ...valid,
        report: { ...valid.report, body: { value: "{secret}" } }
    }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /placeholder|\{secret\}/i);
});

test("the interval is clamped to a sane range", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        ...valid,
        report: { ...valid.report, intervalSeconds: 100000 }
    }]));
    assert.equal(result.recipes[0].report.intervalSeconds, 120);
});

test("duplicate ids are rejected", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([valid, valid]));
    assert.equal(result.recipes.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /duplicate/i);
});

test("a single object is accepted as a one recipe document", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify(valid));
    assert.deepEqual(result.errors, []);
    assert.equal(result.recipes.length, 1);
});

test("describing a valid document counts the adapters", async () => {
    const { describeRecipes } = await loadRecipes();
    assert.match(describeRecipes(JSON.stringify([valid])), /1 custom adapter/);
});

test("a setup step can capture a value for later requests", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        id: "capture",
        match: { applicationId: "1" },
        setup: [{
            url: "https://{applicationId}.discordsays.com/.proxy/acf/arise/register",
            headers: { "X-Discord-Activity-Id": "{applicationId}" },
            save: { authToken: "body.authToken" }
        }],
        report: {
            url: "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress",
            headers: { "X-Auth-Token": "{authToken}" },
            body: { progress: "{value}" },
            successPath: "status",
            successEquals: "ok"
        }
    }]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.recipes[0].captures, ["authToken"]);
    assert.equal(result.recipes[0].report.successPath, "status");
    assert.equal(result.recipes[0].report.successEquals, "ok");
});

test("a placeholder that nothing captures is still rejected", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        ...valid,
        report: { ...valid.report, body: { value: "{authToken}" } }
    }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /Unknown placeholder/);
});

test("setup steps are capped", async () => {
    const { parseRecipes } = await loadRecipes();
    const step = { url: "https://discord.com/api/v9/x", save: { a: "b" } };
    const result = parseRecipes(JSON.stringify([{ ...valid, setup: [step, step, step, step, step, step] }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /at most/);
});

test("a setup step can ask the plugin for the activity authorization", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        id: "arise",
        match: { applicationId: "1557799582732124221" },
        setup: [{ kind: "activityAuthorize", save: { token: "token" } }],
        report: {
            url: "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress",
            auth: "none",
            headers: { "X-Auth-Token": "{token}" },
            body: { progress: "{value}", quest_id: "{questId}" }
        }
    }]));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.recipes[0].captures, ["token"]);
    assert.equal(result.recipes[0].setup[0].kind, "activityAuthorize");
});

test("a recipe can match an application id the task carries", async () => {
    const { createRecipeAdapter } = await loadRecipes();
    const adapter = createRecipeAdapter({
        id: "a",
        match: { applicationId: ["1557799582732124221"], questId: [], taskType: ["ACHIEVEMENT_IN_ACTIVITY"], eventName: [] },
        captures: [],
        setup: [],
        report: { url: "https://discord.com/api/v9/x", method: "POST", headers: {}, body: undefined, auth: "discord", step: 1, valueField: null, successPath: null, successEquals: "ok", intervalSeconds: 20 },
        finish: null
    }, {});
    const quest = { id: "1", config: { application: { id: "777" } } };
    const context = { applicationId: "777", applicationIds: ["777", "1557799582732124221"], taskType: "ACHIEVEMENT_IN_ACTIVITY" };
    assert.equal(adapter.matchesQuest(quest, context), true);
    assert.equal(adapter.applicationIdFor(context), "1557799582732124221");
    assert.equal(adapter.matchesQuest(quest, { ...context, applicationIds: ["777"] }), false);
});

test("an activityAuthorize step can carry the activity's own headers and body", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        id: "arise",
        match: { applicationId: "1557799582732124221" },
        setup: [{
            kind: "activityAuthorize",
            headers: { "X-Arise-Client": "client", "X-Discord-Hostname": "{applicationId}.discordsays.com" },
            body: { activityId: "{applicationId}" },
            save: { token: "token", ticket: "ticket" }
        }],
        report: {
            url: "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress?discord_proxy_ticket={ticket}",
            auth: "none",
            headers: { "X-Auth-Token": "{token}" },
            body: { progress: "{value}" }
        }
    }]));
    assert.deepEqual(result.errors, []);
    const step = result.recipes[0].setup[0];
    assert.deepEqual(step.headers, { "X-Arise-Client": "client", "X-Discord-Hostname": "{applicationId}.discordsays.com" });
    assert.deepEqual(step.body, { activityId: "{applicationId}" });
    assert.deepEqual(result.recipes[0].captures, ["token", "ticket"]);
    // A ticket captured by the authorize step is usable by the requests after it.
    assert.match(result.recipes[0].report.url, /\{ticket\}/);
});

test("an activityAuthorize step still cannot set the account's own headers", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        ...valid,
        setup: [{ kind: "activityAuthorize", headers: { Authorization: "stolen" }, save: { token: "token" } }]
    }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /cannot set Authorization/);
});

test("an unknown setup kind is rejected", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{
        ...valid,
        setup: [{ kind: "runArbitraryCode", save: { a: "b" } }]
    }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /kind/);
});

test("a kind step without a save is rejected", async () => {
    const { parseRecipes } = await loadRecipes();
    const result = parseRecipes(JSON.stringify([{ ...valid, setup: [{ kind: "activityAuthorize" }] }]));
    assert.equal(result.recipes.length, 0);
    assert.match(result.errors[0], /save/);
});
