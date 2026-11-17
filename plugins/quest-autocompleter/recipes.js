/*
 * Declarative quest recipes.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A recipe describes how a quest's own application reports progress, without running any
 * pasted code. It is validated before use and every request is restricted to Discord hosts,
 * so a recipe cannot redirect the account token somewhere else.
 *
 * Shape:
 *   { id, match, setup?, report, finish? }
 *   setup  - ordered requests that hand out a token or session; each may `save` a value
 *   report - one request repeated while the quest needs progress
 *   finish - one request after the loop
 */

import { describeResponse } from "./redact.js";

const PLACEHOLDERS = ["questId", "applicationId", "target", "value", "attempt", "eventName"];
const FORBIDDEN_HEADERS = ["authorization", "cookie", "host"];
const METHODS = ["POST", "GET", "DELETE"];
const DISCORD_URL = /^https:\/\/discord\.com\/api\/v\d+\//;
const DISCORDS_SAYS_URL = /^https:\/\/\{applicationId\}\.discordsays\.com\//;
const MAX_DOCUMENT_LENGTH = 8000;
const MAX_SETUP_STEPS = 5;
const SETUP_ATTEMPTS = 3;
const SETUP_KINDS = ["activityAuthorize"];

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function checkPlaceholders(text, where, allowed = PLACEHOLDERS) {
    for (const match of String(text).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
        if (!allowed.includes(match[1])) {
            throw new Error(`Unknown placeholder {${match[1]}} in ${where}`);
        }
    }
}

function normalizeHeaders(raw, where, allowed) {
    const headers = raw === undefined ? {} : raw;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error(`${where}.headers must be an object`);
    for (const key of Object.keys(headers)) {
        if (FORBIDDEN_HEADERS.includes(key.toLowerCase())) {
            throw new Error(`${where}.headers cannot set ${key}; the plugin owns Authorization, Cookie and Host`);
        }
    }
    checkPlaceholders(Object.values(headers).join(" "), `${where}.headers`, allowed);
    return headers;
}

function normalizeBody(raw, where, allowed) {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}.body must be an object`);
    checkPlaceholders(JSON.stringify(raw), `${where}.body`, allowed);
    return raw;
}

function normalizeRequest(raw, where, allowed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
    if (typeof raw.url !== "string") throw new Error(`${where}.url must be a string`);
    if (!DISCORD_URL.test(raw.url) && !DISCORDS_SAYS_URL.test(raw.url)) {
        throw new Error(`${where}.url must point at discord.com or {applicationId}.discordsays.com over https`);
    }
    checkPlaceholders(raw.url, `${where}.url`, allowed);

    const method = raw.method === undefined ? "POST" : String(raw.method).toUpperCase();
    if (!METHODS.includes(method)) throw new Error(`${where}.method must be POST, GET or DELETE`);

    return {
        url: raw.url,
        method,
        headers: normalizeHeaders(raw.headers, where, allowed),
        body: normalizeBody(raw.body, where, allowed),
        auth: normalizeAuth(raw.auth, where)
    };
}

function normalizeAuth(raw, where) {
    const auth = raw === undefined ? "discord" : raw;
    if (auth !== "discord" && auth !== "none") throw new Error(`${where}.auth must be "discord" or "none"`);
    return auth;
}

function normalizeSave(raw, where) {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}.save must be an object`);
    for (const [name, path] of Object.entries(raw)) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(name)) throw new Error(`${where}.save has an invalid name "${name}"`);
        if (typeof path !== "string" || !path) throw new Error(`${where}.save.${name} must be a dotted path`);
    }
    return raw;
}

function normalizeSetupStep(raw, index, allowed) {
    const where = `setup[${index}]`;
    if (raw && raw.kind !== undefined) {
        if (!SETUP_KINDS.includes(raw.kind)) throw new Error(`${where}.kind must be one of ${SETUP_KINDS.join(", ")}`);
        const save = normalizeSave(raw.save, where);
        if (Object.keys(save).length === 0) throw new Error(`${where} kind "${raw.kind}" needs a save object`);
        return {
            kind: raw.kind,
            save,
            headers: normalizeHeaders(raw.headers, where, allowed),
            body: normalizeBody(raw.body, where, allowed)
        };
    }
    const step = normalizeRequest(raw, where, allowed);
    return { ...step, save: normalizeSave(raw.save, where) };
}

