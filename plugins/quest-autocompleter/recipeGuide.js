/*
 * Recipe authoring guide.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A quest recipe can only be written by someone who knows how that one application reports
 * progress, and that knowledge lives in the application, not in this plugin. So the diagnostics
 * export carries the recipe schema, the limits, a working example and a prompt that names what is
 * still missing. Handing that export to any agent gives it everything the plugin knows, and tells
 * it exactly which evidence it must ask a human for instead of inventing endpoints.
 */

import { BUILT_IN_RECIPES } from "./builtinRecipes.js";
import { RECIPE_LIMITS, parseRecipes } from "./recipes.js";
import { redact } from "./redact.js";

export const RECIPE_SCHEMA = `{
  "id": "letters, digits, dash or underscore, max 40",
  "match": {
    "applicationId": "one id, or an array of ids; any of them may match",
    "questId": "optional, same shape as applicationId",
    "taskTypes": ["ACHIEVEMENT_IN_ACTIVITY"],
    "eventName": "optional"
  },
  "setup": [
    {
      "kind": "activityAuthorize",
      "headers": { "X-Any-Header": "value" },
      "body": { "any": "field" },
      "save": { "questToken": "token", "proxyTicket": "ticketQuery", "referrer": "referrer" }
    },
    {
      "url": "https://{applicationId}.discordsays.com/.proxy/...",
      "method": "POST",
      "auth": "none",
      "headers": { "X-Auth-Token": "{questToken}" },
      "body": { "any": "field" },
      "save": { "accountToken": "body.authToken" }
    }
  ],
  "report": {
    "url": "https://{applicationId}.discordsays.com/.proxy/...",
    "method": "POST",
    "auth": "none",
    "headers": { "X-Auth-Token": "{questToken}" },
    "body": { "progress": "{value}" },
    "step": 1,
    "intervalSeconds": 20,
    "valueField": "optional.dotted.path.in.the.response",
    "successPath": "status",
    "successEquals": "ok"
  },
  "finish": { "url": "https://{applicationId}.discordsays.com/.proxy/...", "method": "POST", "body": {} }
}`;

export const ALLOWED_HOSTS = [
    "https://discord.com/api/v<n>/...",
    "https://{applicationId}.discordsays.com/..."
];

const MISSING_EVIDENCE = [
    "The application's own endpoints, path names and header names: they live in that application's frontend, not in this plugin.",
    "The body shape the application's progress call expects (a number, an object, a field named something specific).",
    "Any id the application requires besides the quest id, such as a universe id, activity id or hostname.",
    "Whether the application accepts one final progress report or needs incremental reports."
];

/**
 * The prompt is deliberately blunt about the missing evidence: an agent that cannot see the
 * application's own traffic will otherwise invent plausible endpoints, and a recipe built on
 * invented endpoints fails in exactly the way this export is trying to diagnose.
 */
export function buildAuthoringPrompt({ failure: rawFailure, builtInRecipes }) {
    // The export is meant to be pasted into a chat, so it is scrubbed again here rather than
    // trusting every caller to have done it.
    const failure = rawFailure ? redact(rawFailure) : null;
    const quest = failure
        ? {
            id: failure.questId ?? null,
            name: failure.name ?? null,
            applicationIds: failure.applicationIds ?? [],
            taskType: failure.taskType ?? null,
            eventName: failure.eventName ?? null
        }
        : null;

    const prompt = [
        "You are writing a quest recipe for QuestAutocompleter, a Shelter plugin for Dorion that completes Discord quests.",
        "",
        "A recipe is a JSON document, never code. The plugin validates it, fills in the placeholders and sends the requests itself, so a recipe cannot run code and can only reach the hosts listed under allowedHosts.",
        "",
        quest
            ? `The quest that needs a recipe:\n${JSON.stringify(quest, null, 2)}`
            : "No quest has failed yet, so there is nothing concrete to write a recipe for. Ask which quest is failing.",
        "",
        failure
            ? `What the plugin already tried, and how it failed:\n${JSON.stringify(failure, null, 2)}`
            : "",
        "Recipe document schema:",
        RECIPE_SCHEMA,
        "",
        "Hard limits, enforced by the plugin's validator:",
        JSON.stringify(RECIPE_LIMITS, null, 2),
        "",
        "A working recipe, for shape only. It belongs to a different application; do not copy its paths or headers:",
        JSON.stringify(builtInRecipes, null, 2),
        "",
        "What this export cannot tell you:",
        ...MISSING_EVIDENCE.map(line => `- ${line}`),
        "",
        "Do not invent endpoints, headers or ids. Ask the human for one of these instead:",
        "1. A network capture of the activity opened manually in Discord: DevTools, Network tab, enable Preserve log, launch the activity from the quest, then export as HAR. Strip the Authorization, Cookie and X-Super-Properties values before sharing it.",
        "2. The activity's own JavaScript bundle, if it can be read.",
        "3. A screenshot of the activity's network requests.",
        "If you get none of them, reply with the exact requests and fields you still need, and write nothing else.",
        "",
        "Output, once you have the evidence:",
        "1. A JSON array of recipe documents that satisfies the schema and the limits above.",
        "2. One paragraph naming, for each step, the captured request it came from.",
        "3. A list of anything you could not determine."
    ]
        .filter(line => line !== "")
        .join("\n");

    return {
        schema: RECIPE_SCHEMA,
        allowedHosts: ALLOWED_HOSTS,
        limits: RECIPE_LIMITS,
        example: builtInRecipes,
        missingEvidence: MISSING_EVIDENCE,
        prompt
    };
}

/**
 * The shipped recipes as the JSON an author would write. Returned only when the validator accepts
 * them, so the example handed to an agent can never be a document the plugin would reject.
 */
export function builtInRecipeDocuments() {
    const { errors } = parseRecipes(BUILT_IN_RECIPES);
    if (errors.length) return [];
    try {
        return JSON.parse(BUILT_IN_RECIPES);
    } catch {
        return [];
    }
}
