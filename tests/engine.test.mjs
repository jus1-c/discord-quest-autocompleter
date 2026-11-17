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
            configVersion: 2,
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

test("never dispatches a raw quest payload into the Discord quest store", async () => {
    const { createEngine } = await loadEngine();
    const quests = [{ id: "123", user_status: null }];
    const requests = [];
    const env = runtime(async request => {
        requests.push(request);
        return { body: { quests } };
    });
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(requests, [{ url: "/quests/@me" }]);
        assert.deepEqual(env.events, []);
        assert.equal(env.questStore.quests.size, 0);
    } finally {
        engine.stop();
    }
});

test("processes a snake_case API quest without touching the Discord store", async () => {
    const { createEngine } = await loadEngine();
    const quest = {
        id: "123",
        config: {
            expires_at: "2999-01-01T00:00:00.000Z",
            config_version: 2,
            messages: { quest_name: "Quest 123" },
            task_config_v2: { tasks: { WATCH_VIDEO: { target: 1 } } }
        },
        user_status: { enrolled_at: "2020-01-01T00:00:00.000Z", progress: {} }
    };
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/123/video-progress"]);
        assert.equal(env.questStore.quests.size, 0);
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

test("the Discord quest store wins over the fetched snapshot", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [videoQuest("123")] } }));
    const stored = videoQuest("123");
    stored.userStatus.completedAt = "2026-11-16T00:00:00.000Z";
    env.questStore.quests.set("123", stored);
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

test("desktop game quests heartbeat through the native transport until the target", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("401", "PLAY_ON_DESKTOP", 90);
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        return { body: [{ name: "Game", executables: [{ os: "win32", name: "game.exe" }] }] };
    });
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const heartbeats = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: { progress: { PLAY_ON_DESKTOP: { value: 90 } }, completed_at: null } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(heartbeats.length, 2);
        assert.equal(heartbeats[0].questId, "401");
        assert.equal(heartbeats[0].userToken, "discord-test-token");
        assert.equal(heartbeats[0].applicationId, "999");
        assert.match(heartbeats[0].executablePath, /game\.exe$/i);
        assert.equal(heartbeats[0].terminal, false);
        assert.equal(heartbeats[1].terminal, true);
        assert.equal(env.events.some(event => event.type === "RUNNING_GAMES_CHANGE"), false);
    } finally {
        engine.stop();
    }
});

test("a rejected desktop heartbeat is not retried in a tight loop", async () => {
    const { createEngine } = await loadEngine();
    const quest = taskQuest("402", "PLAY_ON_DESKTOP", 90);
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        return { body: [{ name: "Game", executables: [{ os: "win32", name: "game.exe" }] }] };
    });
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    let attempts = 0;
    env.options.desktopTransport = {
        async sendHeartbeat() {
            attempts++;
            return { ok: false, status: 401, body: null };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(attempts, 1);
    } finally {
        engine.stop();
    }
});

test("stream quests stay opt-in and never block other quests", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [taskQuest("701", "STREAM_ON_DESKTOP", 90), videoQuest("102")] } }));
    env.options.flux.stores.ApplicationStreamingStore = { getCurrentUserActiveStream: () => ({ guildId: "1", channelId: "2", ownerId: "3" }) };
    env.options.flux.stores.SortedVoiceStateStore = { countVoiceStatesForChannel: () => 2 };
    const heartbeats = [];
    const posts = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: { progress: { STREAM_ON_DESKTOP: { value: 90 } } } };
        }
    };
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(heartbeats, []);
        assert.deepEqual(posts.map(request => request.url), ["/quests/102/video-progress"]);
    } finally {
        engine.stop();
    }
});

test("a stream quest waits until the user is really streaming", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [taskQuest("702", "STREAM_ON_DESKTOP", 90), videoQuest("102")] } }));
    env.options.settings.allowStreamDesktop = true;
    env.options.flux.stores.ApplicationStreamingStore = { getCurrentUserActiveStream: () => null };
    env.options.flux.stores.SortedVoiceStateStore = { countVoiceStatesForChannel: () => 0 };
    const heartbeats = [];
    const posts = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: {} };
        }
    };
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(heartbeats, []);
        assert.deepEqual(posts.map(request => request.url), ["/quests/102/video-progress"]);
    } finally {
        engine.stop();
    }
});

