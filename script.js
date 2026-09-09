import { games } from './data.js';

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").then(initSwStatus);
    });
} else {
    window.addEventListener("DOMContentLoaded", () => {
        const el = document.getElementById("sw-status");
        if (el) el.innerHTML = `<span class="sw-dot sw-off"></span>Offline mode not supported`;
    });
}

async function currentCacheVersion() {
    try {
        const keys = await caches.keys();
        const match = keys.find(k => k.startsWith("gacha-checklist-"));
        return match ? match.replace("gacha-checklist-", "") : "?";
    } catch (e) {
        return "?";
    }
}

async function initSwStatus() {
    const el = document.getElementById("sw-status");
    if (!el) return;

    const paint = async () => {
        const version = await currentCacheVersion();
        if (navigator.serviceWorker.controller) {
            el.innerHTML = `<span class="sw-dot sw-active"></span>Offline ready (${version})`;
        } else {
            // Registered but not yet controlling this page (first-ever load).
            el.innerHTML = `<span class="sw-dot sw-pending"></span>Offline mode starting&hellip; (${version})`;
        }
    };

    paint();

    // Fires once a new service worker takes over - i.e. an update finished
    // installing and activated. Since sw.js calls skipWaiting()+clients.claim(),
    // this happens automatically without the user doing anything.
    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshed) return;
        refreshed = true;
        paint().then(async () => {
            const version = await currentCacheVersion();
            el.innerHTML = `<span class="sw-dot sw-active"></span>Updated to ${version} &mdash; <a href="#" class="sw-reload-link" onclick="location.reload();return false;">reload to apply</a>`;
        });
    });
}

// Ask the browser to exempt this site's storage from automatic eviction.
// Supported on Chrome/Android/desktop; Safari has no such API, so this is a
// harmless no-op there (feature-detected, never throws).
if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist();
}

const STORAGE_KEY = "gacha_pwa_v1";

const TASK_LIST_TYPES = [["daily", "d"], ["weekly", "w"], ["monthly", "m"], ["abyss", "a"]];

// Walks every task across every game/list, calling cb(game, type, index, task)
// for the ones flagged `optional: true` in data.js.
function forEachOptionalTask(cb) {
    games.forEach(g => {
        TASK_LIST_TYPES.forEach(([key, type]) => {
            (g[key] || []).forEach((t, i) => {
                if (typeof t === "object" && t.optional) cb(g, type, i, t);
            });
        });
    });
}

function defaultHiddenIds() {
    const ids = [];
    forEachOptionalTask((g, type, i) => ids.push(`${g.id}-${type}-${i}`));
    return ids;
}

// Defaults for every field state can hold. Loading merges saved data OVER
// this, field by field, so a save from an older version of the app (missing
// newer fields) still ends up with valid defaults instead of `undefined` -
// no manual "if (!state.x) ..." patch needed per field going forward.
const DEFAULT_STATE = {
    checked: {},
    // Optional items are opt-in: a brand-new install starts with them all
    // hidden so the checklist isn't cluttered by default.
    hidden: defaultHiddenIds(),
    menus: [],
    collapsed: [],
    hideMonthly: false,
    hideTimers: false,
    activeGame: null,
    activeType: "d",
    appTab: "checklist",
    lastD: 0,
    lastW: 0,
    lastM: 0,
    lastAbyss: 0,
    lastTheater: 0,
    challengeEnabled: true,
    // Tracks the start time we last saw for each HSR/ZZZ challenge, keyed
    // by "<gid>-a-<type_name>" - used to notice when a new cycle begins and
    // clear that one checkbox, since there's no fixed reset cadence for
    // live-service content with no data.js entry.
    challengeStarts: {},
    gwEnabled: true,
    gwDays: [null, null, null, null, null, null, null],
    gwPoints: 0,
    // Fixed anchor: Monday 2026-11-02 04:00 local, matching the existing
    // Monday 4am weekly-reset boundary (verified: 69d15h out from the
    // reference date the requirement was written against).
    gwCycleEnd: new Date("2026-11-02T04:00:00").getTime(),
    up: null,
    upTs: 0,
    rs: null,
};

function normalizeState(merged) {
    if (!Array.isArray(merged.gwDays) || merged.gwDays.length !== 7) {
        merged.gwDays = [...DEFAULT_STATE.gwDays];
    } else if (typeof merged.gwDays[0] === "boolean") {
        // Migrate from the old boolean-per-day model.
        merged.gwDays = merged.gwDays.map(v => v ? "done" : null);
    }
    return merged;
}

function loadState() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
        saved = {};
    }
    return normalizeState({ ...DEFAULT_STATE, ...saved });
}

let state = loadState();

// --- Cross-device sync (optional, via a small user-hosted Cloudflare Worker) ---
// The worker URL + PIN are device config, not app data, so they live in their
// own localStorage key and never get pushed/pulled as part of `state` itself.
const SYNC_CFG_KEY = "gacha_sync_cfg";

