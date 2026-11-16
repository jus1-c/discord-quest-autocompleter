/*
 * Adapted from the Vencord QuestAutocompleter plugin on 2026-11-16.
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function createEngine({ flux, http, settings, native, isDesktop = false }) {
    const { dispatcher } = flux;
    const supportedTasks = [
        "WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP",
        "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE", "ACHIEVEMENT_IN_ACTIVITY"
    ];
    let generation = 0;
    let pollInterval;
    let fetchInterval;
    let unsubscribers = [];
    let pendingTimeouts = new Map();
    let queue = [];
    let activeQuestId = null;
    let activeCleanup = null;
    let processing = false;
    let scanningGeneration = null;
    let claimingGeneration = null;
    let sessionController;
    let needsQuestStoreRefresh = false;
    const claimFailed = new Set();
    const claimed = new Set();
    const achievementFailed = new Set();

    function log(...args) {
        if (settings.logProgress) console.log("[QuestAutocompleter]", ...args);
    }

    function errorStatus(error) {
        const status = error?.status ?? error?.res?.status;
        return Number.isInteger(status) ? ` (status ${status})` : "";
    }

    function stop() {
        generation++;
        sessionController?.abort();
        sessionController = undefined;
        activeCleanup?.();
        activeCleanup = null;
        clearInterval(pollInterval);
        clearInterval(fetchInterval);
        pollInterval = undefined;
        fetchInterval = undefined;
        for (const unsubscribe of unsubscribers) unsubscribe();
        unsubscribers = [];
        for (const [timer, resolve] of pendingTimeouts) {
            clearTimeout(timer);
            resolve();
        }
        pendingTimeouts.clear();
        queue = [];
        activeQuestId = null;
        processing = false;
        scanningGeneration = null;
        claimingGeneration = null;
        needsQuestStoreRefresh = false;
        claimFailed.clear();
        claimed.clear();
        achievementFailed.clear();
    }

    function sleep(ms) {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                pendingTimeouts.delete(timer);
                resolve();
            }, ms);
            pendingTimeouts.set(timer, resolve);
        });
    }

    function getQuestStore() {
        return Object.values(flux.stores).flat()
            .find(store => store?.quests instanceof Map && typeof store.getQuest === "function");
    }

    function findStore(...methods) {
        return Object.values(flux.stores).flat()
            .find(store => methods.every(method => typeof store?.[method] === "function"));
    }

    function taskConfig(quest) {
        return quest.config?.taskConfig ?? quest.config?.taskConfigV2;
    }

    function taskType(quest) {
        const tasks = taskConfig(quest)?.tasks;
        return supportedTasks.find(type => Number.isFinite(tasks?.[type]?.target) && tasks[type].target > 0);
    }

    function isCompletable(quest) {
        if (!(new Date(quest.config?.expiresAt).getTime() > Date.now())) return false;
        return taskType(quest) !== undefined;
    }

    async function processVideo(quest, type, myGeneration) {
        const target = taskConfig(quest).tasks[type].target;
        let secondsDone = quest.userStatus?.progress?.[type]?.value ?? 0;
        const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
        let completed = false;

        while (myGeneration === generation) {
            const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + 10;
            const timestamp = secondsDone + 7;
            if (maxAllowed - secondsDone >= 7) {
                const response = await http.post({
                    url: `/quests/${quest.id}/video-progress`,
                    body: { timestamp: Math.min(target, timestamp + Math.random()) }
                });
                if (myGeneration !== generation) return;
                completed = response.body?.completed_at != null;
                secondsDone = Math.min(target, timestamp);
                if (timestamp >= target) break;
            }
            await sleep(1000);
        }
        if (myGeneration !== generation) return;
        if (!completed) {
            const response = await http.post({
                url: `/quests/${quest.id}/video-progress`,
                body: { timestamp: target }
            });
            completed = response.body?.completed_at != null;
        }
        if (myGeneration === generation) {
            log(completed ? `Completed: ${quest.config.messages?.questName}` : `Completion not confirmed: ${quest.config.messages?.questName}`);
        }
    }

    async function processActivity(quest, myGeneration) {
        const channelStore = findStore("getSortedPrivateChannels");
        const guildStore = findStore("getAllGuilds");
        const channelId = channelStore?.getSortedPrivateChannels()?.[0]?.id ??
            Object.values(guildStore?.getAllGuilds() ?? {})
                .find(guild => guild?.VOCAL?.length)?.VOCAL[0]?.channel?.id;
        if (!channelId) {
            log("No suitable channel found for PLAY_ACTIVITY");
            return;
        }

        const target = taskConfig(quest).tasks.PLAY_ACTIVITY.target;
        const streamKey = `call:${channelId}:1`;
        while (myGeneration === generation) {
            const response = await http.post({
                url: `/quests/${quest.id}/heartbeat`,
                body: { stream_key: streamKey, terminal: false }
            });
            if (myGeneration !== generation) return;
            const progress = response.body?.progress?.PLAY_ACTIVITY?.value;
            if (!Number.isFinite(progress)) throw new Error("Activity heartbeat did not return progress");
            log(`[${quest.config.messages?.questName}] Progress: ${progress}/${target}`);
            if (progress >= target) {
                await http.post({
                    url: `/quests/${quest.id}/heartbeat`,
                    body: { stream_key: streamKey, terminal: true }
                });
                return;
            }
            await sleep(20_000);
        }
    }

    async function processDesktopGame(quest, myGeneration) {
        if (!isDesktop) {
            console.warn(`[QuestAutocompleter] ${quest.config.messages?.questName}: PLAY_ON_DESKTOP requires the Discord desktop runtime.`);
            return;
        }
        const store = findStore("getRunningGames", "getGameForPID");
        if (!store) throw new Error("RunningGameStore is unavailable");
        const applicationId = quest.config.application?.id ?? taskConfig(quest).tasks.PLAY_ON_DESKTOP.applications?.[0]?.id;
        if (!applicationId) throw new Error("Missing application ID");
        const response = await http.get({ url: `/applications/public?application_ids=${applicationId}` });
        if (myGeneration !== generation) return;
        const app = response.body?.[0];
        if (!app) throw new Error("Missing application data");

        const exeName = (app.executables?.find(exe => exe.os === "win32") ?? app.executables?.[0])?.name?.replace(">", "") ?? `${app.name}.exe`;
        const pid = Math.floor(Math.random() * 30_000) + 1000;
        const fakeGame = {
            cmdLine: `C:\\Program Files\\${app.name}\\${exeName}`,
            exeName,
            exePath: `c:/program files/${app.name.toLowerCase()}/${exeName}`,
            hidden: false,
            isLauncher: false,
            id: applicationId,
            name: app.name,
            pid,
            pidPath: [pid],
            processName: app.name,
            start: Date.now()
        };
        const realGames = store.getRunningGames();
        const getRunningGames = store.getRunningGames;
        const getGameForPID = store.getGameForPID;
        const target = taskConfig(quest).tasks.PLAY_ON_DESKTOP.target;

        await new Promise(resolve => {
            let finished = false;
            const cleanup = () => {
                if (finished) return;
                finished = true;
                store.getRunningGames = getRunningGames;
                store.getGameForPID = getGameForPID;
                dispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                dispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: realGames, games: realGames });
                if (activeCleanup === cleanup) activeCleanup = null;
                resolve();
            };
            const onHeartbeat = data => {
                if (data.questId !== quest.id) return;
                const progress = quest.config.configVersion === 1
                    ? data.userStatus?.streamProgressSeconds
                    : data.userStatus?.progress?.PLAY_ON_DESKTOP?.value;
                if (Number.isFinite(progress) && progress >= target) cleanup();
            };
            activeCleanup = cleanup;
            dispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
            store.getRunningGames = () => [fakeGame];
            store.getGameForPID = value => value === pid ? fakeGame : null;
            dispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });
        });
    }

    async function processDesktopStream(quest) {
        if (!isDesktop) {
            console.warn(`[QuestAutocompleter] ${quest.config.messages?.questName}: STREAM_ON_DESKTOP requires the Discord desktop runtime.`);
            return;
        }
        const store = findStore("getStreamerActiveStreamMetadata");
        if (!store) throw new Error("ApplicationStreamingStore is unavailable");
        const task = taskConfig(quest).tasks.STREAM_ON_DESKTOP;
        const applicationId = quest.config.application?.id ?? task.applications?.[0]?.id;
        if (!applicationId) throw new Error("Missing application ID");
        const original = store.getStreamerActiveStreamMetadata;
        const pid = Math.floor(Math.random() * 30_000) + 1000;

        await new Promise(resolve => {
            let finished = false;
            const cleanup = () => {
                if (finished) return;
                finished = true;
                store.getStreamerActiveStreamMetadata = original;
                dispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
                if (activeCleanup === cleanup) activeCleanup = null;
                resolve();
            };
            const onHeartbeat = data => {
                if (data.questId !== quest.id) return;
                const progress = quest.config.configVersion === 1
                    ? data.userStatus?.streamProgressSeconds
                    : data.userStatus?.progress?.STREAM_ON_DESKTOP?.value;
                if (Number.isFinite(progress) && progress >= task.target) cleanup();
            };
            activeCleanup = cleanup;
            dispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
            store.getStreamerActiveStreamMetadata = () => ({ id: applicationId, pid, sourceName: null });
            log(`Spoofed stream: ${quest.config.messages?.questName}; a voice channel with another participant is required`);
        });
    }

    async function claimReward(quest, myGeneration, signal) {
        if (!native) throw new Error("Dorion native HTTP is unavailable");
        const userToken = findStore("getToken")?.getToken();
        if (!userToken) throw new Error("Discord authentication is unavailable");
        const attempt = captchaToken => native.claimReward({
            userToken,
            questId: quest.id,
            captchaToken,
            trafficMetadataSealed: quest.userStatus?.trafficMetadataSealed ?? null,
            signal
        });
        let result = await attempt();
        if (myGeneration !== generation) return false;
        if (!result.ok && result.body?.captcha_sitekey) {
            const solved = await native.solveCaptcha({
                service: settings.captchaService,
                apiKey: settings.captchaApiKey,
                websiteUrl: "https://discord.com/",
                siteKey: result.body.captcha_sitekey,
                signal
            });
            if (myGeneration !== generation) return false;
            result = await attempt(solved.token);
        }
        if (myGeneration !== generation) return false;
        if (!result.body?.claimed_at) throw new Error("Claim was not confirmed by Discord");
        return true;
    }

    async function claimCompletedQuests(myGeneration) {
        if (!settings.autoClaim || !settings.captchaApiKey || claimingGeneration === myGeneration) return;
        const store = getQuestStore();
        if (!store) return;
        const quests = [...store.quests.values()].filter(quest =>
            quest.userStatus?.completedAt && !quest.userStatus?.claimedAt &&
            !claimed.has(quest.id) && !claimFailed.has(quest.id) && taskConfig(quest)?.tasks
        );
        if (!quests.length) return;
        claimingGeneration = myGeneration;
        const signal = sessionController?.signal;
        try {
            for (let i = 0; i < quests.length && myGeneration === generation; i++) {
                const quest = quests[i];
                try {
                    if (await claimReward(quest, myGeneration, signal)) claimed.add(quest.id);
                } catch {
                    if (myGeneration === generation) {
                        claimFailed.add(quest.id);
                        console.warn(`[QuestAutocompleter] Claim failed for "${quest.config.messages?.questName}"; claim it manually.`);
                    }
                }
                if (myGeneration === generation && i < quests.length - 1) {
                    await sleep(Math.floor(Math.random() * 5000) + 8000);
                }
            }
        } finally {
            if (claimingGeneration === myGeneration) claimingGeneration = null;
        }
    }

    async function processAchievement(quest, myGeneration) {
        if (!settings.achievementBypass) {
            log(`Skipped "${quest.config.messages?.questName}": achievement bypass is disabled`);
            return;
        }
        if (!native) throw new Error("Dorion native HTTP is unavailable");
        const task = taskConfig(quest).tasks.ACHIEVEMENT_IN_ACTIVITY;
        const applicationId = quest.config.application?.id ?? task.applications?.[0]?.id;
        if (!applicationId || !Number.isFinite(task.target) || task.target <= 0) throw new Error("Invalid achievement quest");

        const baselineResponse = await http.get({ url: "/oauth2/tokens" });
        if (myGeneration !== generation) return;
        if (!Array.isArray(baselineResponse.body)) throw new Error("Cannot determine existing OAuth grants");
        const before = new Set(baselineResponse.body.map(grant => grant.id));
        const signal = sessionController?.signal;
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
            if (myGeneration !== generation) return;
            const code = auth.body?.location ? new URL(auth.body.location).searchParams.get("code") : null;
            if (!code) throw new Error("Activity authorization did not return a code");
            const ticket = await http.post({ url: `/applications/${applicationId}/proxy-tickets`, body: {} });
            if (myGeneration !== generation) return;
            if (!ticket.body?.ticket) throw new Error("Activity proxy ticket unavailable");
            const referrer = `https://${applicationId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${ticket.body.ticket}`;
            const authResult = await native.discordsaysAuthorize({
                appId: applicationId, questId: quest.id, referrer, code, signal
            });
            if (myGeneration !== generation) return;
            if (!authResult.ok || !authResult.body?.token) throw new Error("Activity authorization failed");
            let done = 0;
            while (done < task.target && myGeneration === generation) {
                done = Math.min(task.target, done + Math.floor(Math.random() * 20) + 30);
                const progress = await native.discordsaysProgress({
                    appId: applicationId, questId: quest.id, referrer,
                    token: authResult.body.token, progress: done, signal
                });
                if (myGeneration !== generation) return;
                if (!progress.ok) throw new Error("Activity progress failed");
                log(`[${quest.config.messages?.questName}] Progress: ${done}/${task.target}`);
                if (done < task.target) await sleep(Math.floor(Math.random() * 4000) + 18_000);
            }
        } finally {
            if (myGeneration === generation && authorized) {
                try {
                    const after = await http.get({ url: "/oauth2/tokens" });
                    if (myGeneration !== generation) {
                        console.warn("[QuestAutocompleter] Achievement interrupted; check Discord Authorized Apps.");
                        return;
                    }
                    if (!Array.isArray(after.body)) throw new Error("Invalid OAuth grants response");
                    const newGrants = after.body.filter(grant =>
                        !before.has(grant.id) && grant.application?.id === applicationId
                    );
                    if (newGrants.length === 1) {
                        await http.del({ url: `/oauth2/tokens/${newGrants[0].id}` });
                    } else if (newGrants.length > 1) {
                        console.warn("[QuestAutocompleter] Multiple new activity authorizations found; check Discord Authorized Apps.");
                    }
                } catch {
                    console.warn("[QuestAutocompleter] Could not remove the activity authorization; check Discord Authorized Apps.");
                }
            } else if (authorizationRequested) {
                console.warn("[QuestAutocompleter] Achievement interrupted; check Discord Authorized Apps.");
            }
        }
    }

    async function processQueue(myGeneration) {
        if (processing || myGeneration !== generation) return;
        processing = true;
        try {
            while (myGeneration === generation && queue.length) {
                const queued = queue.shift();
                const quest = getQuestStore()?.getQuest(queued.id);
                if (!quest || quest.userStatus?.completedAt || !quest.userStatus?.enrolledAt || !isCompletable(quest)) continue;
                activeQuestId = quest.id;
                const type = taskType(quest);
                if (type === "ACHIEVEMENT_IN_ACTIVITY" && achievementFailed.has(quest.id)) {
                    activeQuestId = null;
                    continue;
                }
                try {
                    if (type === "WATCH_VIDEO" || type === "WATCH_VIDEO_ON_MOBILE") {
                        await processVideo(quest, type, myGeneration);
                    } else if (type === "PLAY_ACTIVITY") {
                        await processActivity(quest, myGeneration);
                    } else if (type === "PLAY_ON_DESKTOP") {
                        await processDesktopGame(quest, myGeneration);
                    } else if (type === "STREAM_ON_DESKTOP") {
                        await processDesktopStream(quest);
                    } else if (type === "ACHIEVEMENT_IN_ACTIVITY") {
                        await processAchievement(quest, myGeneration);
                    }
                } catch (error) {
                    if (myGeneration === generation && type === "ACHIEVEMENT_IN_ACTIVITY") {
                        achievementFailed.add(quest.id);
                        console.warn(`[QuestAutocompleter] Achievement failed for "${quest.config.messages?.questName}"; not retrying this session.`);
                    } else if (myGeneration === generation) {
                        log(`Error completing "${quest.config.messages?.questName}"${errorStatus(error)}`);
                    }
                }
                if (myGeneration === generation) activeQuestId = null;
            }
        } finally {
            if (myGeneration === generation) processing = false;
        }
    }

    async function enrollQuest(quest, myGeneration) {
        for (let attempt = 0; attempt < 3 && myGeneration === generation; attempt++) {
            let status;
            let body;
            try {
                const response = await http.post({
                    url: `/quests/${quest.id}/enroll`,
                    body: {
                        location: 11,
                        is_targeted: false,
                        metadata_raw: null,
                        metadata_sealed: null,
                        traffic_metadata_raw: null
                    }
                });
                if (myGeneration !== generation) return false;
                status = response?.status;
                body = response?.body;
                if (status !== 429) {
                    if (status >= 400) throw new Error(`status ${status}`);
                    log(`Auto-accepted: ${quest.config.messages?.questName}`);
                    return true;
                }
            } catch (error) {
                status = error?.status ?? error?.res?.status;
                body = error?.body ?? error?.res?.body;
                if (status !== 429) {
                    if (myGeneration === generation) log(`Failed to accept "${quest.config.messages?.questName}"${errorStatus(error)}`);
                    return false;
                }
            }
            if (attempt < 2 && myGeneration === generation) {
                const retryAfter = Number(body?.retry_after);
                await sleep(((Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 5) + 1) * 1000);
            }
        }
        return false;
    }

    async function scan(myGeneration) {
        if (myGeneration !== generation || scanningGeneration === myGeneration) return;
        scanningGeneration = myGeneration;
        try {
            const store = getQuestStore();
            if (!store) return;
            if (needsQuestStoreRefresh) {
                needsQuestStoreRefresh = false;
                void fetchNewQuests(myGeneration);
                return;
            }
            let enrolledAny = false;
            if (settings.autoAcceptQuests) {
                const available = [...store.quests.values()].filter(quest =>
                    !quest.userStatus?.enrolledAt && !quest.userStatus?.completedAt && isCompletable(quest)
                );
                for (const quest of available) {
                    if (myGeneration !== generation) return;
                    if (await enrollQuest(quest, myGeneration)) enrolledAny = true;
                    if (myGeneration !== generation) return;
                    await sleep(3000);
                }
            }
            if (myGeneration !== generation) return;
            if (enrolledAny) await sleep(1500);
            if (myGeneration !== generation) return;
            for (const quest of store.quests.values()) {
                if (!quest.userStatus?.enrolledAt || quest.userStatus?.completedAt || !isCompletable(quest)) continue;
                if (quest.id !== activeQuestId && !queue.some(queued => queued.id === quest.id)) queue.push(quest);
            }
            void processQueue(myGeneration);
            void claimCompletedQuests(myGeneration);
        } finally {
            if (scanningGeneration === myGeneration) scanningGeneration = null;
        }
    }

    async function fetchNewQuests(myGeneration) {
        try {
            const response = await http.get({ url: "/quests/@me" });
            if (myGeneration !== generation) return;
            if (!Array.isArray(response?.body?.quests)) throw new Error("Invalid quests response");
            needsQuestStoreRefresh = !getQuestStore();
            dispatcher.dispatch({
                type: "QUESTS_FETCH_CURRENT_QUESTS_SUCCESS",
                quests: response.body.quests
            });
            void scan(myGeneration);
        } catch (error) {
            if (myGeneration === generation) log(`Quest fetch failed${errorStatus(error)}`);
        }
    }

    async function start() {
        stop();
        const myGeneration = generation;
        sessionController = new AbortController();
        await http.ready;
        if (myGeneration !== generation) return;

        const onConnectionOpen = () => { void start(); };
        const onQuestStatusUpdate = () => {
            void sleep(500).then(() => scan(myGeneration));
        };
        dispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
        dispatcher.subscribe("QUEST_USER_STATUS_UPDATE", onQuestStatusUpdate);
        unsubscribers.push(() => dispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen));
        unsubscribers.push(() => dispatcher.unsubscribe("QUEST_USER_STATUS_UPDATE", onQuestStatusUpdate));

        const requestedMinutes = Number(settings.fetchIntervalMinutes);
        const minutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0 && requestedMinutes * 60_000 <= 2_147_483_647
            ? Math.max(30, requestedMinutes)
            : 120;
        pollInterval = setInterval(() => scan(myGeneration), 60_000);
        fetchInterval = setInterval(() => { void fetchNewQuests(myGeneration); }, minutes * 60_000);
        await fetchNewQuests(myGeneration);
    }

    return { start, stop };
}
