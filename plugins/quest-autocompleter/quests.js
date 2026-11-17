/*
 * Adapted from the Vencord QuestAutocompleter plugin on 2026-11-16.
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function pick(source, ...keys) {
    if (!source || typeof source !== "object") return undefined;
    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
}

function normalizeTasks(taskConfig) {
    if (!taskConfig || typeof taskConfig !== "object") return undefined;
    const tasks = taskConfig.tasks;
    if (!tasks || typeof tasks !== "object") return { ...taskConfig };
    return { ...taskConfig, tasks: { ...tasks } };
}

function normalizeProgress(progress) {
    if (!progress || typeof progress !== "object") return {};
    const normalized = {};
    for (const [type, entry] of Object.entries(progress)) {
        const value = entry && typeof entry === "object" ? Number(entry.value) : Number(entry);
        normalized[type] = { ...(entry && typeof entry === "object" ? entry : {}), value: Number.isFinite(value) ? value : 0 };
    }
    return normalized;
}

/**
 * The Discord API answers in snake_case while every Discord store uses camelCase.
 * Feeding the raw payload straight back into a store corrupts it, so the plugin keeps
 * its own copy in the camelCase shape the rest of the engine already understands.
 */
export function normalizeQuest(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (typeof raw.id !== "string" || raw.id.length === 0) return null;

    const config = raw.config && typeof raw.config === "object" ? raw.config : {};
    const messages = config.messages && typeof config.messages === "object" ? config.messages : {};
    const application = config.application && typeof config.application === "object" ? config.application : undefined;

    const taskConfig = pick(config, "taskConfig", "taskConfigV2", "task_config_v2", "task_config");
    const normalizedConfig = {
        ...config,
        taskConfig: normalizeTasks(taskConfig),
        joinOperator: pick(taskConfig, "joinOperator", "join_operator") ?? "or",
        expiresAt: pick(config, "expiresAt", "expires_at") ?? null,
        configVersion: pick(config, "configVersion", "config_version") ?? 1,
        messages: { ...messages, questName: pick(messages, "questName", "quest_name") ?? "" },
        ...(application ? { application: { ...application, id: pick(application, "id") } } : {})
    };

    const rawStatus = pick(raw, "userStatus", "user_status");
    const userStatus = rawStatus && typeof rawStatus === "object"
        ? {
            ...rawStatus,
            enrolledAt: pick(rawStatus, "enrolledAt", "enrolled_at") ?? null,
            completedAt: pick(rawStatus, "completedAt", "completed_at") ?? null,
            claimedAt: pick(rawStatus, "claimedAt", "claimed_at") ?? null,
            streamProgressSeconds: pick(rawStatus, "streamProgressSeconds", "stream_progress_seconds") ?? 0,
            trafficMetadataSealed: pick(rawStatus, "trafficMetadataSealed", "traffic_metadata_sealed") ?? null,
            progress: normalizeProgress(rawStatus.progress)
        }
        : null;

    return { ...raw, id: raw.id, config: normalizedConfig, userStatus };
}