test("a stream quest waits while nobody is watching", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [taskQuest("703", "STREAM_ON_DESKTOP", 90)] } }));
    env.options.settings.allowStreamDesktop = true;
    env.options.flux.stores.ApplicationStreamingStore = { getCurrentUserActiveStream: () => ({ guildId: "1", channelId: "2", ownerId: "3" }) };
    env.options.flux.stores.SortedVoiceStateStore = { countVoiceStatesForChannel: () => 1 };
    const heartbeats = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: {} };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(heartbeats, []);
    } finally {
        engine.stop();
    }
});

test("a stream quest heartbeats with the stream key of the live stream", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [taskQuest("704", "STREAM_ON_DESKTOP", 90)] } }));
    env.options.settings.allowStreamDesktop = true;
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.flux.stores.ApplicationStreamingStore = { getCurrentUserActiveStream: () => ({ guildId: "1", channelId: "2", ownerId: "3" }) };
    env.options.flux.stores.SortedVoiceStateStore = { countVoiceStatesForChannel: () => 2 };
    const heartbeats = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: { progress: { STREAM_ON_DESKTOP: { value: 90 } } } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(heartbeats.length, 2);
        assert.equal(heartbeats[0].questId, "704");
        assert.equal(heartbeats[0].streamKey, "guild:1:2:3");
        assert.equal(heartbeats[0].applicationId, "999");
        assert.equal(heartbeats[0].userToken, "discord-test-token");
        assert.equal(heartbeats[0].terminal, false);
        assert.equal(heartbeats[1].terminal, true);
    } finally {
        engine.stop();
    }
});

test("a direct message stream uses a call stream key", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [taskQuest("705", "STREAM_ON_DESKTOP", 90)] } }));
    env.options.settings.allowStreamDesktop = true;
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.flux.stores.ApplicationStreamingStore = { getCurrentUserActiveStream: () => ({ channelId: "2", ownerId: "3" }) };
    env.options.flux.stores.SortedVoiceStateStore = { countVoiceStatesForChannel: () => 2 };
    const heartbeats = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: { progress: { STREAM_ON_DESKTOP: { value: 90 } } } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(heartbeats[0].streamKey, "call:2:3");
    } finally {
        engine.stop();
    }
});

test("the master switch stops new work", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [videoQuest("101")] } }));
    env.options.settings.enabled = false;
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts, []);
    } finally {
        engine.stop();
    }
});

test("quests the user has not accepted are left alone", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("201");
    quest.userStatus = null;
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { status: 200, body: {} };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(posts, []);
    } finally {
        engine.stop();
    }
});

test("a quest family that is turned off is skipped", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [videoQuest("101"), taskQuest("301", "PLAY_ACTIVITY", 20)] } }));
    env.options.settings.allowWatchVideo = false;
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
        assert.deepEqual(posts.map(request => request.url), [
            "/quests/301/heartbeat",
            "/quests/301/heartbeat"
        ]);
    } finally {
        engine.stop();
    }
});

