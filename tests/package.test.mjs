import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

test("Lune builds a Shelter-loadable plugin with matching manifest hash", async () => {
    const temporaryRoot = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();
    const output = mkdtempSync(join(temporaryRoot, "shelter-build-"));
    try {
        execFileSync(process.execPath, [
            "node_modules/@uwu/lune/dist/clibundle.cjs",
            "build",
            "plugins/quest-autocompleter",
            "--to",
            output
        ], { stdio: "pipe" });
        const code = readFileSync(join(output, "plugin.js"), "utf8");
        const manifest = JSON.parse(readFileSync(join(output, "plugin.json"), "utf8"));
        assert.equal(manifest.hash, createHash("md5").update(code).digest("hex"));
        assert.match(code, /SPDX-License-Identifier: GPL-3\.0-or-later/);
        assert.match(code, /Copyright \(c\) 2017 - Present Tauri Apps Contributors/);
        assert.match(code, /Permission is hereby granted, free of charge/);

        const events = [];
        const listeners = new Map();
        const shelter = {
            plugin: { store: {} },
            ui: {},
            solid: {},
            solidWeb: { template: () => () => ({}), delegateEvents: () => {} },
            flux: {
                stores: {},
                dispatcher: {
                    dispatch: event => events.push(event),
                    subscribe: (type, handler) => listeners.set(type, handler),
                    unsubscribe: type => listeners.delete(type)
                }
            },
            http: { ready: Promise.resolve(), get: async () => ({ body: { quests: [] } }) }
        };
        const plugin = vm.runInNewContext(code, {
            shelter, window: {}, console, AbortController, URL,
            navigator: { language: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            setTimeout, clearTimeout, setInterval, clearInterval
        });
        assert.equal(typeof plugin.onLoad, "function");
        assert.equal(typeof plugin.onUnload, "function");
        assert.equal(typeof plugin.settings, "function");
        try {
            await plugin.onLoad();
            assert.equal(shelter.plugin.store.enabled, true);
            assert.equal(shelter.plugin.store.autoAcceptQuests, false);
            assert.equal(shelter.plugin.store.autoClaim, false);
            assert.equal(shelter.plugin.store.achievementBypass, false);
            assert.equal(shelter.plugin.store.allowWatchVideo, true);
            assert.equal(shelter.plugin.store.allowPlayDesktop, true);
            assert.equal(shelter.plugin.store.allowPlayActivity, true);
            assert.equal(shelter.plugin.store.allowStreamDesktop, false);
            assert.equal(shelter.plugin.store.logProgress, true);
            assert.equal(shelter.plugin.store.fetchIntervalMinutes, 120);
            assert.equal(shelter.plugin.store.desktopHeartbeatSeconds, 60);
            assert.deepEqual(events, []);
        } finally {
            plugin.onUnload();
        }
        assert.equal(listeners.size, 0);
    } finally {
        rmSync(output, { recursive: true, force: true });
    }
});
