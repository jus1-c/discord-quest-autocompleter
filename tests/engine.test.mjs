import assert from "node:assert/strict";
import test from "node:test";

async function loadEngine() {
    try {
        return await import("../plugins/quest-autocompleter/engine.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Shelter quest engine is not implemented");
        throw error;
    }
}

function runtime(get, ready = Promise.resolve()) {
    const events = [];
    const subscriptions = new Map();
    const questStore = { quests: new Map(), getQuest(id) { return this.quests.get(id); } };
    const stores = { m: [{}, questStore] };
    const dispatcher = {
        dispatch(event) {
            events.push(event);
            if (event.type === "QUESTS_FETCH_CURRENT_QUESTS_SUCCESS" && Object.values(stores).flat().includes(questStore)) {
                questStore.quests = new Map(event.quests.map(quest => [quest.id, quest]));
            }
            for (const listener of subscriptions.get(event.type) ?? []) listener(event);
        },
        subscribe(type, listener) {
            if (!subscriptions.has(type)) subscriptions.set(type, new Set());
            subscriptions.get(type).add(listener);
        },
        unsubscribe(type, listener) {
            subscriptions.get(type)?.delete(listener);
        }
    };
    return {
        events,
        subscriptions,
        questStore,
        options: {
            flux: { stores, dispatcher },
            http: { ready, get },
            settings: { autoAcceptQuests: false, logProgress: false, fetchIntervalMinutes: 120 }
        }
    };
}

function videoQuest(id, enrolledAt = "2020-01-01T00:00:00.000Z") {
    return {
        id,
        config: {
            expiresAt: "2999-01-01T00:00:00.000Z",
            messages: { questName: `Quest ${id}` },
            taskConfig: { tasks: { WATCH_VIDEO: { target: 1 } } }
        },
        userStatus: { enrolledAt, progress: {} }
    };
}

function taskQuest(id, type, target = 1) {
    const quest = videoQuest(id);
    quest.config.taskConfig.tasks = { [type]: { target } };
    quest.config.application = { id: "999", name: "Game" };
    return quest;
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

async function nextTurn() {
    await new Promise(resolve => setImmediate(resolve));
}

test("fetches quests and updates the minified quest store through Flux", async () => {
    const { createEngine } = await loadEngine();
    const quests = [{ id: "123", userStatus: null }];
    const requests = [];
    const env = runtime(async request => {
        requests.push(request);
        return { body: { quests } };
    });
    const engine = createEngine(env.options);
    try {
        await engine.start();
        assert.deepEqual(requests, [{ url: "/quests/@me" }]);
        assert.deepEqual(env.events, [{ type: "QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", quests }]);
        assert.equal(env.questStore.getQuest("123"), quests[0]);
    } finally {
        engine.stop();
    }
});

test("stopping before HTTP initialization prevents requests and subscriptions", async () => {
    const { createEngine } = await loadEngine();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    let requests = 0;
    const env = runtime(async () => { requests++; return { body: { quests: [] } }; }, ready);
    const engine = createEngine(env.options);
    const starting = engine.start();
    engine.stop();
    resolveReady();
    await starting;
    assert.equal(requests, 0);
    assert.ok([...env.subscriptions.values()].every(listeners => listeners.size === 0));
});

test("an invalid saved fetch interval falls back to two hours", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [] } }));
    env.options.settings.fetchIntervalMinutes = Infinity;
    const originalSetInterval = globalThis.setInterval;
    const intervals = [];
    globalThis.setInterval = (callback, delay, ...args) => {
        intervals.push(delay);
        return originalSetInterval(callback, Number.isFinite(delay) ? delay : 60_000, ...args);
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        assert.deepEqual(intervals, [60_000, 7_200_000]);
    } finally {
        engine.stop();
        globalThis.setInterval = originalSetInterval;
    }
});