function normalizeRecipe(raw, index) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`recipe ${index} must be an object`);
    if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) {
        throw new Error(`recipe ${index} needs an id of letters, digits, dash or underscore (max 40)`);
    }

    const match = raw.match;
    if (!match || typeof match !== "object" || Array.isArray(match)) {
        throw new Error(`recipe "${raw.id}" needs a match object saying which quests it applies to`);
    }
    const conditions = {
        applicationId: match.applicationId === undefined ? [] : [].concat(match.applicationId).map(String),
        questId: match.questId === undefined ? [] : [].concat(match.questId).map(String),
        taskType: match.taskTypes === undefined ? [] : [].concat(match.taskTypes).map(String),
        eventName: match.eventName === undefined ? [] : [].concat(match.eventName).map(String)
    };
    if (!Object.values(conditions).some(list => list.length > 0)) {
        throw new Error(`recipe "${raw.id}" must match on an applicationId, questId, taskType or eventName`);
    }

    const setupRaw = raw.setup === undefined ? [] : raw.setup;
    if (!Array.isArray(setupRaw)) throw new Error(`recipe "${raw.id}" setup must be an array`);
    if (setupRaw.length > MAX_SETUP_STEPS) throw new Error(`recipe "${raw.id}" allows at most ${MAX_SETUP_STEPS} setup steps`);
    const setup = [];
    const captures = [];
    setupRaw.forEach((stepRaw, stepIndex) => {
        // Each step may use what the earlier ones captured, so the ticket from the activity
        // authorization can be handed to the requests that follow it.
        const step = normalizeSetupStep(stepRaw, stepIndex, [...PLACEHOLDERS, ...captures]);
        setup.push(step);
        for (const name of Object.keys(step.save)) if (!captures.includes(name)) captures.push(name);
    });
    const allowed = [...PLACEHOLDERS, ...captures];

    if (!raw.report || typeof raw.report !== "object") throw new Error(`recipe "${raw.id}" needs a report object`);
    const report = normalizeRequest(raw.report, `recipe "${raw.id}" report`, allowed);
    const step = raw.report.step === "target" ? "target" : clampNumber(raw.report.step, 1, 1, 100000);

    const successPath = raw.report.successPath === undefined ? null : String(raw.report.successPath);
    const successEquals = raw.report.successEquals === undefined ? "ok" : String(raw.report.successEquals);

    return {
        id: raw.id,
        match: conditions,
        captures,
        setup,
        report: {
            ...report,
            step,
            valueField: raw.report.valueField === undefined ? null : String(raw.report.valueField),
            successPath,
            successEquals,
            intervalSeconds: clampNumber(raw.report.intervalSeconds, 20, 5, 120)
        },
        finish: raw.finish === undefined ? null : normalizeRequest(raw.finish, `recipe "${raw.id}" finish`, allowed)
    };
}

export function parseRecipes(text) {
    const source = typeof text === "string" ? text.trim() : "";
    if (!source) return { recipes: [], errors: [] };
    if (source.length > MAX_DOCUMENT_LENGTH) {
        return { recipes: [], errors: [`Recipe document is longer than ${MAX_DOCUMENT_LENGTH} characters`] };
    }

    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (error) {
        return { recipes: [], errors: [`Recipe document is not valid JSON: ${error.message}`] };
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    const recipes = [];
    const errors = [];
    const seen = new Set();
    list.forEach((raw, index) => {
        try {
            const recipe = normalizeRecipe(raw, index);
            if (seen.has(recipe.id)) throw new Error(`duplicate recipe id "${recipe.id}"`);
            seen.add(recipe.id);
            recipes.push(recipe);
        } catch (error) {
            errors.push(error.message);
        }
    });
    return { recipes, errors };
}

export function describeRecipes(text) {
    const { recipes, errors } = parseRecipes(text);
    if (errors.length) return `${errors.length} problem(s): ${errors[0]}`;
    if (!recipes.length) return "No custom adapters.";
    return `${recipes.length} custom adapter(s): ${recipes.map(recipe => recipe.id).join(", ")}`;
}

function fill(template, values) {
    return String(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key) => String(values[key] ?? ""));
}

