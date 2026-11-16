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
import { createDesktopIdentity, createDesktopTransport } from "./desktop.js";

const { store } = shelter.plugin;
const { SwitchItem, Select, SelectOption } = shelter.ui;

store.enabled ??= true;
store.autoAcceptQuests ??= false;
store.allowWatchVideo ??= true;
store.allowPlayDesktop ??= true;
store.allowPlayActivity ??= true;
store.allowStreamDesktop ??= false;
store.achievementBypass ??= false;
store.autoClaim ??= false;
store.logProgress ??= true;
store.fetchIntervalMinutes ??= 120;
store.desktopHeartbeatSeconds ??= 60;
store.desktopUserAgent ??= "";
store.captchaService ??= "nopecha";
store.captchaApiKey ??= "";

const STYLE_ID = "quest-autocompleter-settings";

const styles = `
.qac-settings { display: flex; flex-direction: column; }
.qac-group { margin: 20px 0 2px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: var(--text-muted, #b5bac1); }
.qac-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.qac-label { font-size: 14px; font-weight: 500; color: var(--text-normal, #dbdee1); }
.qac-input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-family: inherit; font-size: 14px; color: var(--text-normal, #dbdee1); background: var(--input-background, rgba(0, 0, 0, 0.2)); border: 1px solid var(--input-border, transparent); border-radius: 8px; outline: none; transition: border-color 0.15s ease; }
.qac-input:hover { border-color: var(--input-border-hover, rgba(255, 255, 255, 0.1)); }
.qac-input:focus { border-color: var(--brand-500, #5865f2); }
.qac-input::placeholder { color: var(--text-muted, #b5bac1); }
.qac-input[type="number"] { appearance: textfield; -moz-appearance: textfield; }
.qac-input[type="number"]::-webkit-outer-spin-button, .qac-input[type="number"]::-webkit-inner-spin-button { appearance: none; -webkit-appearance: none; margin: 0; }
.qac-note { margin: 0; font-size: 12px; line-height: 1.4; color: var(--text-muted, #b5bac1); }
.qac-advanced { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--background-modifier-accent, rgba(255, 255, 255, 0.06)); }
.qac-summary { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 14px; font-weight: 600; color: var(--text-normal, #dbdee1); cursor: pointer; list-style: none; }
.qac-summary::-webkit-details-marker { display: none; }
.qac-summary::before { content: "\\25B8"; color: var(--text-muted, #b5bac1); transition: transform 0.15s ease; }
.qac-advanced[open] .qac-summary::before { transform: rotate(90deg); }
`;

function applyStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const element = document.createElement("style");
    element.id = STYLE_ID;
    element.textContent = styles;
    document.head.append(element);
}

const hasNativeHttp = typeof window.__TAURI_INTERNALS__ !== "undefined";

const engine = createEngine({
    flux: shelter.flux,
    http: shelter.http,
    settings: store,
    native: hasNativeHttp ? createNative(tauriFetch) : undefined,
    desktopTransport: hasNativeHttp ? createDesktopTransport(tauriFetch, {
        identity: () => createDesktopIdentity({
            userAgent: store.desktopUserAgent || undefined,
            locale: typeof navigator !== "undefined" ? navigator.language : undefined
        })
    }) : undefined
});

function startEngine() {
    return engine.start().catch(() => {
        console.warn("[QuestAutocompleter] Could not initialize Discord HTTP.");
    });
}

export function onLoad() {
    applyStyles();
    if (!store.enabled) return;
    return startEngine();
}

export function onUnload() {
    engine.stop();
    if (typeof document !== "undefined") document.getElementById(STYLE_ID)?.remove();
}