test("refreshes quests when the initially unavailable quest store appears", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let requests = 0;
    const env = runtime(async () => {
        requests++;
        return { body: { quests: [{ id: "123", userStatus: null }] } };
    });
    delete env.options.flux.stores.m;
    const engine = createEngine(env.options);
    try {
        await engine.start();
        assert.equal(requests, 1);
        assert.equal(env.questStore.quests.size, 0);
        env.options.flux.stores.m = [{}, env.questStore];
        env.options.flux.dispatcher.dispatch({ type: "QUEST_USER_STATUS_UPDATE" });
        t.mock.timers.tick(500);
        await nextTurn();
        assert.equal(requests, 2);
        assert.equal(env.questStore.getQuest("123").id, "123");
    } finally {
        engine.stop();
    }
});

test("processes eligible video quests once and in queue order", async () => {
    const { createEngine } = await loadEngine();
    const quests = [videoQuest("101"), videoQuest("102")];
    const expired = videoQuest("103");
    expired.config.expiresAt = "2000-01-01T00:00:00.000Z";
    const env = runtime(async () => ({ body: { quests: [...quests, expired] } }));
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), [
            "/quests/101/video-progress",
            "/quests/102/video-progress"
        ]);
        assert.ok(posts.every(request => request.body.timestamp === 1));
    } finally {
        engine.stop();
    }
});

test("processes activity quests through a channel and sends the final heartbeat", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("301", "PLAY_ACTIVITY", 20);
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.flux.stores.ChannelStore = { getSortedPrivateChannels: () => [{ id: "1234" }] };
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { progress: { PLAY_ACTIVITY: { value: 20 } } } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts, [
            { url: "/quests/301/heartbeat", body: { stream_key: "call:1234:1", terminal: false } },
            { url: "/quests/301/heartbeat", body: { stream_key: "call:1234:1", terminal: true } }
        ]);
    } finally {
        engine.stop();
    }
});

test("does not send video progress ahead of the enrollment time", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("103", new Date(Date.now() + 60_000).toISOString());
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    const posts = [];
    env.options.http.post = async request => { posts.push(request); return { body: {} }; };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts, []);
    } finally {
        engine.stop();
    }
});

test("skips a quest with an invalid target and processes the next quest", async () => {
    const { createEngine } = await loadEngine();
    const invalid = videoQuest("104");
    invalid.config.taskConfig.tasks.WATCH_VIDEO.target = 0;
    const env = runtime(async () => ({ body: { quests: [invalid, videoQuest("105")] } }));
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/105/video-progress"]);
    } finally {
        engine.stop();
    }
});

test("network errors do not print request credentials", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [videoQuest("105")] } }));
    env.options.settings.logProgress = true;
    env.options.http.post = async () => {
        throw { status: 403, request: { headers: { Authorization: "discord-test-token" } } };
    };
    const engine = createEngine(env.options);
    const originalLog = console.log;
    const output = [];
    console.log = (...args) => output.push(JSON.stringify(args));
    try {
        await engine.start();
        await nextTurn();
        assert.ok(output.length > 0);
        assert.doesNotMatch(output.join("\n"), /discord-test-token/);
    } finally {
        engine.stop();
        console.log = originalLog;
    }
});

test("cleans up a desktop game patch and its heartbeat listener when stopped", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("401", "PLAY_ON_DESKTOP", 900);
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        return { body: [{ name: "Game", executables: [{ os: "win32", name: "game.exe" }] }] };
    });
    const gameStore = {
        getRunningGames() { return []; },
        getGameForPID() { return null; }
    };
    const originalGetGames = gameStore.getRunningGames;
    const originalGetGame = gameStore.getGameForPID;
    env.options.flux.stores.RunningGameStore = gameStore;
    env.options.isDesktop = true;
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(gameStore.getRunningGames()[0].id, "999");
        assert.equal(env.subscriptions.get("QUESTS_SEND_HEARTBEAT_SUCCESS").size, 1);
        engine.stop();
        assert.equal(gameStore.getRunningGames, originalGetGames);
        assert.equal(gameStore.getGameForPID, originalGetGame);
        assert.equal(env.subscriptions.get("QUESTS_SEND_HEARTBEAT_SUCCESS").size, 0);
    } finally {
        engine.stop();
    }
});