test("desktop quests without a native transport do not block video quests", async () => {
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

test("a quest missing from a later fetch is not processed", async () => {
    const { createEngine } = await loadEngine();
    let fetchCount = 0;
    const env = runtime(async () => {
        fetchCount++;
        return { body: { quests: fetchCount === 1 ? [videoQuest("101"), videoQuest("102")] : [videoQuest("101")] } };
    });
    const originalSetInterval = globalThis.setInterval;
    const intervals = [];
    globalThis.setInterval = (callback, delay) => {
        intervals.push({ callback, delay });
        return originalSetInterval(() => { }, 1e9);
    };
    const firstResponse = deferred();
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return posts.length === 1 ? firstResponse.promise : { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(posts.length, 1);
        await intervals.find(interval => interval.delay === 7_200_000).callback();
        await nextTurn();
        assert.equal(fetchCount, 2);
        firstResponse.resolve({ body: { completed_at: "2026-11-16T00:00:00.000Z" } });
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/101/video-progress"]);
    } finally {
        engine.stop();
        globalThis.setInterval = originalSetInterval;
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
        return count === 1 ? oldResponse.promise : { body: { quests: [videoQuest("new")] } };
    });
    const posts = [];
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { completed_at: "2026-11-16T00:00:00.000Z" } };
    };
    const engine = createEngine(env.options);
    try {
        const firstStart = engine.start();
        await nextTurn();
        env.options.flux.dispatcher.dispatch({ type: "CONNECTION_OPEN" });
        await nextTurn();
        oldResponse.resolve({ body: { quests: [videoQuest("old")] } });
        await firstStart;
        await nextTurn();
        assert.deepEqual(posts.map(request => request.url), ["/quests/new/video-progress"]);
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
        async discordsaysAuthorize() { return { ok: false, body: {} }; },
        async discordsaysProgress() { return { ok: true, body: {} }; }
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

function multiTaskQuest(id, tasks, { joinOperator = "or", enrolled = true } = {}) {
    return {
        id,
        config: {
            configVersion: 2,
            expiresAt: "2999-01-01T00:00:00.000Z",
            messages: { questName: `Quest ${id}` },
            application: { id: "999", name: "Game" },
            taskConfig: { joinOperator, tasks }
        },
        userStatus: enrolled ? { enrolledAt: "2020-01-01T00:00:00.000Z", progress: {} } : null
    };
}

test("a quest that offers several platforms runs the desktop task", async () => {
    const { createEngine } = await loadEngine();
    const quest = multiTaskQuest("801", {
        PLAY_ACTIVITY: { target: 20 },
        PLAY_ON_DESKTOP: { target: 90 }
    });
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [quest] } };
        return { body: [{ name: "Game", executables: [{ os: "win32", name: "game.exe" }] }] };
    });
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.flux.stores.ChannelStore = { getSortedPrivateChannels: () => [{ id: "1234" }] };
    const heartbeats = [];
    const posts = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: { progress: { PLAY_ON_DESKTOP: { value: 90 } } } };
        }
    };
    env.options.http.post = async request => { posts.push(request); return { body: { progress: { PLAY_ACTIVITY: { value: 20 } } } }; };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(heartbeats.length, 2);
        assert.deepEqual(posts, []);
    } finally {
        engine.stop();
    }
});

test("the quest's own task order is used when the platform preference is off", async () => {
    const { createEngine } = await loadEngine();
    const quest = multiTaskQuest("802", {
        PLAY_ACTIVITY: { target: 20 },
        PLAY_ON_DESKTOP: { target: 90 }
    });
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.settings.preferDesktopPlatform = false;
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.flux.stores.ChannelStore = { getSortedPrivateChannels: () => [{ id: "1234" }] };
    const heartbeats = [];
    const posts = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: {} };
        }
    };
    env.options.http.post = async request => {
        posts.push(request);
        return { body: { progress: { PLAY_ACTIVITY: { value: 20 } } } };
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(heartbeats, []);
        assert.deepEqual(posts.map(request => request.url), [
            "/quests/802/heartbeat",
            "/quests/802/heartbeat"
        ]);
    } finally {
        engine.stop();
    }
});

