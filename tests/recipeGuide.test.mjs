import assert from "node:assert/strict";
import test from "node:test";

async function loadGuide() {
    try {
        return await import("../plugins/quest-autocompleter/recipeGuide.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Recipe authoring guide is not implemented");
        throw error;
    }
}

async function loadRecipes() {
    return await import("../plugins/quest-autocompleter/recipes.js");
}

const failure = {
    questId: "1557996162189893723",
    name: "Wild Horse Nine",
    applicationIds: ["1557307363499712582"],
    taskType: "ACHIEVEMENT_IN_ACTIVITY",
    eventName: "progress",
    step: "authorize",
    status: 500,
    serverMessage: "Env data not found",
    message: "Activity authorization failed (status 500 {\"message\":\"Env data not found\"})"
};

test("the prompt names the failing quest and how it failed", async () => {
    const { buildAuthoringPrompt } = await loadGuide();
    const { prompt } = buildAuthoringPrompt({ failure, example: [] });

    assert.match(prompt, /1557996162189893723/);
    assert.match(prompt, /1557307363499712582/);
    assert.match(prompt, /Wild Horse Nine/);
    assert.match(prompt, /ACHIEVEMENT_IN_ACTIVITY/);
    assert.match(prompt, /Env data not found/);
});

test("the prompt carries the schema, the limits and the example", async () => {
    const { buildAuthoringPrompt, recipeExample, RECIPE_SCHEMA } = await loadGuide();
    const example = recipeExample();
    const { prompt, limits, allowedHosts } = buildAuthoringPrompt({ failure, example });

    assert.ok(prompt.includes(RECIPE_SCHEMA), "the schema has to travel with the prompt");
    assert.match(prompt, /"setupSteps"/);
    assert.match(prompt, /"placeholders"/);
    assert.ok(prompt.includes(JSON.stringify(example, null, 2)), "the example has to travel with the prompt");
    assert.ok(Array.isArray(allowedHosts) && allowedHosts.length === 2);
    assert.equal(limits.reportIntervalSeconds.max, 120);
});

test("the limits published to an author are the ones the validator enforces", async () => {
    const { RECIPE_LIMITS } = await loadRecipes();
    const { limits } = await loadGuide().then(guide => guide.buildAuthoringPrompt({ failure, example: [] }));

    assert.deepEqual(limits, RECIPE_LIMITS);
    // A recipe that breaks a published limit must be rejected by the real validator.
    const tooManySteps = {
        id: "too-many-steps",
        match: { taskTypes: ["ACHIEVEMENT_IN_ACTIVITY"] },
        setup: Array.from({ length: RECIPE_LIMITS.setupSteps + 1 }, () => ({
            kind: "activityAuthorize",
            save: { questToken: "token" }
        })),
        report: { url: "https://{applicationId}.discordsays.com/x", body: { progress: "{value}" } }
    };
    const { errors } = (await loadRecipes()).parseRecipes(JSON.stringify([tooManySteps]));
    assert.equal(errors.length, 1);
    assert.match(errors[0], new RegExp(String(RECIPE_LIMITS.setupSteps)));
});

test("the example handed to an author is a document the plugin would accept", async () => {
    const { recipeExample } = await loadGuide();
    const { parseRecipes } = await loadRecipes();
    const example = recipeExample();

    assert.ok(example.length > 0, "an example must be available");
    const { recipes, errors } = parseRecipes(JSON.stringify(example));
    assert.deepEqual(errors, []);
    assert.equal(recipes.length, example.length);
});

test("the prompt tells an agent not to invent endpoints and what to ask for", async () => {
    const { buildAuthoringPrompt } = await loadGuide();
    const { prompt, missingEvidence } = buildAuthoringPrompt({ failure, example: [] });

    assert.match(prompt, /Do not invent endpoints/);
    assert.match(prompt, /HAR/);
    assert.match(prompt, /Authorization, Cookie and X-Super-Properties/);
    assert.match(prompt, /reply with the exact requests and fields you still need/);
    assert.ok(missingEvidence.length >= 3);
});

test("with nothing failed yet the prompt asks which quest is failing instead of guessing", async () => {
    const { buildAuthoringPrompt } = await loadGuide();
    const { prompt } = buildAuthoringPrompt({ failure: null, example: [] });

    assert.match(prompt, /nothing concrete to write a recipe for/);
    assert.doesNotMatch(prompt, /What the plugin already tried/);
});

test("the prompt scrubs a secret even if the caller forgot to", async () => {
    const { buildAuthoringPrompt } = await loadGuide();
    const leaked = {
        ...failure,
        message: "failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        token: "a-real-looking-token"
    };
    const { prompt } = buildAuthoringPrompt({ failure: leaked, example: [] });

    assert.doesNotMatch(prompt, /eyJhbGciOiJIUzI1NiJ9/);
    assert.match(prompt, /<jwt>/);
    assert.doesNotMatch(prompt, /a-real-looking-token/);
    assert.match(prompt, /<redacted>/);
});
