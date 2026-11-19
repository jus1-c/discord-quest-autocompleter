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
import { headersFromProbe, probeActivity } from "./probe.js";

function taskOf(quest, type) {
    const tasks = quest?.config?.taskConfig?.tasks ?? quest?.config?.taskConfigV2?.tasks;
    return tasks?.[type];
}

export function createAdapters({ native, http, getRecipeTexts, resolveChannelId }) {
    const activityAuth = createActivityAuth({ native, http });

    /** The last probe result, so the diagnostics can say what was read and what was sent. */
    let lastProbe = null;

    /**
     * Every activity handshake is scoped to a channel, because that is what Discord's own client
     * does and what the activity proxy resolves the application's environment through.
     */
    function grant(args) {
        return activityAuth.grant({
            ...args,
            channelId: args?.channelId ?? resolveChannelId?.() ?? null
        });
    }

    const acf = {
        id: "acf",
        matches(quest) {
            if (typeof native?.discordsaysAuthorize !== "function") return false;
            if (typeof native?.discordsaysProgress !== "function") return false;
            if (typeof http?.post !== "function" || typeof http?.get !== "function") return false;
            return Boolean(taskOf(quest, "ACHIEVEMENT_IN_ACTIVITY"));
        },
        async run({ quest, task, applicationId, isCurrent, signal, log, warn, sleep }) {
            // Read the application's own frontend before the handshake. The activity backend
            // resolves an environment from the universe id it is sent, and that id is only
            // published in that bundle, so without it the authorize call is refused with
            // "Env data not found" even though every earlier step succeeded.
            let probeError = null;
            const probe = await probeActivity({
                appId: applicationId,
                request: typeof native?.request === "function" ? native.request : undefined,
                signal,
                onError: reason => { probeError = reason; }
            });
            const hostname = `${applicationId}.discordsays.com`;
            const headers = headersFromProbe(probe, { appId: applicationId, hostname });
            lastProbe = probe ? { ...probe, error: null } : { appId: applicationId, error: probeError };
            if (probe?.universeId) {
                log(`[${quest.config.messages?.questName}] Activity probe: universe ${probe.universeId}`);
            } else {
                warn(`Activity probe could not read the application bundle for ${applicationId} (${probeError ?? "no universe id in the bundle"}); the handshake goes out with the generic headers only.`);
            }

            const authorization = await grant({
                applicationId, questId: quest.id, isCurrent, signal, warn, headers
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
                        headers,
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
        lastProbe: () => lastProbe,
        grantActivity: grant,
        /**
         * Sources are tried in the order the engine lists them: shipped recipes first, then the
         * user's own document, then the adapters compiled into the plugin.
         */
        find(quest, context = {}) {
            for (const { text } of recipeSources()) {
                for (const recipe of parseRecipes(text).recipes) {
                    const adapter = createRecipeAdapter(recipe, { native, grantActivity: grant });
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
