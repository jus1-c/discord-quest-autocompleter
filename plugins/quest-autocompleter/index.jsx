/*!
 * Adapted from the Vencord QuestAutocompleter plugin on 2026-11-16.
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 * https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Bundled @tauri-apps/api and @tauri-apps/plugin-http are used under the MIT license:
 *
 * MIT License
 *
 * Copyright (c) 2017 - Present Tauri Apps Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createEngine } from "./engine.js";
import { createNative } from "./native.js";

const { store } = shelter.plugin;
const { SwitchItem, Select, SelectOption } = shelter.ui;

store.autoAcceptQuests ??= false;
store.fetchIntervalMinutes ??= 120;
store.logProgress ??= true;
store.achievementBypass ??= false;
store.autoClaim ??= false;
store.captchaService ??= "nopecha";
store.captchaApiKey ??= "";

const engine = createEngine({
    flux: shelter.flux,
    http: shelter.http,
    settings: store,
    native: window.__DORION_INIT__ && window.__TAURI_INTERNALS__ ? createNative(tauriFetch) : undefined,
    isDesktop: typeof window.DiscordNative !== "undefined"
});

export function onLoad() {
    return engine.start().catch(() => {
        console.warn("[QuestAutocompleter] Could not initialize Discord HTTP.");
    });
}

export function onUnload() {
    engine.stop();
}

export function settings() {
    return (
        <div>
            <SwitchItem checked={store.autoAcceptQuests} onChange={value => { store.autoAcceptQuests = value; }}>
                Automatically accept available quests
            </SwitchItem>
            <SwitchItem checked={store.logProgress} onChange={value => { store.logProgress = value; }}>
                Log progress to the console
            </SwitchItem>
            <SwitchItem
                checked={store.achievementBypass}
                onChange={value => { store.achievementBypass = value; }}
                note="Experimental: authorizes an activity app. Dorion may block the referrer header."
            >
                Automatically process achievement quests
            </SwitchItem>
            <SwitchItem
                checked={store.autoClaim}
                onChange={value => { store.autoClaim = value; }}
                note="Uses a paid third-party CAPTCHA solver. If claiming fails, claim manually."
            >
                Automatically claim rewards
            </SwitchItem>
            <label for="quest-fetch-interval">Quest fetch interval in minutes (minimum 30; restart plugin to apply)</label>
            <input
                id="quest-fetch-interval"
                type="number"
                min="30"
                value={store.fetchIntervalMinutes}
                onChange={event => {
                    const value = Number(event.currentTarget.value);
                    store.fetchIntervalMinutes = Number.isFinite(value) && value >= 30 ? value : 30;
                }}
            />
            <p>CAPTCHA solver</p>
            <Select value={store.captchaService} onChange={value => { store.captchaService = value; }} aria-label="CAPTCHA solver">
                <SelectOption value="nopecha">NopeCHA</SelectOption>
                <SelectOption value="capsolver">CapSolver</SelectOption>
                <SelectOption value="twocaptcha">2Captcha</SelectOption>
            </Select>
            <label for="quest-captcha-key">CAPTCHA solver API key (stored locally, unencrypted)</label>
            <input
                id="quest-captcha-key"
                type="password"
                autocomplete="off"
                value={store.captchaApiKey}
                onInput={event => { store.captchaApiKey = event.currentTarget.value; }}
            />
        </div>
    );
}