/** Keeps numbers as numbers when a placeholder is the whole value. */
function substitute(value, values) {
    if (typeof value === "string") {
        const exact = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(value);
        if (exact) {
            const replacement = values[exact[1]];
            return typeof replacement === "number" ? replacement : String(replacement ?? "");
        }
        return fill(value, values);
    }
    if (Array.isArray(value)) return value.map(item => substitute(item, values));
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = substitute(item, values);
        return out;
    }
    return value;
}

function readPath(source, path) {
    if (!path) return undefined;
    return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), source);
}

/** Accepts "token", "body.token" or "response.body.token" so a recipe need not guess. */
function savedValue(response, path) {
    const candidates = [path];
    if (path.startsWith("body.")) candidates.push(path.slice("body.".length));
    if (path.startsWith("response.")) candidates.push(path.slice("response.".length));
    for (const candidate of candidates) {
        for (const source of [response.body, response]) {
            const value = readPath(source, candidate);
            if (value !== undefined && value !== null) return value;
        }
    }
    return undefined;
}

/**
 * A quest can carry more than one application id: the one Discord shows in its config and the
 * ones listed on the task itself. The activity handshake needs the task application, so a
 * recipe matches when any of them is listed instead of only the first one.
 */
function applicationCandidates(context) {
    const list = Array.isArray(context?.applicationIds) && context.applicationIds.length
        ? context.applicationIds
        : [context?.applicationId];
    return list.map(id => String(id ?? ""));
}

function matches(recipe, quest, context) {
    const { taskType, eventName } = context;
    if (recipe.match.applicationId.length) {
        const candidates = applicationCandidates(context);
        if (!recipe.match.applicationId.some(id => candidates.includes(id))) return false;
    }
    if (recipe.match.questId.length && !recipe.match.questId.includes(String(quest.id))) return false;
    if (recipe.match.taskType.length && !recipe.match.taskType.includes(String(taskType ?? ""))) return false;
    if (recipe.match.eventName.length && !recipe.match.eventName.includes(String(eventName ?? ""))) return false;
    return true;
}