test("a stream patch ends only on the matching quest heartbeat", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("402", "STREAM_ON_DESKTOP", 900);
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    const streamingStore = { getStreamerActiveStreamMetadata() { return null; } };
    const original = streamingStore.getStreamerActiveStreamMetadata;
    env.options.flux.stores.ApplicationStreamingStore = streamingStore;
    env.options.isDesktop = true;
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(streamingStore.getStreamerActiveStreamMetadata().id, "999");
        const heartbeat = id => ({
            type: "QUESTS_SEND_HEARTBEAT_SUCCESS",
            questId: id,
            userStatus: { progress: { STREAM_ON_DESKTOP: { value: 900 } } }
        });
        env.options.flux.dispatcher.dispatch(heartbeat("other"));
        assert.equal(env.subscriptions.get("QUESTS_SEND_HEARTBEAT_SUCCESS").size, 1);
        env.options.flux.dispatcher.dispatch(heartbeat("402"));
        await nextTurn();
        assert.equal(streamingStore.getStreamerActiveStreamMetadata, original);
        assert.equal(env.subscriptions.get("QUESTS_SEND_HEARTBEAT_SUCCESS").size, 0);
    } finally {
        engine.stop();
    }
});

test("unsupported desktop quests do not block video quests on the web runtime", async () => {
    const { createEngine } = await loadEngine();
    const quests = [taskQuest("401", "PLAY_ON_DESKTOP"), videoQuest("102")];
    const env = runtime(async () => ({ body: { quests } }));
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/102/video-progress"]);
        assert.match(warnings.join(" "), /PLAY_ON_DESKTOP/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("stopping during a quest prevents starting the next queued quest", async () => {
    const { createEngine } = await loadEngine();
    const waiting = deferred();
    const quests = [videoQuest("101"), videoQuest("102")];
    const env = runtime(async () => ({ body: { quests } }));
    const posts = [];
    env.options.http.post = request => {
        posts.push(request);
        return waiting.promise;
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(posts.length, 1);
        engine.stop();
        waiting.resolve({ body: { completed_at: "2026-11-16T00:00:00.000Z" } });
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/101/video-progress"]);
        assert.ok([...env.subscriptions.values()].every(listeners => listeners.size === 0));
    } finally {
        engine.stop();
    }
});

test("does not process a queued quest removed from the current store", async () => {
    const { createEngine } = await loadEngine();
    const firstResponse = deferred();
    const quests = [videoQuest("101"), videoQuest("102")];
    const env = runtime(async () => ({ body: { quests } }));
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return posts.length === 1 ? firstResponse.promise : { body: { completed_at: "2026-11-16T00:00:00Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(posts.length, 1);
        env.questStore.quests.delete("102");
        firstResponse.resolve({ body: { completed_at: "2026-11-16T00:00:00Z" } });
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/101/video-progress"]);
    } finally {
        engine.stop();
    }
});

test("auto-accepts eligible unaccepted quests without enrolling expired quests", async () => {
    const { createEngine } = await loadEngine();
    const eligible = videoQuest("201");
    const expired = videoQuest("202");
    eligible.userStatus = null;
    expired.userStatus = null;
    expired.config.expiresAt = "2000-01-01T00:00:00.000Z";
    const env = runtime(async () => ({ body: { quests: [eligible, expired] } }));
    env.options.settings.autoAcceptQuests = true;
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { status: 200, body: {} };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts, [{
            url: "/quests/201/enroll",
            body: {
                location: 11,
                is_targeted: false,
                metadata_raw: null,
                metadata_sealed: null,
                traffic_metadata_raw: null
            }
        }]);
    } finally {
        engine.stop();
    }
});

test("stopping cancels a rate-limit retry before a second enrollment", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("201");
    quest.userStatus = null;
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.settings.autoAcceptQuests = true;
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { status: 429, body: { retry_after: 5 } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(posts.length, 1);
        engine.stop();
        await nextTurn();
        assert.equal(posts.length, 1);
    } finally {
        engine.stop();
    }
});

test("stopping after enrollment does not schedule further work", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("201");
    quest.userStatus = null;
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.settings.autoAcceptQuests = true;
    env.options.http.post = async () => ({ status: 200, body: {} });
    const engine = createEngine(env.options);
    const originalSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
        delays.push(delay);
        return originalSetTimeout(callback, delay, ...args);
    };
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(delays, [3000]);
        engine.stop();
        await nextTurn();
        assert.deepEqual(delays, [3000]);
    } finally {
        engine.stop();
        globalThis.setTimeout = originalSetTimeout;
    }
});