export function settings() {
    applyStyles();
    return (
        <div class="qac-settings">
            <SwitchItem
                checked={store.enabled}
                note="Turns every automated quest action on or off."
                onChange={value => {
                    store.enabled = value;
                    if (value) startEngine();
                    else engine.stop();
                }}
            >
                Enable automated quests
            </SwitchItem>

            <p class="qac-group">Quests</p>
            <SwitchItem
                checked={store.autoAcceptQuests}
                note="Off means only quests you accepted yourself are processed."
                onChange={value => { store.autoAcceptQuests = value; }}
            >
                Accept new quests automatically
            </SwitchItem>
            <SwitchItem
                checked={store.allowWatchVideo}
                note="Watching a video or trailer."
                onChange={value => { store.allowWatchVideo = value; }}
            >
                Video quests
            </SwitchItem>
            <SwitchItem
                checked={store.allowPlayDesktop}
                note="Sent through Dorion's native HTTP with a desktop identity."
                onChange={value => { store.allowPlayDesktop = value; }}
            >
                Play desktop quests
            </SwitchItem>
            <SwitchItem
                checked={store.allowPlayActivity}
                note="Needs a text or voice channel to host the activity."
                onChange={value => { store.allowPlayActivity = value; }}
            >
                Activity quests
            </SwitchItem>
            <SwitchItem
                checked={store.allowStreamDesktop}
                note="Experimental. Start the stream yourself and keep one viewer in the voice channel; Discord validates both."
                onChange={value => { store.allowStreamDesktop = value; }}
            >
                Stream desktop quests
            </SwitchItem>
            <SwitchItem
                checked={store.achievementBypass}
                note="Experimental: authorizes the activity app. Dorion may strip the referrer header."
                onChange={value => { store.achievementBypass = value; }}
            >
                Achievement quests
            </SwitchItem>

            <p class="qac-group">Rewards</p>
            <SwitchItem
                checked={store.autoClaim}
                note="Uses a paid third-party CAPTCHA solver. If a claim fails, claim manually."
                onChange={value => { store.autoClaim = value; }}
            >
                Claim rewards automatically
            </SwitchItem>
            <div class="qac-field">
                <label class="qac-label" for="qac-captcha-service">CAPTCHA solver</label>
                <Select
                    value={store.captchaService}
                    onChange={value => { store.captchaService = value; }}
                    aria-label="CAPTCHA solver"
                >
                    <SelectOption value="nopecha">NopeCHA</SelectOption>
                    <SelectOption value="capsolver">CapSolver</SelectOption>
                    <SelectOption value="twocaptcha">2Captcha</SelectOption>
                </Select>
                <p class="qac-note">Only used when claiming rewards automatically.</p>
            </div>
            <div class="qac-field">
                <label class="qac-label" for="qac-captcha-key">CAPTCHA solver API key</label>
                <input
                    id="qac-captcha-key"
                    class="qac-input"
                    type="password"
                    autocomplete="off"
                    placeholder="Paste the key from your solver"
                    value={store.captchaApiKey}
                    onInput={event => { store.captchaApiKey = event.currentTarget.value; }}
                />
                <p class="qac-note">Stored unencrypted in Shelter's local plugin data and sent only to the selected solver.</p>
            </div>

            <details class="qac-advanced">
                <summary class="qac-summary">Advanced</summary>
                <div class="qac-field">
                    <label class="qac-label" for="qac-fetch-interval">Quest refresh interval (minutes)</label>
                    <input
                        id="qac-fetch-interval"
                        class="qac-input"
                        type="number"
                        min="30"
                        step="30"
                        value={store.fetchIntervalMinutes}
                        onChange={event => {
                            const value = Number(event.currentTarget.value);
                            store.fetchIntervalMinutes = Number.isFinite(value) && value >= 30 ? value : 30;
                        }}
                    />
                    <p class="qac-note">Minimum 30. Restart the plugin to apply.</p>
                </div>
                <div class="qac-field">
                    <label class="qac-label" for="qac-heartbeat-interval">Desktop heartbeat interval (seconds)</label>
                    <input
                        id="qac-heartbeat-interval"
                        class="qac-input"
                        type="number"
                        min="15"
                        max="110"
                        value={store.desktopHeartbeatSeconds}
                        onChange={event => {
                            const value = Number(event.currentTarget.value);
                            store.desktopHeartbeatSeconds = Number.isFinite(value) ? Math.min(110, Math.max(15, value)) : 60;
                        }}
                    />
                    <p class="qac-note">15 to 110. Discord credits at most two minutes of progress per heartbeat.</p>
                </div>
                <div class="qac-field">
                    <label class="qac-label" for="qac-desktop-agent">Desktop user agent override</label>
                    <input
                        id="qac-desktop-agent"
                        class="qac-input"
                        type="text"
                        autocomplete="off"
                        placeholder="Leave empty to generate one for this platform"
                        value={store.desktopUserAgent}
                        onInput={event => { store.desktopUserAgent = event.currentTarget.value.trim(); }}
                    />
                    <p class="qac-note">Must contain Electron/&lt;version&gt;. Only quest requests use it; chat stays on the normal session.</p>
                </div>
                <SwitchItem
                    checked={store.logProgress}
                    onChange={value => { store.logProgress = value; }}
                >
                    Log progress to the console
                </SwitchItem>
            </details>
        </div>
    );
}
