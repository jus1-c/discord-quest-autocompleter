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

function taskOf(quest, type) {
    const tasks = quest?.config?.taskConfig?.tasks ?? quest?.config?.taskConfigV2?.tasks;
    return tasks?.[type];
}

export function createAdapters({ native, http, getRecipeText }) {
    const acf = {
        id: "acf",
        matches(quest) {
            if (typeof native?.discordsaysAuthorize !== "function") return false;
            if (typeof native?.discordsaysProgress !== "function") return false;
            if (typeof http?.post !== "function" || typeof http?.get !== "function") return false;
            return Boolean(taskOf(quest, "ACHIEVEMENT_IN_ACTIVITY"));
        },
        async run({ quest, task, applicationId, isCurrent, signal, log, warn, sleep }) {
            const baselineResponse = await http.get({ url: "/oauth2/tokens" });
            if (!isCurrent()) return;
            if (!Array.isArray(baselineResponse.body)) throw new Error("Cannot determine existing OAuth grants");
            const before = new Set(baselineResponse.body.map(grant => grant.id));
            let authorizationRequested = false;
            let authorized = false;
            try {
                authorizationRequested = true;
                const auth = await http.post({
                    url: "/oauth2/authorize",
                    query: {
                        response_type: "code",
                        client_id: applicationId,
                        scope: "identify applications.commands applications.entitlements"
                    },
                    body: {
                        permissions: "0",
                        authorize: true,
                        integration_type: 1,
                        location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
                    }
                });
                authorized = true;
                if (!isCurrent()) return;
                const code = auth.body?.location ? new URL(auth.body.location).searchParams.get("code") : null;
                if (!code) throw new Error("Activity authorization did not return a code");
                const ticket = await http.post({ url: `/applications/${applicationId}/proxy-tickets`, body: {} });
                if (!isCurrent()) return;
                if (!ticket.body?.ticket) throw new Error("Activity proxy ticket unavailable");
                const referrer = `https://${applicationId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${ticket.body.ticket}`;
                const authResult = await native.discordsaysAuthorize({
                    appId: applicationId, questId: quest.id, referrer, code, signal
                });
                if (!isCurrent()) return;
                if (!authResult.ok || !authResult.body?.token) throw new Error("Activity authorization failed");
                let done = 0;
                while (done < task.target && isCurrent()) {
                    done = Math.min(task.target, done + Math.floor(Math.random() * 20) + 30);
                    const progress = await native.discordsaysProgress({
                        appId: applicationId, questId: quest.id, referrer,
                        token: authResult.body.token, progress: done, signal
                    });
                    if (!isCurrent()) return;
                    if (!progress.ok) throw new Error("Activity progress failed");
                    log(`[${quest.config.messages?.questName}] Progress: ${done}/${task.target}`);
                    if (done < task.target) await sleep(Math.floor(Math.random() * 4000) + 18_000);
                }
            } finally {
                if (isCurrent() && authorized) {
                    try {
                        const after = await http.get({ url: "/oauth2/tokens" });
                        if (!isCurrent()) {
                            warn("Achievement interrupted; check Discord Authorized Apps.");
                            return;
                        }
                        if (!Array.isArray(after.body)) throw new Error("Invalid OAuth grants response");
                        const newGrants = after.body.filter(grant =>
                            !before.has(grant.id) && grant.application?.id === applicationId
                        );
                        if (newGrants.length === 1) {
                            await http.del({ url: `/oauth2/tokens/${newGrants[0].id}` });
                        } else if (newGrants.length > 1) {
                            warn("Multiple new activity authorizations found; check Discord Authorized Apps.");
                        }
                    } catch {
                        warn("Could not remove the activity authorization; check Discord Authorized Apps.");
                    }
                } else if (authorizationRequested) {
                    warn("Achievement interrupted; check Discord Authorized Apps.");
                }
            }
        }
    };

    const adapters = [acf];
    return {
        ids: adapters.map(adapter => adapter.id),
        /** Recipes are the user's explicit instruction, so they win over the built in ones. */
        find(quest, context = {}) {
            const text = typeof getRecipeText === "function" ? getRecipeText() : "";
            for (const recipe of parseRecipes(text).recipes) {
                const adapter = createRecipeAdapter(recipe, { native });
                if (adapter.matchesQuest(quest, context)) return adapter;
            }
            return adapters.find(adapter => adapter.matches(quest)) ?? null;
        }
    };
}