test("a response from the previous account does not overwrite new-session quests", async () => {
    const { createEngine } = await loadEngine();
    const oldResponse = deferred();
    let count = 0;
    const env = runtime(async () => {
        count++;
        return count === 1 ? oldResponse.promise : { body: { quests: [{ id: "new" }] } };
    });
    const engine = createEngine(env.options);
    try {
        const firstStart = engine.start();
        await nextTurn();
        env.options.flux.dispatcher.dispatch({ type: "CONNECTION_OPEN" });
        await nextTurn();
        oldResponse.resolve({ body: { quests: [{ id: "old" }] } });
        await firstStart;
        assert.deepEqual([...env.questStore.quests.keys()], ["new"]);
    } finally {
        engine.stop();
    }
});

test("claims a completed quest after solving the returned captcha challenge", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("501");
    quest.userStatus.completedAt = "2026-11-16T00:00:00Z";
    quest.userStatus.trafficMetadataSealed = "sealed";
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.settings.autoClaim = true;
    env.options.settings.captchaApiKey = "solver-key";
    env.options.settings.captchaService = "capsolver";
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const claims = [];
    const solves = [];
    env.options.native = {
        async claimReward(args) {
            claims.push(args);
            return claims.length === 1
                ? { ok: false, status: 400, body: { captcha_sitekey: "site-key" } }
                : { ok: true, status: 200, body: { claimed_at: "2026-11-16T00:00:00Z" } };
        },
        async solveCaptcha(args) {
            solves.push(args);
            return { token: "captcha-token" };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(claims.length, 2);
        assert.equal(claims[0].userToken, "discord-test-token");
        assert.equal(claims[0].trafficMetadataSealed, "sealed");
        assert.equal(claims[1].captchaToken, "captcha-token");
        assert.equal(solves[0].apiKey, "solver-key");
        assert.equal(solves[0].siteKey, "site-key");
        assert.equal(solves[0].userToken, undefined);
    } finally {
        engine.stop();
    }
});

test("stopping while solving a captcha aborts it and prevents a second claim", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("501");
    quest.userStatus.completedAt = "2026-11-16T00:00:00Z";
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.settings.autoClaim = true;
    env.options.settings.captchaApiKey = "solver-key";
    env.options.settings.captchaService = "capsolver";
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const solving = deferred();
    const claims = [];
    let solveSignal;
    env.options.native = {
        async claimReward(args) {
            claims.push(args);
            return { ok: false, status: 400, body: { captcha_sitekey: "site-key" } };
        },
        solveCaptcha(args) {
            solveSignal = args.signal;
            return solving.promise;
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(claims.length, 1);
        assert.equal(solveSignal.aborted, false);
        engine.stop();
        assert.equal(solveSignal.aborted, true);
        solving.resolve({ token: "captcha-token" });
        await nextTurn();
        assert.equal(claims.length, 1);
    } finally {
        engine.stop();
    }
});

