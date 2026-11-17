/*
 * Adapters for quests whose progress the application reports itself.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ACHIEVEMENT_IN_ACTIVITY is not a single API: each activity decides how it reports the
 * achievement. Every protocol lives in its own adapter with a `matches` probe, so supporting
 * a new quest means adding an adapter here instead of editing the engine.
 */

import { createRecipeAdapter, parseRecipes } from "./recipes.js";
import { createActivityAuth } from "./activityAuth.js";

function taskOf(quest, type) {
    const tasks = quest?.config?.taskConfig?.tasks ?? quest?.config?.taskConfigV2?.tasks;
    return tasks?.[type];
}

export function createAdapters({ native, http, getRecipeTexts }) {
    const activityAuth = createActivityAuth({ native, http });

    const acf = {
        id: "acf",
        matches(quest) {
            if (typeof native?.discordsaysAuthorize !== "function") return false;
            if (typeof native?.discordsaysProgress !== "function") return false;
            if (typeof http?.post !== "function" || typeof http?.get !== "function") return false;
            return Boolean(taskOf(quest, "ACHIEVEMENT_IN_ACTIVITY"));
        },
        async run({ quest, task, applicationId, isCurrent, signal, log, warn, sleep }) {
            const authorization = await activityAuth.grant({
                applicationId, questId: quest.id, isCurrent, signal, warn
            });
            try {
                if (!authorization.token) return;
                let done = 0;
                while (done < task.target && isCurrent()) {
                    done = Math.min(task.target, done + Math.floor(Math.random() * 20) + 30);
                    const progress = await native.discordsaysProgress({
                        appId: applicationId, questId: quest.id, referrer: authorization.referrer,
                        ticket: authorization.ticket, token: authorization.token, progress: done,
                        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
                        signal
                    });
                    if (!isCurrent()) return;
                    if (!progress.ok) throw new Error("Activity progress failed");
                    log(`[${quest.config.messages?.questName}] Progress: ${done}/${task.target}`);
                    if (done < task.target) await sleep(Math.floor(Math.random() * 4000) + 18_000);
                }
            } finally {
                await authorization.cleanup();
            }
        }
    };

    const adapters = [acf];

    function recipeSources() {
        const list = typeof getRecipeTexts === "function" ? getRecipeTexts() : [];
        return (Array.isArray(list) ? list : []).filter(entry => entry && String(entry.text ?? "").trim());
    }

    /** One line that says which recipes are in play, so a console log explains a choice. */
    function describe() {
        const sources = recipeSources();
        if (!sources.length) return "recipes: none";
        return sources.map(({ label, text }) => {
            const { recipes, errors } = parseRecipes(text);
            if (errors.length) return `${label}: ${errors.length} problem(s): ${errors[0]}`;
            return `${label}: ${recipes.length ? recipes.map(recipe => recipe.id).join(", ") : "none"}`;
        }).join(" | ");
    }

    return {
        ids: adapters.map(adapter => adapter.id),
        describe,
        grantActivity: activityAuth.grant,
        /**
         * Sources are tried in the order the engine lists them: shipped recipes first, then the
         * user's own document, then the adapters compiled into the plugin.
         */
        find(quest, context = {}) {
            for (const { text } of recipeSources()) {
                for (const recipe of parseRecipes(text).recipes) {
                    const adapter = createRecipeAdapter(recipe, { native, grantActivity: activityAuth.grant });
                    if (!adapter.matchesQuest(quest, context)) continue;
                    // The handshake must address the application the recipe named, which is not
                    // always the first application id on the quest.
                    const applicationId = adapter.applicationIdFor(context);
                    if (applicationId) adapter.applicationId = applicationId;
                    return adapter;
                }
            }
            return adapters.find(adapter => adapter.matches(quest, context)) ?? null;
        }
    };
}