function loadSyncCfg() {
    try {
        return JSON.parse(localStorage.getItem(SYNC_CFG_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function saveSyncCfg(cfg) {
    localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(cfg));
}

function syncEndpoint(cfg) {
    return `${cfg.workerUrl}/state/${encodeURIComponent(cfg.pin)}`;
}

let syncBusy = false;
let syncPushTimer = null;

function setSyncStatus(html) {
    const el = document.getElementById("sync-status");
    if (el) el.innerHTML = html;
}

function renderSyncStatus() {
    const cfg = loadSyncCfg();
    if (!cfg.enabled || !cfg.workerUrl || !cfg.pin) {
        setSyncStatus(`<span class="sw-dot sw-off"></span>Sync off`);
        return;
    }
    if (syncBusy) {
        setSyncStatus(`<span class="sw-dot sw-pending"></span>Syncing&hellip;`);
        return;
    }
    if (cfg.lastError) {
        setSyncStatus(`<span class="sw-dot sw-off"></span>Sync error &mdash; ${cfg.lastError}`);
        return;
    }
    if (cfg.lastSyncedAt) {
        const secsAgo = Math.max(0, Math.round((Date.now() - cfg.lastSyncedAt) / 1000));
        const when = secsAgo < 5 ? "just now" : secsAgo < 60 ? `${secsAgo}s ago` : `${Math.round(secsAgo / 60)}m ago`;
        setSyncStatus(`<span class="sw-dot sw-active"></span>Synced ${when}`);
        return;
    }
    setSyncStatus(`<span class="sw-dot sw-pending"></span>Sync on &mdash; waiting for first sync`);
}

async function syncPush() {
    const cfg = loadSyncCfg();
    if (!cfg.enabled || !cfg.workerUrl || !cfg.pin) return;
    syncBusy = true;
    renderSyncStatus();
    try {
        const res = await fetch(syncEndpoint(cfg), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cfg.lastSyncedAt = Date.now();
        cfg.lastPushedTs = state.upTs || 0;
        cfg.lastError = null;
    } catch (e) {
        cfg.lastError = "couldn't reach worker";
    }
    saveSyncCfg(cfg);
    syncBusy = false;
    renderSyncStatus();
}

function scheduleSyncPush() {
    const cfg = loadSyncCfg();
    if (!cfg.enabled || !cfg.workerUrl || !cfg.pin) return;
    clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(syncPush, 2000);
}

async function syncPull() {
    const cfg = loadSyncCfg();
    if (!cfg.enabled || !cfg.workerUrl || !cfg.pin) return;
    syncBusy = true;
    renderSyncStatus();
    try {
        const res = await fetch(syncEndpoint(cfg));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const remote = await res.json();
        if (remote && (remote.upTs || 0) > (state.upTs || 0)) {
            state = normalizeState({ ...DEFAULT_STATE, ...remote });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            buildDashboard();
        }
        cfg.lastSyncedAt = Date.now();
        cfg.lastError = null;
    } catch (e) {
        cfg.lastError = "couldn't reach worker";
    }
    saveSyncCfg(cfg);
    syncBusy = false;
    renderSyncStatus();
}

window.setupSync = () => {
    const cfg = loadSyncCfg();
    const url = prompt("Cloudflare Worker URL (see sync-worker/README.md to deploy one):", cfg.workerUrl || "");
    if (url === null) return;
    const pin = prompt("Sync PIN - use the same one on every device (6+ characters):", cfg.pin || "");
    if (pin === null) return;
    saveSyncCfg({ workerUrl: url.trim().replace(/\/+$/, ""), pin: pin.trim(), enabled: true, lastSyncedAt: null, lastError: null });
    updateMenu();
    syncTick();
};

window.disableSync = () => {
    const cfg = loadSyncCfg();
    cfg.enabled = false;
    saveSyncCfg(cfg);
    updateMenu();
    renderSyncStatus();
};

window.syncNow = () => {
    syncTick();
};

// A push can fail (device was offline, worker unreachable) and nothing
// automatically retries it until the next edit reschedules one. Piggyback a
// retry on every pull tick instead, but only when there's actually something
// unpushed - otherwise every idle tick would burn into the free tier's daily
// write quota for no reason.
async function syncTick() {
    await syncPull();
    const cfg = loadSyncCfg();
    if (!cfg.enabled || !cfg.workerUrl || !cfg.pin) return;
    if (cfg.lastError || (state.upTs || 0) > (cfg.lastPushedTs || 0)) {
        await syncPush();
    }
}

function startSyncLoop() {
    renderSyncStatus();
    syncTick();
    setInterval(() => {
        if (document.visibilityState === "visible") syncTick();
    }, 20000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") syncTick();
    });
    setInterval(renderSyncStatus, 5000);
}

// --- Push notifications (optional, via the same Cloudflare Worker as Sync) ---
// A push subscription is per-browser and non-transferable, unlike Sync's
// PIN (which is deliberately shared across a user's devices) - so this
// gets its own random device id instead of reusing the PIN, and works
// whether or not Sync itself is turned on. It does still reuse Sync's
// `workerUrl` (same Worker, different route), prompting for one the first
// time if Sync was never set up.
const PUSH_CFG_KEY = "gacha_push_cfg";
// Public VAPID key - safe to ship client-side (see sync-worker/README.md
// for how this pairs with the Worker's private half).
const VAPID_PUBLIC_KEY = "BFVO-gPPY_TAjY7CBfd_-ILyaSM2XkJswdn60yIGkjRO2FcvMvC_wW9CGoBoBwpccHZXbf1ixq9_Tx-pkfcjuuU";

function loadPushCfg() {
    try {
        return JSON.parse(localStorage.getItem(PUSH_CFG_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function savePushCfg(cfg) {
    localStorage.setItem(PUSH_CFG_KEY, JSON.stringify(cfg));
}

function pushEndpoint(deviceId) {
    return `${loadSyncCfg().workerUrl}/push/${encodeURIComponent(deviceId)}`;
}

function getWorkerUrl() {
    const syncCfg = loadSyncCfg();
    if (syncCfg.workerUrl) return syncCfg.workerUrl;
    const url = prompt("Cloudflare Worker URL (see sync-worker/README.md to deploy one):", "");
    if (!url) return null;
    const trimmed = url.trim().replace(/\/+$/, "");
    saveSyncCfg({ ...syncCfg, workerUrl: trimmed });
    return trimmed;
}

// "17:00" -> the next absolute timestamp that time occurs at in local time
// (today if still ahead of `now`, otherwise tomorrow) - the same trick
// getReset() uses for daily/weekly/monthly boundaries, generalized to an
// arbitrary time of day so the Worker never has to do timezone math itself.
function resolveCheckpoint(hhmm, now = new Date()) {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
}

// Sums done/total across all games' *daily* tasks only (same hidden-task
// exclusion taskCounts() uses for its per-game count) - what the
// low-progress nudge checks against.
function dailyProgressPct() {
    let done = 0, total = 0;
    games.forEach(g => {
        g.daily.forEach((t, i) => {
            const id = `${g.id}-d-${i}`;
            if (state.hidden.includes(id)) return;
            total++;
            if (state.checked[id]) done++;
        });
    });
    return total === 0 ? 100 : Math.round((done / total) * 100);
}

let pushUpdateTimer = null;

async function pushSubscribeUpdate(overrides = {}) {
    const cfg = loadPushCfg();
    if (!cfg.deviceId || !cfg.subscribed) return;
    const workerUrl = loadSyncCfg().workerUrl;
    if (!workerUrl) return;

    const now = new Date();
    const body = {
        prefs: cfg.prefs,
        resetAt: { daily: getReset("d"), weekly: getReset("w"), monthly: getReset("m") },
        checkpoints: (cfg.checkpoints || []).map(t => ({ time: t, at: resolveCheckpoint(t, now) })),
        dailyProgressPct: dailyProgressPct(),
        ...overrides,
    };
    try {
        await fetch(pushEndpoint(cfg.deviceId), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch (e) {
        // Best-effort - the next refresh (app load, or the next save()) tries again.
    }
}

// Debounced the same way scheduleSyncPush() is - called from window.save()
// so the Worker's copy of "how much progress today" stays fresh while the
// app is actually open, without a request on every single checkbox click.
function schedulePushProgressUpdate() {
    if (!loadPushCfg().subscribed) return;
    clearTimeout(pushUpdateTimer);
    pushUpdateTimer = setTimeout(pushSubscribeUpdate, 2000);
}

function urlBase64ToUint8Array(base64) {
    const bin = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

window.enablePushNotifications = async () => {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        alert("Push notifications aren't supported in this browser.");
        return;
    }
    const workerUrl = getWorkerUrl();
    if (!workerUrl) return;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
        updateMenu();
        return;
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const cfg = loadPushCfg();
    cfg.deviceId = cfg.deviceId || crypto.randomUUID();
    cfg.subscribed = true;
    cfg.prefs = cfg.prefs || { daily: true, weekly: true, monthly: true, nudges: false };
    cfg.checkpoints = cfg.checkpoints && cfg.checkpoints.length ? cfg.checkpoints : ["17:00", "20:00"];
    savePushCfg(cfg);

    await pushSubscribeUpdate({ subscription: subscription.toJSON() });
    updateMenu();
};

window.togglePushPref = (type) => {
    const cfg = loadPushCfg();
    cfg.prefs[type] = !cfg.prefs[type];
    if (type === "nudges" && cfg.prefs.nudges && (!cfg.checkpoints || cfg.checkpoints.length === 0)) {
        cfg.checkpoints = ["17:00", "20:00"];
    }
    savePushCfg(cfg);
    pushSubscribeUpdate();
    updateMenu();
};

window.addPushCheckpoint = () => {
    const input = prompt("Check-in time (24h, HH:MM, your local time):", "17:00");
    if (input === null) return;
    const trimmed = input.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
        alert("Please enter a time as HH:MM, 24-hour (e.g. 17:00).");
        return;
    }
    const cfg = loadPushCfg();
    cfg.checkpoints = cfg.checkpoints || [];
    if (!cfg.checkpoints.includes(trimmed)) cfg.checkpoints.push(trimmed);
    savePushCfg(cfg);
    pushSubscribeUpdate();
    updateMenu();
};

window.removePushCheckpoint = (time) => {
    const cfg = loadPushCfg();
    cfg.checkpoints = (cfg.checkpoints || []).filter(t => t !== time);
    savePushCfg(cfg);
    pushSubscribeUpdate();
    updateMenu();
};

window.disablePushNotifications = async () => {
    const cfg = loadPushCfg();
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
    } catch (e) {
        // Ignore - still clear local state and tell the Worker below.
    }
    const workerUrl = loadSyncCfg().workerUrl;
    if (cfg.deviceId && workerUrl) {
        try { await fetch(pushEndpoint(cfg.deviceId), { method: "DELETE" }); } catch (e) {}
    }
    savePushCfg({ ...cfg, subscribed: false });
    updateMenu();
};

// Called once per app load (getReset()/resolveCheckpoint() are always
// forward-looking, so a value that's a few hours stale from the last
// session is still correct until it actually fires).
function refreshPushSchedule() {
    if (loadPushCfg().subscribed) pushSubscribeUpdate();
}

// --- Live Banners (optional, via a public fan-maintained HoYoverse API) ---
// This is read-only reference info, not app data - it isn't tracked in
// `state` (no checked/hidden/reset logic applies) and isn't synced across
// devices, since it's the same for everyone. Cached separately in
// localStorage so switching to the tab feels instant after the first load,
// and so a transient network hiccup doesn't blank out otherwise-good data.
// This relies on an unofficial third-party API (not run by HoYoverse or us)
// - if it's ever down or changes shape, fetchBanners() falls back to
// whatever's cached, or an empty list rather than breaking the page.
const BANNER_ENDPOINTS = {
    gi: "https://api.ennead.cc/mihoyo/genshin/calendar",
    hsr: "https://api.ennead.cc/mihoyo/starrail/calendar",
    zzz: "https://api.ennead.cc/mihoyo/zenless/calendar",
};
const BANNER_TARGETS = [
    { gid: "gi", style: "gi-theme", name: "Genshin Impact" },
    { gid: "hsr", style: "hsr-theme", name: "Honkai: Star Rail" },
    { gid: "zzz", style: "zzz-theme", name: "Zenless Zone Zero" },
];
const BANNER_CACHE_KEY = "gacha_banners_cache";
const BANNER_CACHE_MAX_AGE = 15 * 60 * 1000;
// Bump this whenever normalizeBanners()/normalizeChallenges() change shape
// (e.g. the HSR type_name->mode-name mapping). Otherwise a device with
// data already cached under the old shape keeps showing it for up to 15
// more minutes after a code update goes live, since the cache is still
// "fresh" from the code's perspective - a version mismatch here forces an
// immediate re-fetch instead of waiting on that window to expire.
const BANNER_CACHE_VERSION = 6;

function loadBannerCache() {
    try {
        const cache = JSON.parse(localStorage.getItem(BANNER_CACHE_KEY)) || {};
        return cache.__v === BANNER_CACHE_VERSION ? cache : {};
    } catch (e) {
        return {};
    }
}

function saveBannerCache(cache) {
    try {
        cache.__v = BANNER_CACHE_VERSION;
        localStorage.setItem(BANNER_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        // Ignore - worst case the next load just re-fetches.
    }
}

// Each game's API shapes banners differently (field names, rarity as a
// number vs a letter grade, no `name` at all for HSR) - this normalizes all
// three into the same {label, items, startTime, endTime, state} shape the
// renderer expects. Keeps both the currently-live banners and whatever
// phase comes next (HSR/ZZZ's API includes the next phase's real
// start/end ahead of time; GI's only posts one phase at a time), dropping
// only ones that have already fully ended.
function normalizeBanners(gameKey, raw) {
    const now = Date.now();
    const all = (raw.banners || [])
        .map(b => ({ ...b, start_time: b.start_time * 1000, end_time: b.end_time * 1000 }))
        .filter(b => now <= b.end_time);
    const state = (b) => b.start_time <= now ? "live" : "upcoming";

    if (gameKey === "gi") {
        return all.map(b => ({
            label: b.name,
            items: [...b.characters, ...b.weapons].map(x => ({ name: x.name, icon: x.icon, top: x.rarity === 5 })),
            startTime: b.start_time,
            endTime: b.end_time,
            state: state(b),
        }));
    }
    if (gameKey === "hsr") {
        const seen = { character: 0, weapon: 0 };
        return all.map(b => {
            const isChar = b.characters.length > 0;
            const kind = isChar ? "character" : "weapon";
            seen[kind]++;
            const base = isChar ? "Character Event Warp" : "Light Cone Event Warp";
            return {
                label: seen[kind] > 1 ? `${base} ${seen[kind]}` : base,
                items: [...b.characters, ...(b.light_cones || [])].map(x => ({ name: x.name, icon: x.icon, top: x.rarity === 5 })),
                startTime: b.start_time,
                endTime: b.end_time,
                state: state(b),
            };
        });
    }
    // zzz
    const zzzSeen = {};
    return all.map(b => {
        const isChar = b.banner_type.includes("CHARACTER");
        const isRerun = b.banner_type.includes("RETURN");
        const base = (isChar ? "Exclusive Channel" : "W-Engine Channel") + (isRerun ? " (Rerun)" : "");
        zzzSeen[base] = (zzzSeen[base] || 0) + 1;
        return {
            label: zzzSeen[base] > 1 ? `${base} ${zzzSeen[base]}` : base,
            items: [...(b.agents || []), ...(b.w_engines || [])].map(x => ({ name: x.name, icon: x.icon, top: x.rarity === "S" })),
            startTime: b.start_time,
            endTime: b.end_time,
            state: state(b),
        };
    });
}

// The same calendar response also lists ordinary limited-time events (side
// activities, login bonuses, etc.) with real start/end times - shown as
// cards in the Calendar tab. A couple of entries come back with
// start_time/end_time both 0 (looks like a data glitch on the API's end,
// not a real perpetual event) - dropped here.
function normalizeEvents(raw) {
    return (raw.events || [])
        .filter(e => e.end_time > 0)
        .map(e => ({
            name: e.name,
            startTime: e.start_time * 1000,
            endTime: e.end_time * 1000,
            imageUrl: e.image_url || "",
            specialReward: e.special_reward
                ? { name: e.special_reward.name, icon: e.special_reward.icon, amount: e.special_reward.amount }
                : null,
            rewards: (e.rewards || []).map(r => ({ name: r.name, icon: r.icon, amount: r.amount })),
        }));
}

// The same calendar response also lists live-service "challenges" (Spiral
// Abyss, Imaginarium Theater, Pure Fiction, Shiyu Defense, etc.) with real
// start/end times - used by the Abyss tab below so it doesn't have to guess
// reset cadences. Kept generic (name/startTime/endTime only) since the
// shape is consistent across all three games.
// Unlike GI/ZZZ, HSR's API returns the specific rotating title for each
// challenge (e.g. "Celestial Lupine") rather than the mode name - but
// `type_name` is a stable category that maps to a real mode name.
// Confirmed against the live game (2026-09): ChallengeTypeStory covers two
// simultaneous entries (Pure Fiction's two phases), so duplicates get
// numbered the same way repeated banners already are elsewhere.
const HSR_CHALLENGE_TYPE_NAMES = {
    ChallengeTypeBoss: "Apocalyptic Shadow",
    ChallengeTypePeak: "Anomaly Arbitration",
    ChallengeTypeChasm: "Memory of Chaos",
    ChallengeTypeStory: "Pure Fiction",
};

function normalizeChallenges(gameKey, raw) {
    const seen = {};
    const keyCount = {};
    return (raw.challenges || []).map(c => {
        let label = c.name;
        if (gameKey === "hsr") {
            const base = HSR_CHALLENGE_TYPE_NAMES[c.type_name] || c.name;
            seen[base] = (seen[base] || 0) + 1;
            label = seen[base] > 1 ? `${base} ${seen[base]}` : base;
        }
        // `type_name` (ZZZ's is already a stable slug like "deadly_assault")
        // is a durable identity across cycles, unlike the specific rotating
        // title - lets HSR/ZZZ challenges be checkable despite their name
        // changing every cycle. Duplicates (HSR's two Pure Fiction phases)
        // get their own suffixed key so they don't share one checkbox.
        const rawKey = c.type_name || c.name;
        keyCount[rawKey] = (keyCount[rawKey] || 0) + 1;
        const key = keyCount[rawKey] > 1 ? `${rawKey}-${keyCount[rawKey]}` : rawKey;
        return {
            name: label,
            key,
            startTime: c.start_time * 1000,
            endTime: c.end_time ? c.end_time * 1000 : null,
        };
    });
}

// HSR/ZZZ challenges have no fixed data.js entry to key a reset cadence
// off of (unlike GI's Abyss/Theater), so instead this notices when a
// challenge's own start time changes - meaning a new cycle began - and
// clears that specific checkbox then, rather than on any calendar cadence.
function reconcileChallengeChecks(gid, challenges) {
    if (gid === "gi") return; // GI's Abyss/Theater use their own reset checks
    let changed = false;
    challenges.forEach(c => {
        const key = `${gid}-a-${c.key}`;
        if (state.challengeStarts[key] !== c.startTime) {
            delete state.checked[key];
            state.challengeStarts[key] = c.startTime;
            changed = true;
        }
    });
    if (changed) window.save();
}

async function fetchBanners(gameKey, force = false) {
    const cache = loadBannerCache();
    const entry = cache[gameKey];
    if (!force && entry && Date.now() - entry.fetchedAt < BANNER_CACHE_MAX_AGE) {
        return entry;
    }
    try {
        const res = await fetch(BANNER_ENDPOINTS[gameKey]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const updated = { banners: normalizeBanners(gameKey, raw), challenges: normalizeChallenges(gameKey, raw), events: normalizeEvents(raw), fetchedAt: Date.now(), error: null };
        reconcileChallengeChecks(gameKey, updated.challenges);
        cache[gameKey] = updated;
        saveBannerCache(cache);
        return updated;
    } catch (e) {
        return entry || { banners: [], challenges: [], events: [], fetchedAt: 0, error: "load-failed" };
    }
}

// Looks up one challenge's live/upcoming/ended status from whatever's
// cached - never fetches itself, so it's cheap to call from a render path.
function getChallengeStatus(gid, apiName) {
    const entry = loadBannerCache()[gid];
    const c = entry && entry.challenges && entry.challenges.find(x => x.name === apiName);
    if (!c) return null;
    const now = Date.now();
    if (now < c.startTime) return { state: "upcoming", text: `Starts in ${bannerCountdown(c.startTime)}` };
    if (!c.endTime || now <= c.endTime) return { state: "live", text: c.endTime ? `Ends in ${bannerCountdown(c.endTime)}` : "Live now" };
    return { state: "ended", text: "Recently ended" };
}

function bannerCountdown(endTime) {
    const msLeft = Math.max(0, endTime - Date.now());
    const days = Math.floor(msLeft / 86400000);
    const hours = Math.floor((msLeft % 86400000) / 3600000);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function renderBannerBlock(b) {
    const isUpcoming = b.state === "upcoming";
    const countdown = isUpcoming ? `Starts in ${bannerCountdown(b.startTime)}` : `Ends in ${bannerCountdown(b.endTime)}`;

    return `
    <div class="banner-block ${isUpcoming ? "banner-block-upcoming" : ""}">
        <div class="banner-block-header">
            <span class="banner-block-label">${b.label}</span>
            <span class="banner-block-countdown">${countdown}</span>
        </div>
        <div class="banner-chars">
            ${b.items.map(it => `
                <div class="banner-char ${it.top ? "banner-char-top" : ""}">
                    <span class="banner-char-icon"><img src="${it.icon}" alt="${it.name}" loading="lazy"></span>
                    <span class="banner-char-name">${it.name}</span>
                </div>`).join("")}
        </div>
    </div>`;
}

function renderBannerCard(target, result) {
    let body;
    if (result.error) {
        body = `<div class="banner-empty">Couldn&rsquo;t load banners &mdash; try again later.</div>`;
    } else if (result.loading) {
        body = `<div class="banner-empty">Loading&hellip;</div>`;
    } else {
        const live = result.banners.filter(b => b.state !== "upcoming");
        const upcoming = result.banners.filter(b => b.state === "upcoming");
        body = live.length > 0
            ? `<div class="banner-blocks">${live.map(renderBannerBlock).join("")}</div>`
            : `<div class="banner-empty">No active banners right now.</div>`;
        if (upcoming.length > 0) {
            body += `
            <div class="banner-section-label">Upcoming</div>
            <div class="banner-blocks">${upcoming.map(renderBannerBlock).join("")}</div>`;
        }
    }

    return `
    <div class="banner-game-card ${target.style}">
        <div class="game-header">
            <h2 class="game-title">${target.name}</h2>
        </div>
        <div class="banner-card-body">${body}</div>
    </div>`;
}

// Banners follows the same single-active-game model as the checklist - the
// sidebar pills are the only game switcher needed, so this only ever shows
// the currently selected game instead of every game stacked at once.
async function renderBannersView() {
    const el = document.getElementById("banners-view");
    if (!el) return;

    const target = BANNER_TARGETS.find(t => t.gid === state.activeGame);
    if (!target) {
        el.innerHTML = `<div class="banner-empty">No banner data available for this game.</div>`;
        return;
    }

    const cache = loadBannerCache();
    el.innerHTML = renderBannerCard(target, cache[target.gid] || { loading: true });

    const result = await fetchBanners(target.gid);
    // The user may have switched games, or back to the checklist tab,
    // while this was in flight - only repaint if still relevant.
    if (state.appTab === "banners" && state.activeGame === target.gid) {
        el.innerHTML = renderBannerCard(target, result);
    }
}

const calendarDate = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });

function calendarEventStatus(e) {
    const now = Date.now();
    if (now < e.startTime) return { state: "upcoming", text: `Starts in ${bannerCountdown(e.startTime)}` };
    if (now <= e.endTime) return { state: "live", text: `Ends in ${bannerCountdown(e.endTime)}` };
    return { state: "ended", text: "Ended" };
}

// Capped to roughly what fits in the single row the card reserves for
// them (see .event-reward-row) - the special reward (usually Primogems)
// always leads since it's the one worth actually noticing.
const CALENDAR_REWARD_CAP = 5;

// Always renders the row, even with zero rewards (ZZZ's events carry no
// reward data at all) - the card reserves this space regardless, so an
// empty row here just means that space stays blank instead of the card
// itself changing shape.
function renderRewardChips(e) {
    const items = [...(e.specialReward ? [e.specialReward] : []), ...(e.rewards || [])];
    const shown = items.slice(0, CALENDAR_REWARD_CAP);
    const overflow = items.length - shown.length;
    const chips = shown.map(r => `
        <span class="event-reward-chip" title="${r.name}${r.amount ? ` x${r.amount}` : ""}">
            <img src="${r.icon}" alt="${r.name}" loading="lazy">
            ${r.amount ? `<span class="event-reward-amount">${r.amount}</span>` : ""}
        </span>`).join("");
    const more = overflow > 0 ? `<span class="event-reward-chip event-reward-more">+${overflow}</span>` : "";

    return `<div class="event-reward-row">${chips}${more}</div>`;
}

function renderEventCard(e) {
    const status = calendarEventStatus(e);
    const image = e.imageUrl
        ? `<div class="event-card-image" style="background-image: url('${e.imageUrl}')"></div>`
        : "";

    return `
    <div class="event-card">
        ${image}
        <div class="event-card-body">
            <div class="event-card-top-group">
                <div class="event-card-top">
                    <h3 class="event-card-name">${e.name}</h3>
                    <span class="event-card-pill event-card-pill-${status.state}">${status.text}</span>
                </div>
                <div class="event-card-dates">${calendarDate(e.startTime)} &ndash; ${calendarDate(e.endTime)}</div>
            </div>
            ${renderRewardChips(e)}
        </div>
    </div>`;
}

function renderCalendarCard(target, result) {
    let body;
    if (result.error) {
        body = `<div class="banner-empty">Couldn&rsquo;t load calendar &mdash; try again later.</div>`;
    } else if (result.loading) {
        body = `<div class="banner-empty">Loading&hellip;</div>`;
    } else if (!result.events || result.events.length === 0) {
        body = `<div class="banner-empty">No active events right now.</div>`;
    } else {
        const sorted = [...result.events].sort((a, b) => a.startTime - b.startTime);
        body = `<div class="event-cards">${sorted.map(renderEventCard).join("")}</div>`;
    }

    return `
    <div class="banner-game-card ${target.style}">
        <div class="game-header">
            <h2 class="game-title">${target.name}</h2>
        </div>
        <div class="banner-card-body">${body}</div>
    </div>`;
}

async function renderCalendarView() {
    const el = document.getElementById("calendar-view");
    if (!el) return;

    const target = BANNER_TARGETS.find(t => t.gid === state.activeGame);
    if (!target) {
        el.innerHTML = `<div class="banner-empty">No calendar data available for this game.</div>`;
        return;
    }

    const cache = loadBannerCache();
    el.innerHTML = renderCalendarCard(target, cache[target.gid] || { loading: true });

    const result = await fetchBanners(target.gid);
    if (state.appTab === "calendar" && state.activeGame === target.gid) {
        el.innerHTML = renderCalendarCard(target, result);
    }
}

window.setAppTab = (tab) => {
    state.appTab = tab;
    window.save();
    buildDashboard();
    if (tab === "banners") renderBannersView();
    if (tab === "calendar") renderCalendarView();
};

const TYPE_LABELS = { d: "Daily", w: "Weekly", m: "Monthly", a: "Challenge" };
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const WEEK_MS = 604800000;
const CYCLE_WEEKS = 12;

const GI = games.find(g => g.id === "gi");
const GI_COMMISSIONS_IDX = GI.daily.findIndex(t => (typeof t === "string" ? t : t.label) === "Commissions");
const GI_RESIN_IDX = GI.daily.findIndex(t => (typeof t === "string" ? t : t.label) === "Resin");
const GI_ABYSS_IDX = GI.abyss.findIndex(t => (typeof t === "string" ? t : t.label) === "Spiral Abyss");
const GI_THEATER_IDX = GI.abyss.findIndex(t => (typeof t === "string" ? t : t.label) === "Imaginarium Theater");

// The live calendar API calls Spiral Abyss "Abyssal Moon Spire" internally;
// Imaginarium Theater's name matches ours already.
const GI_ABYSS_API_NAMES = {
    "Spiral Abyss": "Abyssal Moon Spire",
    "Imaginarium Theater": "Imaginarium Theater",
};

// Games with a live-service "Challenge" tab. GI's two challenges (Spiral
// Abyss, Imaginarium Theater) are fixed, perennial mode names, so they're
// real checklist items in data.js with their own checked/hidden state.
// HSR and ZZZ's endgame challenges rotate their specific name every cycle
// (e.g. "Celestial Lupine" this cycle, something else next), so there's no
// stable label to hardcode - those render read-only, straight from
// whatever the live calendar API currently says, same as Banners.
const CHALLENGE_GAMES = ["gi", "hsr", "zzz"];

function gameHasChallengeTab(g) {
    return CHALLENGE_GAMES.includes(g.id);
}

function challengePill(status) {
    if (!status) return "";
    return `<span class="challenge-pill challenge-pill-${status.state}">${status.text}</span>`;
}

function renderChallengeRow(label, status, checkId) {
    const pill = challengePill(status);
    if (!checkId) {
        return `<div class="checklist-wrapper">
            <div class="checklist-main" style="cursor: default;">
                <span class="task-label">${label}</span>
            </div>
            ${pill}
        </div>`;
    }
    const checked = !!state.checked[checkId];
    return `<div class="checklist-wrapper">
        <div class="checklist-main" onclick="toggleTask('${checkId}', false, 0)">
            <input type="checkbox" class="form-check-input" ${checked ? "checked" : ""} onclick="event.stopPropagation(); toggleTask('${checkId}', false, 0)">
            <span class="task-label ${checked ? "strikethrough" : ""}">${label}</span>
        </div>
        ${pill}
    </div>`;
}

function renderChallengeColumn(g) {
    if (g.id === "gi") {
        const visibleIdxs = g.abyss.map((_, i) => i).filter(i => !state.hidden.includes(`${g.id}-a-${i}`));
        if (visibleIdxs.length === 0) return "";
        return visibleIdxs.map(i => {
            const t = g.abyss[i];
            const apiName = GI_ABYSS_API_NAMES[t.label];
            const status = apiName ? getChallengeStatus(g.id, apiName) : null;
            return renderChallengeRow(t.label, status, `${g.id}-a-${i}`);
        }).join("");
    }

    // HSR/ZZZ: sourced straight from whatever's currently live, but still
    // checkable - reconcileChallengeChecks() (run whenever fresh data comes
    // in) clears each one's checkbox as soon as its cycle actually changes.
    const entry = loadBannerCache()[g.id];
    const challenges = (entry && entry.challenges) || [];
    if (challenges.length === 0) {
        return `<div class="banner-empty">No active challenges right now.</div>`;
    }
    return challenges.map(c => renderChallengeRow(c.name, getChallengeStatus(g.id, c.name), `${g.id}-a-${c.key}`)).join("");
}

// ZZZ's standalone "Login" task and the "Login" entry inside Errands' sub-
// list refer to the same real-life action, so their checkboxes are kept
// mirrored in toggleTask() below rather than tracked as two separate tasks.
const ZZZ = games.find(g => g.id === "zzz");
const ZZZ_LOGIN_IDX = ZZZ.daily.findIndex(t => (typeof t === "string" ? t : t.label) === "Login");
const ZZZ_LOGIN_ID = `zzz-d-${ZZZ_LOGIN_IDX}`;
const ZZZ_ERRANDS_IDX = ZZZ.daily.findIndex(t => typeof t === "object" && t.label === "Errands");
const ZZZ_ERRANDS_ID = `zzz-d-${ZZZ_ERRANDS_IDX}`;
const ZZZ_ERRANDS_TASK = ZZZ.daily[ZZZ_ERRANDS_IDX];
const ZZZ_ERRANDS_LOGIN_SUB_IDX = ZZZ_ERRANDS_TASK.sub.findIndex(s => s === "Login");
const ZZZ_ERRANDS_LOGIN_ID = `${ZZZ_ERRANDS_ID}-s-${ZZZ_ERRANDS_LOGIN_SUB_IDX}`;

const mondayIndex = (date) => (date.getDay() + 6) % 7;
const emptyWeek = () => [null, null, null, null, null, null, null];

// The daily checklist (and its reset) is anchored to 4am, not midnight - see
// getReset("d"). Between midnight and 4am, the calendar date has already
// advanced but the game day (and its commissions/resin checkboxes) hasn't
// reset yet, so "today" for weekly-streak purposes must use the same 4am
// boundary - otherwise the pip for the new calendar day briefly inherits
// yesterday's already-checked commissions/resin as a false "done".
function gameDay(date = new Date()) {
    const d = new Date(date);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return d;
}

// Transient (not persisted) weekly-progress edit session, entered from the
// hamburger menu. A draft copy is edited in place and only written back to
// `state` on Save; Cancel just throws it away.
let gwEditing = false;
let gwDraft = null;

// Which section of the hamburger menu is showing - kept outside updateMenu()
// so it survives the innerHTML rebuild that happens on every re-render.
let menuTab = "display";

function runWeeklyStreakCycleCheck() {
    let didReset = false;
    while (Date.now() >= state.gwCycleEnd) {
        state.gwPoints = 0;
        state.gwDays = emptyWeek();
        state.gwCycleEnd += CYCLE_WEEKS * WEEK_MS;
        didReset = true;
    }
    if (didReset) window.save(true);
}

// --- Save & Global Functions ---
window.save = (isReset = false) => {
    state.up = new Date().toLocaleString();
    state.upTs = Date.now();
    if (isReset) state.rs = new Date().toLocaleString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // These live on the Settings page now, so they only exist in the DOM
    // while that tab is active - the next render there picks up the fresh
    // state.up/state.rs anyway, this is just to update it live if already open.
    const updatedEl = document.getElementById("last-updated");
    const resetEl = document.getElementById("last-reset");
    if (updatedEl) updatedEl.innerText = state.up || "-";
    if (resetEl) resetEl.innerText = state.rs || "-";
    scheduleSyncPush();
    schedulePushProgressUpdate();
};

const GW_CYCLE_STATES = ["done", "missed", null];

window.startWeeklyProgressEdit = () => {
    gwEditing = true;
    gwDraft = [...state.gwDays];
    // The editor lives inside Genshin's checklist card, not the Settings
    // page it's launched from - jump there so it's actually visible.
    state.appTab = "checklist";
    state.activeGame = "gi";
    buildDashboard();
};

window.cycleWeeklyDay = (i) => {
    const cur = GW_CYCLE_STATES.indexOf(gwDraft[i]);
    gwDraft[i] = GW_CYCLE_STATES[(cur + 1) % GW_CYCLE_STATES.length];
    buildDashboard();
};

window.saveWeeklyProgressEdit = () => {
    state.gwDays = gwDraft;
    gwEditing = false;
    gwDraft = null;
    window.save();
    buildDashboard();
};

window.cancelWeeklyProgressEdit = () => {
    gwEditing = false;
    gwDraft = null;
    buildDashboard();
};

window.overrideRewardProgress = () => {
    const val = prompt("Set reward points (0-8)", state.gwPoints);
    if (val !== null && val !== "") {
        state.gwPoints = Math.min(8, Math.max(0, parseInt(val) || 0));
        window.save();
        buildDashboard();
    }
};

function applyGlobalVisibility() {
    const onChecklist = state.appTab === "checklist";
    const onBanners = state.appTab === "banners";
    const onCalendar = state.appTab === "calendar";
    const onSettings = state.appTab === "settings";

    document.getElementById("nav-checklist").classList.toggle("active", onChecklist);
    document.getElementById("nav-banners").classList.toggle("active", onBanners);
    document.getElementById("nav-calendar").classList.toggle("active", onCalendar);
    document.getElementById("nav-settings").classList.toggle("active", onSettings);

    // The game switcher in the sidebar drives whichever view is active -
    // Checklist, Banners and Calendar each show only the selected game, so
    // it stays visible for all three. Settings isn't game-specific, so it's
    // hidden there.
    document.getElementById("quick-nav").classList.toggle("d-none", onSettings);
    document.getElementById("sub-nav").classList.toggle("d-none", state.hideTimers || !onChecklist);
    document.getElementById("main-dashboard").classList.toggle("d-none", !onChecklist);
    document.getElementById("banners-view").classList.toggle("d-none", !onBanners);
    document.getElementById("calendar-view").classList.toggle("d-none", !onCalendar);
    document.getElementById("settings-view").classList.toggle("d-none", !onSettings);
}

function taskCounts(g) {
    let done = 0, total = 0;
    const lists = [["d", g.daily], ["w", g.weekly], ...(state.hideMonthly ? [] : [["m", g.monthly]])];
    lists.forEach(([type, list]) => {
        list.forEach((t, i) => {
            const id = `${g.id}-${type}-${i}`;
            if (state.hidden.includes(id)) return;
            total++;
            if (state.checked[id]) done++;
        });
    });
    return { done, total };
}

window.toggleCollapse = (gid) => {
    state.collapsed = state.collapsed.includes(gid) ? state.collapsed.filter(c => c !== gid) : [...state.collapsed, gid];
    window.save();
    buildDashboard();
};

window.setActiveGame = (gid) => {
    state.activeGame = gid;
    window.save();
    buildDashboard();
    if (state.appTab === "banners") renderBannersView();
    if (state.appTab === "calendar") renderCalendarView();
};

window.setActiveType = (type) => {
    state.activeType = type;
    window.save();
    buildDashboard();
};

function renderWeeklyStreak() {
    if (!state.gwEnabled) return "";

    if (gwEditing) return renderWeeklyStreakEditor();

    const todayIdx = mondayIndex(gameDay());
    // Today's pip completes live as soon as both tasks are checked, without
    // waiting for the next daily reset to permanently commit it into gwDays.
    const todayDoneLive = state.gwDays[todayIdx] !== "done"
        && !!state.checked[`gi-d-${GI_COMMISSIONS_IDX}`]
        && !!state.checked[`gi-d-${GI_RESIN_IDX}`];

    const completedCount = state.gwDays.filter(v => v === "done").length + (todayDoneLive ? 1 : 0);

    // How many days (today included, if not already locked in) are still
    // undecided between now and the week's end — i.e. still capable of
    // swinging the 5/7 target either way.
    let remainingUndecided = 0;
    for (let i = todayIdx; i < 7; i++) {
        if (i === todayIdx && todayDoneLive) continue;
        if (state.gwDays[i] == null) remainingUndecided++;
    }
    const needed = 5 - completedCount;
    // "critical": every remaining day must land as a win to still hit 5/7.
    // "doomed": even a clean sweep of what's left can't reach 5/7 anymore.
    const warnClass = needed <= 0 ? ""
        : needed === remainingUndecided ? "gw-pip-critical"
        : needed > remainingUndecided ? "gw-pip-doomed"
        : "";

    const pips = Array.from({ length: 7 }, (_, i) => {
        const label = DAY_LABELS[i];
        const val = state.gwDays[i];
        if (i === todayIdx && (todayDoneLive || val === "done")) {
            return `<div class="gw-pip completed" title="${label}">✓</div>`;
        }
        if (i === todayIdx) {
            return `<div class="gw-pip current ${warnClass}" title="${label} (today)"><span class="gw-star"></span></div>`;
        }
        if (val === "done") return `<div class="gw-pip completed" title="${label}">✓</div>`;
        if (val === "missed") return `<div class="gw-pip missed" title="${label} (missed)"><span class="gw-x"></span></div>`;
        // Undecided: derive a display-only "missed" for past days so the row
        // still reads correctly even if a day was never explicitly resolved.
        if (i < todayIdx) return `<div class="gw-pip missed" title="${label} (missed)"><span class="gw-x"></span></div>`;
        return `<div class="gw-pip ${warnClass}" title="${label}"></div>`;
    }).join("");

    const warnText = warnClass === "gw-pip-critical"
        ? `<div class="gw-warn-text gw-warn-critical">You must complete every remaining day to hit this week's goal.</div>`
        : warnClass === "gw-pip-doomed"
        ? `<div class="gw-warn-text gw-warn-doomed">You can no longer hit this week's goal.</div>`
        : "";

    return `
    <div class="gw-widget">
        <div class="gw-header">
            <span class="gw-title">Weekly Progress</span>
            <span class="gw-count">${completedCount}/7</span>
        </div>
        <div class="gw-bar">${pips}</div>
        ${warnText}
        <div class="gw-footer">
            <span>Reward Progress: <b>${state.gwPoints}/8</b></span>
            <span id="gw-reset-timer">--</span>
        </div>
    </div>`;
}

function renderWeeklyStreakEditor() {
    const pips = Array.from({ length: 7 }, (_, i) => {
        const label = DAY_LABELS[i];
        const val = gwDraft[i];
        const cls = val === "done" ? "completed" : val === "missed" ? "missed" : "";
        const icon = val === "done" ? "✓" : val === "missed" ? "✕" : "";
        return `<div class="gw-pip ${cls}" title="${label}" onclick="cycleWeeklyDay(${i})">${icon}</div>`;
    }).join("");

    return `
    <div class="gw-widget">
        <div class="gw-header">
            <span class="gw-title">Weekly Progress</span>
            <span class="gw-edit-hint">Tap a day: done → missed → clear</span>
        </div>
        <div class="gw-bar editable">${pips}</div>
        <div class="gw-edit-actions">
            <button type="button" class="gw-btn gw-btn-cancel" onclick="cancelWeeklyProgressEdit()">Cancel</button>
            <button type="button" class="gw-btn gw-btn-save" onclick="saveWeeklyProgressEdit()">Save</button>
        </div>
    </div>`;
}

// --- UI Logic ---
function buildDashboard() {
    const visibleGames = games.filter(g => !state.hidden.includes(g.id));
    if (!visibleGames.some(g => g.id === state.activeGame)) {
        state.activeGame = visibleGames[0]?.id || null;
    }

    // Game tab bar (also used as quick-jump on desktop)
    document.getElementById("quick-nav").innerHTML = visibleGames
        .map(g => {
            const { done, total } = taskCounts(g);
            const doneAll = total > 0 && done === total;
            const isActive = g.id === state.activeGame;
            return `<button type="button" class="quick-pill ${g.style} ${doneAll ? "done" : ""} ${isActive ? "active" : ""}" onclick="setActiveGame('${g.id}')" title="${g.name}">
                <span class="quick-pill-icon"><img src="images/${g.icon}" alt="${g.name}"></span>
                <span class="quick-pill-name">${g.name}</span>
                <span class="quick-pill-count">${done}/${total}</span>
            </button>`;
        }).join("");

    // Game Sections
    document.getElementById("main-dashboard").innerHTML = games
        .map(g => {
            const { done, total } = taskCounts(g);
            const isCollapsed = state.collapsed.includes(g.id);
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            // The Challenge tab only exists for games with live-service
            // content, so the tab set differs per game - fall back to Daily
            // if the globally-shared activeType doesn't apply to whichever
            // game is rendering (e.g. it was left on "Challenge" and the
            // user switched to HI3, which has no such tab).
            const types = ["d", "w", ...(state.hideMonthly ? [] : ["m"]), ...(gameHasChallengeTab(g) && state.challengeEnabled ? ["a"] : [])];
            const activeType = types.includes(state.activeType) ? state.activeType : "d";
            const isActiveGame = g.id === state.activeGame;
            return `
            <div id="section-${g.id}" class="game-section ${g.style} ${!state.hidden.includes(g.id) ? "visible" : ""} ${isCollapsed ? "collapsed" : ""} ${isActiveGame ? "active-game" : ""}">
                <div class="game-header" onclick="toggleCollapse('${g.id}')">
                    <h2 class="game-title">${g.name}</h2>
                    <div class="game-header-right">
                        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
                        <span class="game-progress">${done}/${total}</span>
                        <span class="collapse-arrow">▼</span>
                    </div>
                </div>
                <div class="type-tabs">
                    ${types.map(type => `<button type="button" class="type-tab ${activeType === type ? "active" : ""}" onclick="setActiveType('${type}')">${TYPE_LABELS[type]}</button>`).join("")}
                </div>
                <div class="task-grid">
                    <div class="task-column ${activeType === "d" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Daily</div>${g.daily.map((t, i) => drawItem(g.id, "d", i, t)).join("")}</div>
                    <div class="task-column ${activeType === "w" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Weekly</div>${g.weekly.map((t, i) => drawItem(g.id, "w", i, t)).join("")}</div>
                    ${!state.hideMonthly ? `<div class="task-column ${activeType === "m" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Monthly</div>${g.monthly.map((t, i) => drawItem(g.id, "m", i, t)).join("")}</div>` : ""}
                    ${gameHasChallengeTab(g) && state.challengeEnabled ? `<div class="task-column ${activeType === "a" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Challenge</div>${renderChallengeColumn(g)}</div>` : ""}
                </div>
                ${g.id === "gi" ? renderWeeklyStreak() : ""}
            </div>`;
        }).join("");

    applyGlobalVisibility();
    updateMenu();
    updateLiveText();
}

function drawItem(gid, type, idx, t) {
    const id = `${gid}-${type}-${idx}`;

    if (!state.hidden) state.hidden = [];

    if (state.hidden.includes(id)) return "";

    const isObj = typeof t === "object";
    const hasSub = isObj && Array.isArray(t.sub);

    const label = isObj ? t.label : t;
    const checked = state.checked[id] ? "checked" : "";

    const open = hasSub && state.menus.includes(id);

    let counterLabel = "";
    if (hasSub) {
        const done = t.sub.filter((_, si) => state.checked[`${id}-s-${si}`]).length;
        const total = t.min || t.sub.length;
        counterLabel = ` <span class="text-secondary">(${done}/${total})</span>`;
    }

    return `
        <div class="checklist-wrapper">
            <div class="checklist-main" onclick="toggleTask('${id}', ${hasSub}, ${hasSub ? t.sub.length : 0})">
                <input type="checkbox" class="form-check-input" ${checked} onclick="event.stopPropagation(); toggleTask('${id}', ${hasSub}, ${hasSub ? t.sub.length : 0})">
                <span class="task-label ${state.checked[id] ? "strikethrough" : ""}">${label}${counterLabel}</span>
            </div>
            ${hasSub ? `<div class="checklist-toggle-box ${open ? "active" : ""}" onclick="toggleMenu('${id}', event)"><span class="toggle-arrow ${open ? "rotated" : ""}">▼</span></div>` : ""}
        </div>
        ${hasSub ? `<div class="subtask-container ${open ? "open" : ""}">
            ${t.sub.map((s, si) => `
                <div class="checklist-wrapper">
                    <div class="checklist-main" onclick="toggleTask('${id}-s-${si}')">
                        <input type="checkbox" class="form-check-input" ${state.checked[`${id}-s-${si}`] ? "checked" : ""} onclick="event.stopPropagation(); toggleTask('${id}-s-${si}')">
                        <span class="task-label ${state.checked[`${id}-s-${si}`] ? "strikethrough" : ""}">${s}</span>
                    </div>
                </div>`).join("")}
        </div>` : ""}`;
}

window.toggleTask = (id, isP, count) => {
    state.checked[id] = !state.checked[id];

    if (isP) {
        for (let i = 0; i < count; i++) {
            state.checked[`${id}-s-${i}`] = state.checked[id];
        }
    }

    if (id.includes("-s-")) {
        const parentId = id.split("-s-")[0];
        const [gid, type, idx] = parentId.split("-");

        const g = games.find(x => x.id === gid);
        const taskTypeMap = { d: "daily", w: "weekly", m: "monthly" };
        const task = g[taskTypeMap[type]][idx];

        if (typeof task === "object") {
            const done = task.sub.filter((_, si) => state.checked[`${parentId}-s-${si}`]).length;
            const target = task.min || task.sub.length;
            state.checked[parentId] = done >= target;
        }
    }

    // Keep ZZZ's standalone Login and the Login entry inside Errands in
    // sync, from whichever direction they were toggled.
    if (id === ZZZ_LOGIN_ID) {
        state.checked[ZZZ_ERRANDS_LOGIN_ID] = state.checked[id];
        const done = ZZZ_ERRANDS_TASK.sub.filter((_, si) => state.checked[`${ZZZ_ERRANDS_ID}-s-${si}`]).length;
        state.checked[ZZZ_ERRANDS_ID] = done >= (ZZZ_ERRANDS_TASK.min || ZZZ_ERRANDS_TASK.sub.length);
    } else if (id === ZZZ_ERRANDS_LOGIN_ID) {
        state.checked[ZZZ_LOGIN_ID] = state.checked[id];
    } else if (id === ZZZ_ERRANDS_ID) {
        state.checked[ZZZ_LOGIN_ID] = state.checked[id];
    }

    window.save();
    buildDashboard();
};

window.toggleMenu = (id, e) => {
    e.stopPropagation();
    state.menus = state.menus.includes(id) ? state.menus.filter((m) => m !== id) : [...state.menus, id];
    window.save();
    buildDashboard();
};

window.buildDashboard = buildDashboard;

// --- Timer Logic ---
function updateLiveText() {
    const now = Date.now();
    const pad = (n) => n.toString().padStart(2, "0");
    const d = getReset("d") - now;
    document.getElementById("daily-timer").innerText = `${pad(Math.floor(d / 3600000))}:${pad(Math.floor((d % 3600000) / 60000))}:${pad(Math.floor((d % 60000) / 1000))}`;
    document.getElementById("weekly-timer").innerText = Math.ceil((getReset("w") - now) / 86400000) + "d";
    document.getElementById("monthly-timer").innerText = Math.ceil((getReset("m") - now) / 86400000) + "d";

    const gwTimer = document.getElementById("gw-reset-timer");
    if (gwTimer) {
        const msLeft = Math.max(0, state.gwCycleEnd - now);
        const daysLeft = Math.floor(msLeft / 86400000);
        const hoursLeft = Math.floor((msLeft % 86400000) / 3600000);
        gwTimer.innerText = `Resets in ${daysLeft}d ${hoursLeft}h`;
    }
}

function getReset(type) {
    const now = new Date();
    let r = new Date();
    r.setHours(4, 0, 0, 0);
    if (type === "d") { if (now >= r) r.setDate(r.getDate() + 1); }
    else if (type === "w") {
        const d = r.getDay(), diff = (1 - d + 7) % 7;
        r.setDate(r.getDate() + (diff === 0 && now >= r ? 7 : diff));
    }
    else { r.setDate(1); if (now >= r) r.setMonth(r.getMonth() + 1); }
    return r.getTime();
}

// Spiral Abyss flips its lineup/blessings twice a month - the 1st and the
// 16th, both at 4am - unlike the other cadences above, which are all "next
// boundary minus a fixed interval". A half-month has no fixed length, so
// this finds the most recent boundary directly instead.
function currentAbyssPeriodStart(now = new Date()) {
    const boundaries = [];
    for (const monthOffset of [-1, 0]) {
        boundaries.push(
            new Date(now.getFullYear(), now.getMonth() + monthOffset, 1, 4, 0, 0, 0),
            new Date(now.getFullYear(), now.getMonth() + monthOffset, 16, 4, 0, 0, 0),
        );
    }
    const past = boundaries.filter(b => b.getTime() <= now.getTime());
    return Math.max(...past.map(b => b.getTime()));
}

const MENU_TABS = [
    { id: "display", label: "Display" },
    { id: "games", label: "Games" },
    { id: "items", label: "Items" },
];

window.setMenuTab = (tab) => {
    menuTab = tab;
    updateMenu();
};

// A togglable row: label on the left, a switch on the right, the whole row
// clickable. Purely decorative (no real <input>) - state drives the "on"
// class directly, same as every other toggle in this app.
function settingsToggleRow(label, on, onclick, badge) {
    return `<div class="settings-row" onclick="${onclick}">
        <span class="settings-row-label">${badge ? `<span class="opt-item-badge ${badge.style}">${badge.text}</span> ` : ""}${label}</span>
        <span class="settings-toggle ${on ? "on" : ""}"><span class="settings-toggle-thumb"></span></span>
    </div>`;
}

// A plain clickable row for actions that aren't a toggle (open a prompt,
// jump to another view).
function settingsActionRow(label, onclick, indent) {
    return `<div class="settings-row settings-action-row ${indent ? "settings-row-indent" : ""}" onclick="${onclick}">
        <span class="settings-row-label">${label}</span>
        <span class="settings-row-chevron">&rsaquo;</span>
    </div>`;
}

function settingsCheckpointRow(time) {
    return `<div class="settings-row settings-row-indent">
        <span class="settings-row-label">${time}</span>
        <span class="settings-row-remove" onclick="removePushCheckpoint('${time}')">&times;</span>
    </div>`;
}

function renderMenuDisplayTab() {
    const syncCfg = loadSyncCfg();
    const pushCfg = loadPushCfg();
    let html = settingsToggleRow("Hide Monthly Column", state.hideMonthly, "toggleConfig('monthly')")
        + settingsToggleRow("Hide Reset Timers", state.hideTimers, "toggleConfig('timers')")
        + `<div class="settings-section-title">Sync</div>`;

    if (syncCfg.enabled && syncCfg.workerUrl && syncCfg.pin) {
        html += settingsActionRow("Sync Now", "syncNow()")
            + settingsActionRow("Sync Settings&hellip;", "setupSync()")
            + settingsActionRow("Turn Off Sync", "disableSync()");
    } else {
        html += settingsActionRow("Set Up Sync&hellip;", "setupSync()");
    }

    html += `<div class="settings-section-title">Notifications</div>`;
    if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        html += `<div class="settings-note">Notifications are blocked for this site in your browser settings.</div>`;
    } else if (pushCfg.subscribed) {
        html += settingsToggleRow("Daily Reset", pushCfg.prefs?.daily, "togglePushPref('daily')")
            + settingsToggleRow("Weekly Reset", pushCfg.prefs?.weekly, "togglePushPref('weekly')")
            + settingsToggleRow("Monthly Reset", pushCfg.prefs?.monthly, "togglePushPref('monthly')")
            + settingsToggleRow("Low-Progress Nudges", pushCfg.prefs?.nudges, "togglePushPref('nudges')");
        if (pushCfg.prefs?.nudges) {
            html += (pushCfg.checkpoints || []).map(settingsCheckpointRow).join("")
                + settingsActionRow("Add Check-in Time&hellip;", "addPushCheckpoint()", true);
        }
        html += settingsActionRow("Turn Off Notifications", "disablePushNotifications()");
    } else {
        html += settingsActionRow("Enable Notifications", "enablePushNotifications()");
    }
    return html;
}

function renderMenuGamesTab() {
    return games.map(g =>
        settingsToggleRow(g.name, !state.hidden.includes(g.id), `toggleConfig('game', '${g.id}')`)
    ).join("");
}

function renderMenuItemsTab() {
    let html = `<div class="settings-section-title">Weekly Streak</div>`
        + settingsToggleRow("Weekly Streak", state.gwEnabled, "toggleConfig('weeklystreak')", { style: "gi-theme", text: "GI" })
        + (state.gwEnabled ? settingsActionRow("Edit Weekly Progress", "startWeeklyProgressEdit()", true)
            + settingsActionRow(`Set Reward Progress (${state.gwPoints}/8)`, "overrideRewardProgress()", true) : "");

    html += `<div class="settings-section-title">Challenge</div>`
        + settingsToggleRow("Challenge Tab", state.challengeEnabled, "toggleConfig('challenge')");

    let optionalItemsHtml = "";
    forEachOptionalTask((g, type, i, t) => {
        const taskId = `${g.id}-${type}-${i}`;
        const isVisible = !state.hidden.includes(taskId);
        optionalItemsHtml += settingsToggleRow(t.label, isVisible, `toggleConfig('game', '${taskId}')`, { style: g.style, text: g.badge });
    });

    if (optionalItemsHtml) {
        html += `<div class="settings-section-title">Optional Items</div>` + optionalItemsHtml;
    }
    return html;
}

function updateMenu() {
    const tabsHtml = `<div class="menu-tabs">` + MENU_TABS.map(t =>
        `<a href="#" class="menu-tab ${menuTab === t.id ? "active" : ""}" onclick="setMenuTab('${t.id}'); return false;">${t.label}</a>`
    ).join("") + `</div>`;

    const body = menuTab === "games" ? renderMenuGamesTab()
        : menuTab === "items" ? renderMenuItemsTab()
        : renderMenuDisplayTab();

    document.getElementById("settings-body").innerHTML = tabsHtml + `<div class="settings-section">${body}</div>`;
}

window.toggleConfig = (type, id) => {
    if (type === 'monthly') {
        state.hideMonthly = !state.hideMonthly;
    } else if (type === 'timers') {
        state.hideTimers = !state.hideTimers;
    } else if (type === 'weeklystreak') {
        state.gwEnabled = !state.gwEnabled;
    } else if (type === 'challenge') {
        state.challengeEnabled = !state.challengeEnabled;
        if (!state.challengeEnabled && state.activeType === "a") state.activeType = "d";
    } else if (type === 'game') {
        if (state.hidden.includes(id)) {
            state.hidden = state.hidden.filter(h => h !== id);
        } else {
            state.hidden = [...state.hidden, id];
        }
    }
    window.save();
    buildDashboard();
};

// --- Init ---

async function initApp() {
    // Adopt any synced state before running the local reset checks below -
    // otherwise a freshly-installed (or just-cleared) device's "just booted"
    // timestamp would beat out real progress synced from another device,
    // since the reset checks themselves call save() and bump upTs to now.
    const cfg = loadSyncCfg();
    if (cfg.enabled && cfg.workerUrl && cfg.pin) {
        await syncPull();
    }

    // 1. Daily Reset Check
    if (state.lastD < getReset("d") - 86400000) {
    if (state.gwEnabled) {
        // The day that just ended is "yesterday" relative to the current
        // game day - NOT getReset("d") - 1 day. getReset("d") is
        // recomputed fresh right here, so by the time this runs (e.g.
        // reopening the app at any normal daytime hour, well after the
        // 4am reset already passed), it's already rolled forward to
        // tomorrow's boundary - making that formula land on today's
        // weekday instead of yesterday's, i.e. off by one day forward.
        const endedDay = gameDay();
        endedDay.setDate(endedDay.getDate() - 1);
        const endedDayIdx = mondayIndex(endedDay);
        // Don't clobber a day already explicitly resolved (e.g. via manual edit).
        if (state.gwDays[endedDayIdx] == null) {
            const done = state.checked[`gi-d-${GI_COMMISSIONS_IDX}`] && state.checked[`gi-d-${GI_RESIN_IDX}`];
            state.gwDays[endedDayIdx] = done ? "done" : "missed";
        }
    }
    games.forEach((g) => {
        g.daily.forEach((t, i) => {
            delete state.checked[`${g.id}-d-${i}`];
            if (typeof t === "object" && t.sub) {
                t.sub.forEach((_, si) => delete state.checked[`${g.id}-d-${i}-s-${si}`]);
            }
        });
    });
    state.lastD = Date.now();
    window.save(true);
}

// 2. Weekly Reset Check
if (state.lastW < getReset("w") - 604800000) {
    if (state.gwEnabled && state.gwDays.filter(v => v === "done").length >= 5) {
        state.gwPoints = Math.min(8, state.gwPoints + 1);
    }
    state.gwDays = emptyWeek();
    games.forEach((g) => {
        g.weekly.forEach((t, i) => {
            delete state.checked[`${g.id}-w-${i}`];
            if (typeof t === "object" && t.sub) {
                t.sub.forEach((_, si) => delete state.checked[`${g.id}-w-${i}-s-${si}`]);
            }
        });
    });
    state.lastW = Date.now();
    window.save(true);
}

// 3. Monthly Reset Check
const nextMonthlyReset = new Date(getReset("m"));
const currentMonthlyReset = new Date(nextMonthlyReset);
currentMonthlyReset.setMonth(currentMonthlyReset.getMonth() - 1);

if (state.lastM < currentMonthlyReset.getTime()) {
    games.forEach((g) => {
        if (g.monthly) {
            g.monthly.forEach((t, i) => {
                delete state.checked[`${g.id}-m-${i}`];
                if (typeof t === "object" && t.sub) {
                    t.sub.forEach((_, si) => delete state.checked[`${g.id}-m-${i}-s-${si}`]);
                }
            });
        }
    });
    state.lastM = Date.now();
    window.save(true);
}

// 4. Spiral Abyss Reset Check (1st & 16th, 4am - see currentAbyssPeriodStart)
const abyssPeriodStart = currentAbyssPeriodStart();
if (state.lastAbyss < abyssPeriodStart) {
    delete state.checked[`gi-a-${GI_ABYSS_IDX}`];
    state.lastAbyss = abyssPeriodStart;
    window.save(true);
}

// 5. Imaginarium Theater Reset Check - flips monthly on the 1st, same
// boundary as the Monthly check above, since Theater and Abyss alternate
// month to month but both reset on a month-aligned cadence.
if (state.lastTheater < currentMonthlyReset.getTime()) {
    delete state.checked[`gi-a-${GI_THEATER_IDX}`];
    state.lastTheater = currentMonthlyReset.getTime();
    window.save(true);
}

runWeeklyStreakCycleCheck();

buildDashboard();
if (state.appTab === "banners") renderBannersView();
// Prime every Challenge-tab game's live calendar data (banners + challenge
// dates) in the background, so the tab's status line/rows are accurate as
// soon as they're looked at instead of waiting on a fetch mid-render.
// Sequential, not Promise.all - fetchBanners() does a read-modify-write on
// the same shared localStorage cache, and running them concurrently would
// race (each reads the cache before the others have written back, so all
// but the last write silently get lost).
(async () => {
    for (const gid of CHALLENGE_GAMES) {
        await fetchBanners(gid);
        if (state.activeGame === gid) buildDashboard();
    }
})();
setInterval(updateLiveText, 1000);
startSyncLoop();
refreshPushSchedule();
}

initApp();