export function createRecipeAdapter(recipe, { native, grantActivity }) {
    return {
        id: `recipe:${recipe.id}`,
        matchesQuest(quest, context) {
            return matches(recipe, quest, context);
        },
        /** The application id the recipe was written for, when it named one. */
        applicationIdFor(context) {
            if (!recipe.match.applicationId.length) return null;
            const candidates = applicationCandidates(context);
            return recipe.match.applicationId.find(id => candidates.includes(id)) ?? null;
        },
        async run({ quest, task, applicationId, taskType, eventName, isCurrent, signal, log, warn, getToken, sleep }) {
            if (typeof native?.request !== "function") throw new Error("Dorion native HTTP is unavailable");
            const target = Math.max(1, Number(task?.target) || 1);
            const step = recipe.report.step === "target" ? target : Math.max(1, recipe.report.step);
            const saved = {};
            const values = extra => ({
                questId: quest.id,
                applicationId: applicationId ?? "",
                target,
                eventName: eventName ?? "",
                ...saved,
                ...extra
            });
            const questName = quest.config?.messages?.questName;

            async function send(request, extra) {
                const substitutions = values(extra);
                const headers = { "Content-Type": "application/json", ...substitute(request.headers, substitutions) };
                if (request.auth !== "none") {
                    const token = getToken?.();
                    if (!token) throw new Error("Discord authentication is unavailable");
                    headers.Authorization = token;
                }
                const body = request.body === undefined ? undefined : substitute(request.body, substitutions);
                const response = await native.request(fill(request.url, substitutions), {
                    method: request.method,
                    headers,
                    body,
                    signal
                });
                if (response.status === 429) {
                    const retryAfter = Number(response.body?.retry_after);
                    await sleep(((Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 10) + 1) * 1000);
                    return { ok: false, status: 429, body: response.body };
                }
                if (!response.ok) throw new Error(`Recipe request rejected (${describeResponse(response)})`);
                return response;
            }

            /**
             * Setup requests are retried the way the activity's own client retries them: its
             * register and authorize calls run in a three attempt loop, because a first call for
             * a session can fail and succeed immediately afterwards.
             */
            async function sendSetup(request) {
                let lastError;
                for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt++) {
                    if (!isCurrent()) return null;
                    try {
                        return await send(request);
                    } catch (error) {
                        lastError = error;
                        if (attempt < SETUP_ATTEMPTS) {
                            log(`[${questName}] ${request.method} ${new URL(fill(request.url, values())).pathname} failed (attempt ${attempt}/${SETUP_ATTEMPTS}): ${error.message}`);
                            await sleep(1000 * attempt);
                        }
                    }
                }
                throw lastError;
            }

            const cleanups = [];
            try {
            for (const setupStep of recipe.setup) {
                if (setupStep.kind === "activityAuthorize") {
                    if (typeof grantActivity !== "function") throw new Error("Activity authorization is unavailable in recipes here");
                    const authorization = await grantActivity({
                        applicationId,
                        questId: quest.id,
                        isCurrent,
                        signal,
                        warn,
                        headers: substitute(setupStep.headers, values()),
                        body: substitute(setupStep.body, values())
                    });
                    cleanups.push(authorization.cleanup);
                    for (const [name, path] of Object.entries(setupStep.save)) {
                        const value = readPath({ ...authorization }, path);
                        if (value === undefined || value === null) throw new Error(`Activity authorization did not provide ${path}`);
                        saved[name] = value;
                    }
                    log(`[${questName}] Activity authorization ready`);
                    continue;
                }
                const response = await sendSetup(setupStep);
                if (!response || !isCurrent()) return;
                for (const [name, path] of Object.entries(setupStep.save)) {
                    const value = savedValue(response, path);
                    if (value === undefined) throw new Error(`Recipe setup did not return ${path}`);
                    saved[name] = value;
                }
                log(`[${questName}] Recipe setup: ${setupStep.method} ${new URL(fill(setupStep.url, values())).pathname}`);
            }

            let value = Number(quest.userStatus?.progress?.[taskType]?.value) || 0;
            const maxAttempts = Math.min(200, Math.ceil((target - value) / step) + 2);
            for (let attempt = 1; attempt <= maxAttempts && isCurrent(); attempt++) {
                value = Math.min(target, value + step);
                const response = await send(recipe.report, { value, attempt });
                if (!isCurrent()) return;
                if (response.status === 429) {
                    value = Math.max(0, value - step);
                    continue;
                }
                if (recipe.report.successPath) {
                    const actual = readPath(response.body, recipe.report.successPath);
                    if (String(actual) !== recipe.report.successEquals) {
                        throw new Error(`Recipe progress was not accepted (server said ${JSON.stringify(actual ?? null)})`);
                    }
                }
                const reported = Number(readPath(response.body, recipe.report.valueField));
                if (Number.isFinite(reported) && reported > 0) value = reported;
                log(`[${questName}] Progress: ${value}/${target}`);
                if (response.body?.completed_at != null || value >= target) break;
                await sleep(recipe.report.intervalSeconds * 1000);
            }

            if (recipe.finish && isCurrent()) {
                await send(recipe.finish, { value, attempt: maxAttempts });
            }
            } finally {
                for (const cleanup of cleanups.reverse()) {
                    try { await cleanup(); } catch { }
                }
            }
        }
    };
}
