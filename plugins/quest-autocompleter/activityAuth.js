/*
 * Activity OAuth handshake shared by the built in adapter and recipes.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Authorization is the one step a recipe cannot spell out with plain HTTP: it needs an OAuth
 * code from Discord, a proxy ticket and the activity's own authorize endpoint. Doing it here
 * keeps the account token out of third party hosts and gives both callers one implementation.
 */

export function createActivityAuth({ native, http }) {
    /**
     * Returns `{ token, referrer, cleanup }`. `token` is null when the session changed under
     * us; `cleanup` must still run so a freshly created grant is revoked.
     */
    async function grant({ applicationId, questId, isCurrent, signal, warn }) {
        const baselineResponse = await http.get({ url: "/oauth2/tokens" });
        if (!isCurrent()) return { token: null, referrer: null, cleanup: async () => { } };
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
            if (!isCurrent()) return { token: null, referrer: null, cleanup };
            const code = auth.body?.location ? new URL(auth.body.location).searchParams.get("code") : null;
            if (!code) throw new Error("Activity authorization did not return a code");
            const ticket = await http.post({ url: `/applications/${applicationId}/proxy-tickets`, body: {} });
            if (!isCurrent()) return { token: null, referrer: null, cleanup };
            if (!ticket.body?.ticket) throw new Error("Activity proxy ticket unavailable");
            const referrer = `https://${applicationId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${ticket.body.ticket}`;
            const authResult = await native.discordsaysAuthorize({
                appId: applicationId, questId, referrer, code, signal
            });
            if (!isCurrent()) return { token: null, referrer, cleanup };
            if (!authResult.ok || !authResult.body?.token) throw new Error("Activity authorization failed");
            return { token: authResult.body.token, referrer, cleanup };
        } catch (error) {
            await cleanup();
            throw error;
        }
    }

    return { grant };
}