test("achievement cleanup revokes only new OAuth grants for the activity application", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("601", "ACHIEVEMENT_IN_ACTIVITY");
    let tokenFetches = 0;
    const oldGrant = { id: "old", application: { id: "999" } };
    const newGrant = { id: "new", application: { id: "999" } };
    const unrelatedGrant = { id: "other", application: { id: "888" } };
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        tokenFetches++;
        return { body: tokenFetches === 1 ? [oldGrant] : [oldGrant, newGrant, unrelatedGrant] };
    });
    env.options.settings.achievementBypass = true;
    const deleted = [];
    env.options.http.post = async request => {
        if (request.url === "/oauth2/authorize") return { body: { location: "https://example.com/?code=test" } };
        if (request.url === "/applications/999/proxy-tickets") return { body: { ticket: "ticket" } };
        throw new Error(`Unexpected request ${request.url}`);
    };
    env.options.http.del = async request => { deleted.push(request.url); };
    env.options.native = {
        async discordsaysAuthorize() { return { ok: true, body: { token: "activity-token" } }; },
        async discordsaysProgress() { return { ok: true, body: {} }; }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(deleted, ["/oauth2/tokens/new"]);
    } finally {
        engine.stop();
    }
});

test("achievement cleanup leaves ambiguous concurrent OAuth grants untouched", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("601", "ACHIEVEMENT_IN_ACTIVITY");
    let tokenFetches = 0;
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        tokenFetches++;
        return { body: tokenFetches === 1 ? [] : [
            { id: "first", application: { id: "999" } },
            { id: "second", application: { id: "999" } }
        ] };
    });
    env.options.settings.achievementBypass = true;
    const deleted = [];
    env.options.http.post = async request => request.url === "/oauth2/authorize"
        ? { body: { location: "https://example.com/?code=test" } }
        : { body: { ticket: "ticket" } };
    env.options.http.del = async request => { deleted.push(request.url); };
    env.options.native = {
        async discordsaysAuthorize() { return { ok: true, body: { token: "activity-token" } }; },
        async discordsaysProgress() { return { ok: true, body: {} }; }
    };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(deleted, []);
        assert.match(warnings.join(" "), /Authorized Apps/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("a failed achievement is not reauthorized on every quest update", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const quest = taskQuest("601", "ACHIEVEMENT_IN_ACTIVITY");
    const env = runtime(async request => request.url === "/quests/@me"
        ? { body: { quests: [quest] } }
        : { body: [] });
    env.options.settings.achievementBypass = true;
    let authorizations = 0;
    env.options.http.post = async request => {
        if (request.url === "/oauth2/authorize") {
            authorizations++;
            return { body: { location: "https://example.com/?code=test" } };
        }
        return { body: { ticket: "ticket" } };
    };
    env.options.native = {
        async discordsaysAuthorize() { return { ok: false, body: {} }; }
    };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        await engine.start();
        await nextTurn();
        assert.equal(authorizations, 1);
        env.options.flux.dispatcher.dispatch({ type: "QUEST_USER_STATUS_UPDATE" });
        t.mock.timers.tick(500);
        await nextTurn();
        assert.equal(authorizations, 1);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("interruption during authorization cleanup warns without revoking on the new session", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("601", "ACHIEVEMENT_IN_ACTIVITY");
    const cleanupResponse = deferred();
    let tokenFetches = 0;
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        tokenFetches++;
        return tokenFetches === 1 ? { body: [] } : cleanupResponse.promise;
    });
    env.options.settings.achievementBypass = true;
    const deleted = [];
    env.options.http.post = async request => request.url === "/oauth2/authorize"
        ? { body: { location: "https://example.com/?code=test" } }
        : { body: { ticket: "ticket" } };
    env.options.http.del = async request => { deleted.push(request.url); };
    env.options.native = {
        async discordsaysAuthorize() { return { ok: true, body: { token: "activity-token" } }; },
        async discordsaysProgress() { return { ok: true, body: {} }; }
    };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await engine.start();
        await nextTurn();
        assert.equal(tokenFetches, 2);
        engine.stop();
        cleanupResponse.resolve({ body: [{ id: "new", application: { id: "999" } }] });
        await nextTurn();
        assert.deepEqual(deleted, []);
        assert.match(warnings.join(" "), /Authorized Apps/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});
