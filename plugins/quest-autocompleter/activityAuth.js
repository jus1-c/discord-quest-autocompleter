/*
 * Activity OAuth handshake shared by the built in adapter and recipes.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Authorization is the one step a recipe cannot spell out with plain HTTP: it needs an OAuth
 * code from Discord, a proxy ticket and the activity's own authorize endpoint. Doing it here
 * keeps the account token out of third party hosts and gives both callers one implementation.
 */

import { describeResponse } from "./redact.js";

const AUTHORIZE_ATTEMPTS = 3;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The activity iframe URL the activity itself would be served from. The proxy ticket is part of
 * the query string, so it must be percent-encoded: a base64 ticket can contain "+", which a query
 * string decodes as a space, and the proxy then cannot resolve the activity's environment and
 * answers "Env data not found".
 */
export function activityReferrer(applicationId, ticket) {
    const url = new URL(`https://${applicationId}.discordsays.com/`);
    url.searchParams.set("instance_id", "example-cl-instance");
    url.searchParams.set("platform", "desktop");
    url.searchParams.set("discord_proxy_ticket", ticket);
    return url.toString();
}

export function createActivityAuth({ native, http }) {
    /**
     * Returns `{ token, referrer, ticket, cleanup }`. `token` is null when the session changed
     * under us; `cleanup` must still run so a freshly created grant is revoked.
     *
     * `headers` and `body` are the activity's own protocol details (a recipe supplies them):
     * the endpoints live behind the activity proxy on the application's own host, and the
     * application decides which headers and body fields its authorize call needs.
     *
     * `channelId` scopes the proxy ticket to a channel, which is what Discord's own client does
     * before it opens an activity; the activity proxy resolves the application's environment
     * through it.
     */
    async function grant({ applicationId, questId, channelId, isCurrent, signal, warn, headers, body }) {
        const baselineResponse = await http.get({ url: "/oauth2/tokens" });
        if (!isCurrent()) return { token: null, referrer: null, ticket: null, cleanup: async () => { } };
        if (!Array.isArray(baselineResponse.body)) throw new Error("Cannot determine existing OAuth grants");
        const before = new Set(baselineResponse.body.map(entry => entry.id));
        let authorizationRequested = false;
        let authorized = false;
        let finalized = false;

        async function cleanup() {
            if (finalized) return;
            finalized = true;
            if (isCurrent() && authorized) {
                try {
                    const after = await http.get({ url: "/oauth2/tokens" });
                    if (!isCurrent()) {
                        warn("Achievement interrupted; check Discord Authorized Apps.");
                        return;
                    }
                    if (!Array.isArray(after.body)) throw new Error("Invalid OAuth grants response");
                    const newGrants = after.body.filter(granted =>
                        !before.has(granted.id) && granted.application?.id === applicationId
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
            if (!isCurrent()) return { token: null, referrer: null, ticket: null, cleanup };
            const code = auth.body?.location ? new URL(auth.body.location).searchParams.get("code") : null;
            if (!code) throw new Error("Activity authorization did not return a code");
            const ticketResponse = await http.post({
                url: `/applications/${applicationId}/proxy-tickets`,
                // Copied from Discord's own client (module 730602): a stateless ticket plus the
                // channel it is bound to. Without `channel_id` the activity proxy has no channel
                // to resolve the application's environment through, and answers
                // 500 {"message":"Env data not found"} before the application is even asked.
                body: {
                    use_stateless_ticket: true,
                    ...(channelId ? { channel_id: channelId } : {})
                }
            });
            if (!isCurrent()) return { token: null, referrer: null, ticket: null, cleanup };
            const ticket = ticketResponse.body?.ticket;
            if (!ticket) throw new Error("Activity proxy ticket unavailable");
            const referrer = activityReferrer(applicationId, ticket);
            // The activity's own client runs this call in a three attempt loop, so a first
            // refusal (its server answers 500 on some session states) is not the end of the run.
            let authResult = null;
            for (let attempt = 1; attempt <= AUTHORIZE_ATTEMPTS; attempt++) {
                if (!isCurrent()) return { token: null, referrer, ticket, ticketQuery: null, cleanup };
                authResult = await native.discordsaysAuthorize({
                    appId: applicationId,
                    questId,
                    referrer,
                    ticket,
                    code,
                    signal,
                    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
                    headers,
                    body
                });
                if (authResult?.ok && authResult.body?.token) break;
                if (attempt < AUTHORIZE_ATTEMPTS) {
                    warn(`Activity authorization refused (attempt ${attempt}/${AUTHORIZE_ATTEMPTS}): ${describeResponse(authResult)}`);
                    await delay(1000 * attempt);
                }
            }
            if (!isCurrent()) return { token: null, referrer, ticket, ticketQuery: null, cleanup };
            if (!authResult.ok || !authResult.body?.token) {
                // `step` and `status` travel with the error so the diagnostics can say which call
                // of the handshake was refused instead of a bare "failed".
                const error = new Error(`Activity authorization failed (${describeResponse(authResult)})`);
                error.step = "authorize";
                error.status = authResult?.status ?? null;
                error.serverMessage = authResult?.body?.message ?? null;
                throw error;
            }
            return {
                token: authResult.body.token,
                referrer,
                ticket,
                // The ticket is base64, so a recipe that repeats it in a query string needs it
                // percent-encoded; the Referer keeps the same value the activity itself sends.
                ticketQuery: encodeURIComponent(ticket),
                cleanup
            };
        } catch (error) {
            await cleanup();
            throw error;
        }
    }

    return { grant };
}
