/*
 * Declarative quest recipes.
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A recipe describes how a quest's own application reports progress, without running any
 * pasted code. It is validated before use and every request is restricted to Discord hosts,
 * so a recipe cannot redirect the account token somewhere else.
 */

const PLACEHOLDERS = ["questId", "applicationId", "target", "value", "attempt", "eventName"];
const FORBIDDEN_HEADERS = ["authorization", "cookie", "host"];
const METHODS = ["POST", "GET", "DELETE"];
const DISCORD_URL = /^https:\/\/discord\.com\/api\/v\d+\//;
const DISCORDS_SAYS_URL = /^https:\/\/\{applicationId\}\.discordsays\.com\//;
const MAX_DOCUMENT_LENGTH = 8000;

function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function checkPlaceholders(text, where) {
    for (const match of String(text).matchAll(/\{([A-Za-z]+)\}/g)) {
        if (!PLACEHOLDERS.includes(match[1])) {
            throw new Error(`Unknown placeholder {${match[1]}} in ${where}`);
        }
    }
}

function normalizeRequest(raw, where) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
    if (typeof raw.url !== "string") throw new Error(`${where}.url must be a string`);
    if (!DISCORD_URL.test(raw.url) && !DISCORDS_SAYS_URL.test(raw.url)) {
        throw new Error(`${where}.url must point at discord.com or {applicationId}.discordsays.com over https`);
    }
    checkPlaceholders(raw.url, `${where}.url`);

    const method = raw.method === undefined ? "POST" : String(raw.method).toUpperCase();
    if (!METHODS.includes(method)) throw new Error(`${where}.method must be POST, GET or DELETE`);

    const headers = raw.headers === undefined ? {} : raw.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error(`${where}.headers must be an object`);
    for (const key of Object.keys(headers)) {
        if (FORBIDDEN_HEADERS.includes(key.toLowerCase())) {
            throw new Error(`${where}.headers cannot set ${key}; the plugin owns Authorization, Cookie and Host`);
        }
    }
    checkPlaceholders(Object.values(headers).join(" "), `${where}.headers`);

    if (raw.body !== undefined) {
        if (!raw.body || typeof raw.body !== "object") throw new Error(`${where}.body must be an object`);
        checkPlaceholders(JSON.stringify(raw.body), `${where}.body`);
    }

    const auth = raw.auth === undefined ? "discord" : raw.auth;
    if (auth !== "discord" && auth !== "none") throw new Error(`${where}.auth must be "discord" or "none"`);

    return {
        url: raw.url,
        method,
        headers,
        body: raw.body,
        auth
    };
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

    const report = normalizeRequest(raw.report, `recipe "${raw.id}" report`);
    const step = raw.report.step === "target" ? "target" : clampNumber(raw.report.step, 1, 1, 100000);
    const valueField = raw.report.valueField === undefined ? null : String(raw.report.valueField);

    return {
        id: raw.id,
        match: conditions,
        report: {
            ...report,
            step,
            valueField,
            intervalSeconds: clampNumber(raw.report.intervalSeconds, 20, 5, 120)
        },
        finish: raw.finish === undefined ? null : normalizeRequest(raw.finish, `recipe "${raw.id}" finish`)
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
    return String(template).replace(/\{([A-Za-z]+)\}/g, (match, key) => String(values[key] ?? ""));
}

/** Keeps numbers as numbers when a placeholder is the whole value. */
function substitute(value, values) {
    if (typeof value === "string") {
        const exact = /^\{([A-Za-z]+)\}$/.exec(value);
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

function matches(recipe, quest, context) {
    const { applicationId, taskType, eventName } = context;
    if (recipe.match.applicationId.length && !recipe.match.applicationId.includes(String(applicationId ?? ""))) return false;
    if (recipe.match.questId.length && !recipe.match.questId.includes(String(quest.id))) return false;
    if (recipe.match.taskType.length && !recipe.match.taskType.includes(String(taskType ?? ""))) return false;
    if (recipe.match.eventName.length && !recipe.match.eventName.includes(String(eventName ?? ""))) return false;
    return true;
}

export function createRecipeAdapter(recipe, { native }) {
    return {
        id: `recipe:${recipe.id}`,
        matchesQuest(quest, context) {
            return matches(recipe, quest, context);
        },
        async run({ quest, task, applicationId, taskType, eventName, isCurrent, signal, log, getToken, sleep }) {
            if (typeof native?.request !== "function") throw new Error("Dorion native HTTP is unavailable");
            const target = Math.max(1, Number(task?.target) || 1);
            const step = recipe.report.step === "target" ? target : Math.max(1, recipe.report.step);
            const values = () => ({
                questId: quest.id,
                applicationId: applicationId ?? "",
                target,
                eventName: eventName ?? ""
            });

            async function send(request, extra) {
                const base = values();
                const substitutions = { ...base, ...extra };
                const headers = { "Content-Type": "application/json", ...request.headers };
                if (request.auth !== "none") {
                    const token = getToken?.();
                    if (!token) throw new Error("Discord authentication is unavailable");
                    headers.Authorization = token;
                }
                const body = request.body === undefined
                    ? undefined
                    : substitute(request.body, substitutions);
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
                if (!response.ok) throw new Error(`Recipe request rejected (status ${response.status})`);
                return response;
            }

            let value = Number(quest.userStatus?.progress?.[taskType]?.value) || 0;
            const questName = quest.config?.messages?.questName;
            const maxAttempts = Math.min(200, Math.ceil((target - value) / step) + 2);
            for (let attempt = 1; attempt <= maxAttempts && isCurrent(); attempt++) {
                value = Math.min(target, value + step);
                const response = await send(recipe.report, { value, attempt });
                if (!isCurrent()) return;
                if (response.status === 429) {
                    value = Math.max(0, value - step);
                    continue;
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
        }
    };
}