test("a quest that requires every task is reported instead of half finished", async () => {
    const { createEngine } = await loadEngine();
    const quest = multiTaskQuest("803", {
        PLAY_ON_DESKTOP: { target: 90 },
        WATCH_VIDEO: { target: 60 }
    }, { joinOperator: "and" });
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const heartbeats = [];
    const posts = [];
    env.options.desktopTransport = {
        async sendHeartbeat(args) {
            heartbeats.push(args);
            return { ok: true, status: 200, body: {} };
        }
    };
    env.options.http.post = async request => { posts.push(request); return { body: {} }; };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await engine.start();
        await nextTurn();
        assert.deepEqual(heartbeats, []);
        assert.deepEqual(posts, []);
        assert.match(warnings.join(" "), /every task/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("a console only quest is reported and does not block other quests", async () => {
    const { createEngine } = await loadEngine();
    const consoleOnly = multiTaskQuest("804", { PLAY_ON_XBOX: { target: 900 } });
    const env = runtime(async () => ({ body: { quests: [consoleOnly, videoQuest("102")] } }));
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
        assert.match(warnings.join(" "), /PLAY_ON_XBOX/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("diagnostics describe quests without leaking the account token", async () => {
    const { createEngine } = await loadEngine();
    const env = runtime(async () => ({ body: { quests: [videoQuest("901")] } }));
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.http.post = async () => ({ body: {} });
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        const report = engine.diagnostics();
        const text = JSON.stringify(report);
        assert.match(text, /901/);
        assert.match(text, /WATCH_VIDEO/);
        assert.doesNotMatch(text, /discord-test-token/);
        assert.equal(report.quests[0].chosenTask, "WATCH_VIDEO");
        assert.equal(report.quests[0].enrolled, true);
    } finally {
        engine.stop();
    }
});

test("diagnostics report the application id a task declares", async () => {
    const { createEngine } = await loadEngine();
    const quest = multiTaskQuest("902", {
        PLAY_ON_DESKTOP: { target: 900, applications: [{ id: "777" }] }
    });
    delete quest.config.application;
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.http.post = async () => ({ body: {} });
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        const report = engine.diagnostics();
        assert.equal(report.quests[0].applicationId, "777");
    } finally {
        engine.stop();
    }
});

test("diagnostics keep the achievement event name of a task", async () => {
    const { createEngine } = await loadEngine();
    const quest = multiTaskQuest("903", {
        ACHIEVEMENT_IN_ACTIVITY: { target: 4, event_name: "progress" }
    });
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.settings.achievementBypass = true;
    env.options.http.post = async () => ({ body: {} });
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        const task = engine.diagnostics().quests[0].tasks[0];
        assert.equal(task.type, "ACHIEVEMENT_IN_ACTIVITY");
        assert.equal(task.eventName, "progress");
        assert.equal(task.target, 4);
    } finally {
        engine.stop();
    }
});

function achievementQuest(id, target = 4) {
    return multiTaskQuest(id, {
        ACHIEVEMENT_IN_ACTIVITY: { target, event_name: "progress", applications: [{ id: "999" }] }
    });
}

function recipeFor(overrides = {}) {
    return {
        id: "demo",
        match: { applicationId: "999", taskTypes: ["ACHIEVEMENT_IN_ACTIVITY"] },
        report: {
            url: "https://discord.com/api/v9/quests/{questId}/heartbeat",
            body: { value: "{value}", app: "{applicationId}" },
            valueField: "progress.ACHIEVEMENT_IN_ACTIVITY.value",
            step: 1,
            intervalSeconds: 5
        },
        finish: {
            url: "https://discord.com/api/v9/quests/{questId}/heartbeat",
            body: { terminal: true }
        },
        ...overrides
    };
}

test("a custom recipe reports progress until the target", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async () => ({ body: { quests: [achievementQuest("910")] } }));
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([recipeFor()]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const calls = [];
    env.options.native = {
        async request(url, options) {
            const body = options.body;
            calls.push({ url, body, headers: options.headers });
            if (body.terminal) return { ok: true, status: 200, body: {} };
            return { ok: true, status: 200, body: { progress: { ACHIEVEMENT_IN_ACTIVITY: { value: body.value } } } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        for (let i = 0; i < 10; i++) {
            t.mock.timers.tick(5000);
            await nextTurn();
        }
        const reports = calls.filter(call => !call.body.terminal);
        assert.deepEqual(reports.map(call => call.body.value), [1, 2, 3, 4]);
        assert.equal(reports[0].body.app, "999");
        assert.equal(reports[0].headers.Authorization, "discord-test-token");
        assert.equal(calls.at(-1).body.terminal, true);
    } finally {
        engine.stop();
    }
});

test("a custom recipe wins over the built in activity adapter", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async () => ({ body: { quests: [achievementQuest("911", 1)] } }));
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([recipeFor()]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const posts = [];
    env.options.http.post = async request => { posts.push(request.url); return { body: {} }; };
    let recipeCalls = 0;
    env.options.native = {
        async request() {
            recipeCalls++;
            return { ok: true, status: 200, body: { progress: { ACHIEVEMENT_IN_ACTIVITY: { value: 1 } } } };
        },
        async discordsaysAuthorize() { return { ok: true, body: { token: "t" } }; },
        async discordsaysProgress() { return { ok: true, body: {} }; }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.ok(recipeCalls > 0);
        assert.deepEqual(posts, []);
    } finally {
        engine.stop();
    }
});

test("a recipe that does not match leaves the quest to the built in adapter", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async request => request.url === "/oauth2/tokens"
        ? { body: [] }
        : { body: { quests: [achievementQuest("912", 1)] } });
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([recipeFor({ match: { applicationId: "12345" } })]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const posts = [];
    env.options.http.post = async request => { posts.push(request.url); return { body: {} }; };
    let recipeCalls = 0;
    env.options.native = {
        async request() { recipeCalls++; return { ok: true, status: 200, body: {} }; },
        async discordsaysAuthorize() { return { ok: false, body: {} }; },
        async discordsaysProgress() { return { ok: true, body: {} }; }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(recipeCalls, 0);
        assert.ok(posts.includes("/oauth2/authorize"));
    } finally {
        engine.stop();
    }
});

test("a recipe can run a setup step and use what it captured", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async () => ({ body: { quests: [achievementQuest("913", 2)] } }));
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([{
        id: "arise",
        match: { applicationId: "999", taskTypes: ["ACHIEVEMENT_IN_ACTIVITY"] },
        setup: [{
            url: "https://{applicationId}.discordsays.com/.proxy/acf/arise/register",
            headers: { "X-Discord-Activity-Id": "{applicationId}" },
            save: { authToken: "body.authToken" }
        }],
        report: {
            url: "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress",
            headers: { "X-Auth-Token": "{authToken}" },
            body: { progress: "{value}", quest_id: "{questId}" },
            step: 1,
            intervalSeconds: 5,
            successPath: "status"
        }
    }]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const calls = [];
    env.options.native = {
        async request(url, options) {
            calls.push({ url, headers: options.headers, body: options.body });
            if (url.endsWith("/arise/register")) return { ok: true, status: 200, body: { authToken: "tok-123" } };
            return { ok: true, status: 200, body: { status: "ok" } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        for (let i = 0; i < 5; i++) {
            t.mock.timers.tick(5000);
            await nextTurn();
        }
        assert.equal(calls.length, 3);
        assert.match(calls[0].url, /\/arise\/register$/);
        assert.equal(calls[0].headers["X-Discord-Activity-Id"], "999");
        assert.match(calls[1].url, /\/quest\/progress$/);
        assert.equal(calls[1].headers["X-Auth-Token"], "tok-123");
        assert.deepEqual(calls.slice(1).map(call => call.body), [
            { progress: 1, quest_id: "913" },
            { progress: 2, quest_id: "913" }
        ]);
    } finally {
        engine.stop();
    }
});

test("a refused setup step is retried like the activity's own client", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async () => ({ body: { quests: [achievementQuest("918", 2)] } }));
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([{
        id: "arise",
        match: { applicationId: "999", taskTypes: ["ACHIEVEMENT_IN_ACTIVITY"] },
        setup: [{
            url: "https://{applicationId}.discordsays.com/.proxy/acf/arise/register",
            headers: { "X-Discord-Activity-Id": "{applicationId}" },
            save: { authToken: "body.authToken" }
        }],
        report: {
            url: "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress",
            headers: { "X-Auth-Token": "{authToken}" },
            body: { progress: "{value}", quest_id: "{questId}" },
            intervalSeconds: 5,
            successPath: "status"
        }
    }]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const calls = [];
    let failures = 2;
    env.options.native = {
        async request(url, options) {
            calls.push({ url, headers: options.headers, body: options.body });
            if (url.endsWith("/arise/register")) {
                if (failures > 0) {
                    failures--;
                    return { ok: false, status: 500, body: { message: "internal" } };
                }
                return { ok: true, status: 200, body: { authToken: "tok-123" } };
            }
            return { ok: true, status: 200, body: { status: "ok" } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        t.mock.timers.tick(1000);
        await nextTurn();
        t.mock.timers.tick(2000);
        await nextTurn();
        const registers = calls.filter(call => call.url.endsWith("/arise/register"));
        assert.equal(registers.length, 3);
        t.mock.timers.tick(5000);
        await nextTurn();
        const progress = calls.filter(call => call.url.endsWith("/quest/progress"));
        assert.equal(progress.length >= 1, true);
        assert.equal(progress[0].headers["X-Auth-Token"], "tok-123");
    } finally {
        engine.stop();
    }
});

test("a refused request names the status and the server's answer without leaking tokens", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async () => ({ body: { quests: [achievementQuest("919", 2)] } }));
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([{
        id: "leaky",
        match: { applicationId: "999", taskTypes: ["ACHIEVEMENT_IN_ACTIVITY"] },
        setup: [{
            url: "https://discord.com/api/v9/x",
            save: { value: "token" }
        }],
        report: {
            url: "https://discord.com/api/v9/x",
            body: { value: "{value}" }
        }
    }]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.native = {
        async request() {
            return { ok: false, status: 500, body: { message: "internal", token: "should-not-appear" } };
        }
    };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await engine.start();
        await nextTurn();
        t.mock.timers.tick(1000);
        await nextTurn();
        t.mock.timers.tick(2000);
        await nextTurn();
        const text = warnings.join(" ");
        assert.match(text, /status 500/);
        assert.match(text, /"message":"internal"/);
        assert.doesNotMatch(text, /should-not-appear/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("a recipe that the server rejects does not claim success", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async () => ({ body: { quests: [achievementQuest("914", 4)] } }));
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([{
        id: "reject",
        match: { applicationId: "999" },
        report: {
            url: "https://discord.com/api/v9/quests/{questId}/heartbeat",
            body: { progress: "{value}" },
            successPath: "status"
        }
    }]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    let attempts = 0;
    env.options.native = {
        async request() {
            attempts++;
            return { ok: true, status: 200, body: { status: "error" } };
        }
    };
    const engine = createEngine(env.options);
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        await engine.start();
        await nextTurn();
        t.mock.timers.tick(5000);
        await nextTurn();
        assert.equal(attempts, 1);
        assert.match(warnings.join(" "), /was not accepted/);
    } finally {
        engine.stop();
        console.warn = originalWarn;
    }
});

test("a recipe can reuse the plugin's own activity authorization", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [achievementQuest("915", 2)] } };
        if (request.url === "/oauth2/tokens") return { body: [] };
        if (request.url === "/oauth2/authorize") return { body: { location: "https://example.com/?code=abc" } };
        return { body: { ticket: "ticket" } };
    });
    env.options.settings.achievementBypass = true;
    env.options.settings.customAdapters = JSON.stringify([{
        id: "arise",
        match: { applicationId: "999" },
        setup: [{ kind: "activityAuthorize", save: { token: "token" } }],
        report: {
            url: "https://{applicationId}.discordsays.com/.proxy/acf/quest/progress",
            auth: "none",
            headers: { "X-Auth-Token": "{token}" },
            body: { progress: "{value}", quest_id: "{questId}" },
            intervalSeconds: 5,
            successPath: "status"
        }
    }]);
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.native = {
        async discordsaysAuthorize() { return { ok: true, body: { token: "activity-token" } }; },
        async request(url, options) {
            return { ok: true, status: 200, body: { status: "ok", seen: options.headers["X-Auth-Token"] } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        for (let i = 0; i < 4; i++) {
            t.mock.timers.tick(5000);
            await nextTurn();
        }
        const report = engine.diagnostics().quests[0];
        assert.equal(report.adapter, "recipe:arise");
    } finally {
        engine.stop();
    }
});

test("the built-in Arise recipe drives an achievement quest end to end", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gameQuest = multiTaskQuest("916", {
        ACHIEVEMENT_IN_ACTIVITY: { target: 4, applications: [{ id: "1557799582732124221" }] }
    });
    gameQuest.config.application = { id: "1557799582732124221", name: "EXOPLANET" };
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [gameQuest] } };
        if (request.url === "/oauth2/tokens") return { body: [] };
        return { body: {} };
    });
    env.options.http.post = async request => {
        if (request.url === "/oauth2/authorize") return { body: { location: "https://astronaut.ariseworlds.com?code=abc&iss=x" } };
        if (request.url.endsWith("/proxy-tickets")) return { body: { ticket: "ab+cd/ef==" } };
        return { body: {} };
    };
    env.options.http.del = async () => ({ body: {} });
    env.options.settings.achievementBypass = true;
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    const calls = [];
    let authorized = null;
    env.options.native = {
        async discordsaysAuthorize(options) {
            authorized = options;
            return { ok: true, status: 200, body: { token: "activity-token" } };
        },
        async request(url, options) {
            calls.push({ url, headers: options.headers, body: options.body });
            if (url.includes("/arise/register")) return { ok: true, status: 200, body: { authToken: "arise-token" } };
            return { ok: true, status: 200, body: { status: "ok" } };
        }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        for (let i = 0; i < 6; i++) {
            t.mock.timers.tick(6000);
            await nextTurn();
        }
        const report = engine.diagnostics().quests[0];
        assert.equal(report.adapter, "recipe:arise-activity");
        // The authorize call carries the activity's own protocol, with its placeholders filled in.
        assert.equal(authorized.headers["X-Discord-Activity-Id"], "1557799582732124221");
        assert.equal(authorized.headers["X-Discord-Hostname"], "1557799582732124221.discordsays.com");
        assert.equal(authorized.headers["X-Arise-Client"], "astronaut-prod-main-46567f6");
        assert.equal(authorized.ticket, "ab+cd/ef==");
        assert.match(authorized.referrer, /discord_proxy_ticket=ab\+cd\/ef==$/);
        // Registration upgrades the Arise user token to the token progress is reported with.
        // The ticket is base64, so it has to be percent-encoded before it goes into a query.
        assert.match(calls[0].url, /\.proxy\/acf\/arise\/register\?discord_proxy_ticket=ab%2Bcd%2Fef%3D%3D$/);
        assert.equal(calls[0].headers["X-Auth-Token"], "activity-token");
        assert.equal(calls[0].headers.Authorization, undefined);
        assert.match(calls[1].url, /\.proxy\/acf\/quest\/progress\?discord_proxy_ticket=ab%2Bcd%2Fef%3D%3D$/);
        // The quest endpoints take the authorize token; the register token belongs to /.proxy/api.
        assert.equal(calls[1].headers["X-Auth-Token"], "activity-token");
        assert.deepEqual(calls.slice(1).map(call => call.body), [
            { progress: 1, quest_id: "916" },
            { progress: 2, quest_id: "916" },
            { progress: 3, quest_id: "916" },
            { progress: 4, quest_id: "916" }
        ]);
    } finally {
        engine.stop();
    }
});

test("turning off built-in recipes falls back to the built in adapter", async t => {
    const { createEngine } = await loadEngine();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gameQuest = multiTaskQuest("917", {
        ACHIEVEMENT_IN_ACTIVITY: { target: 4, applications: [{ id: "1557799582732124221" }] }
    });
    gameQuest.config.application = { id: "1557799582732124221", name: "EXOPLANET" };
    const env = runtime(async request => {
        if (request.url === "/quests/@me") return { body: { quests: [gameQuest] } };
        if (request.url === "/oauth2/tokens") return { body: [] };
        return { body: {} };
    });
    env.options.settings.achievementBypass = true;
    env.options.settings.useBuiltInRecipes = false;
    env.options.http.post = async () => ({ body: {} });
    env.options.flux.stores.AuthenticationStore = { getToken: () => "discord-test-token" };
    env.options.native = {
        async discordsaysAuthorize() { return { ok: false, status: 401, body: {} }; },
        async discordsaysProgress() { return { ok: true, status: 200, body: {} }; }
    };
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        assert.equal(engine.diagnostics().quests[0].adapter, "acf");
    } finally {
        engine.stop();
    }
});

test("diagnostics show the live progress value of each task", async () => {
    const { createEngine } = await loadEngine();
    const quest = videoQuest("920");
    quest.userStatus.progress = { WATCH_VIDEO: { value: 42 } };
    const env = runtime(async () => ({ body: { quests: [quest] } }));
    env.options.http.post = async () => ({ body: {} });
    const engine = createEngine(env.options);
    try {
        await engine.start();
        await nextTurn();
        const task = engine.diagnostics().quests[0].tasks[0];
        assert.equal(task.type, "WATCH_VIDEO");
        assert.equal(task.value, 42);
        assert.equal(task.target, 1);
    } finally {
        engine.stop();
    }
});
