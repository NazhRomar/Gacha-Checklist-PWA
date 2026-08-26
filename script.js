import { games } from './data.js';

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js");
    });
}

// Ask the browser to exempt this site's storage from automatic eviction.
// Supported on Chrome/Android/desktop; Safari has no such API, so this is a
// harmless no-op there (feature-detected, never throws).
if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist();
}

const STORAGE_KEY = "gacha_pwa_v1";

// Defaults for every field state can hold. Loading merges saved data OVER
// this, field by field, so a save from an older version of the app (missing
// newer fields) still ends up with valid defaults instead of `undefined` -
// no manual "if (!state.x) ..." patch needed per field going forward.
const DEFAULT_STATE = {
    checked: {},
    hidden: [],
    menus: [],
    collapsed: [],
    hideMonthly: false,
    hideTimers: false,
    hideFooter: false,
    activeGame: null,
    activeType: "d",
    lastD: 0,
    lastW: 0,
    lastM: 0,
    gwEnabled: true,
    gwDays: [null, null, null, null, null, null, null],
    gwPoints: 0,
    // Fixed anchor: Monday 2026-11-02 04:00 local, matching the existing
    // Monday 4am weekly-reset boundary (verified: 69d15h out from the
    // reference date the requirement was written against).
    gwCycleEnd: new Date("2026-11-02T04:00:00").getTime(),
    up: null,
    rs: null,
};

function loadState() {
    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
        saved = {};
    }
    const merged = { ...DEFAULT_STATE, ...saved };
    if (!Array.isArray(merged.gwDays) || merged.gwDays.length !== 7) {
        merged.gwDays = [...DEFAULT_STATE.gwDays];
    } else if (typeof merged.gwDays[0] === "boolean") {
        // Migrate from the old boolean-per-day model.
        merged.gwDays = merged.gwDays.map(v => v ? "done" : null);
    }
    return merged;
}

let state = loadState();

const TYPE_LABELS = { d: "Daily", w: "Weekly", m: "Monthly" };
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const isMobile = () => window.innerWidth < 768;

const WEEK_MS = 604800000;
const CYCLE_WEEKS = 12;

const GI = games.find(g => g.id === "gi");
const GI_COMMISSIONS_IDX = GI.daily.findIndex(t => (typeof t === "string" ? t : t.label) === "Commissions");
const GI_RESIN_IDX = GI.daily.findIndex(t => (typeof t === "string" ? t : t.label) === "Resin");

const mondayIndex = (date) => (date.getDay() + 6) % 7;
const emptyWeek = () => [null, null, null, null, null, null, null];

// Transient (not persisted) weekly-progress edit session, entered from the
// hamburger menu. A draft copy is edited in place and only written back to
// `state` on Save; Cancel just throws it away.
let gwEditing = false;
let gwDraft = null;

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
    if (isReset) state.rs = new Date().toLocaleString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    document.getElementById("last-updated").innerText = state.up || "-";
    document.getElementById("last-reset").innerText = state.rs || "-";
};

const GW_CYCLE_STATES = ["done", "missed", null];

window.startWeeklyProgressEdit = () => {
    gwEditing = true;
    gwDraft = [...state.gwDays];
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
    document.getElementById("sub-nav").classList.toggle("d-none", state.hideTimers);
    document.getElementById("app-footer").classList.toggle("d-none", state.hideFooter);
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
    if (isMobile()) return; // mobile uses tabs instead of collapsing
    state.collapsed = state.collapsed.includes(gid) ? state.collapsed.filter(c => c !== gid) : [...state.collapsed, gid];
    window.save();
    buildDashboard();
};

window.setActiveGame = (gid) => {
    state.activeGame = gid;
    window.save();
    buildDashboard();
};

window.setActiveType = (type) => {
    state.activeType = type;
    window.save();
    buildDashboard();
};

function renderWeeklyStreak() {
    if (!state.gwEnabled) return "";

    if (gwEditing) return renderWeeklyStreakEditor();

    const todayIdx = mondayIndex(new Date());
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
                <span class="quick-pill-count">${done}/${total}</span>
            </button>`;
        }).join("");

    // Game Sections
    document.getElementById("main-dashboard").innerHTML = games
        .map(g => {
            const { done, total } = taskCounts(g);
            const isCollapsed = state.collapsed.includes(g.id);
            const isMobileActive = g.id === state.activeGame;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const types = ["d", "w", ...(state.hideMonthly ? [] : ["m"])];
            return `
            <div id="section-${g.id}" class="game-section ${g.style} ${!state.hidden.includes(g.id) ? "visible" : ""} ${isCollapsed ? "collapsed" : ""} ${isMobileActive ? "mobile-active" : ""}">
                <div class="game-header" onclick="toggleCollapse('${g.id}')">
                    <h2 class="game-title">${g.name}</h2>
                    <div class="game-header-right">
                        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
                        <span class="game-progress">${done}/${total}</span>
                        <span class="collapse-arrow">▼</span>
                    </div>
                </div>
                <div class="type-tabs">
                    ${types.map(type => `<button type="button" class="type-tab ${state.activeType === type ? "active" : ""}" onclick="setActiveType('${type}')">${TYPE_LABELS[type]}</button>`).join("")}
                </div>
                <div class="task-grid">
                    <div class="task-column ${state.activeType === "d" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Daily</div>${g.daily.map((t, i) => drawItem(g.id, "d", i, t)).join("")}</div>
                    <div class="task-column ${state.activeType === "w" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Weekly</div>${g.weekly.map((t, i) => drawItem(g.id, "w", i, t)).join("")}</div>
                    ${!state.hideMonthly ? `<div class="task-column ${state.activeType === "m" ? "type-active" : ""}"><div class="column-title"><span class="column-dot"></span>Monthly</div>${g.monthly.map((t, i) => drawItem(g.id, "m", i, t)).join("")}</div>` : ""}
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

function updateMenu() {
    let html = `<li class="dropdown-header">General</li>
    <li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('monthly'); return false;">
        <input type="checkbox" class="form-check-input mt-0" ${state.hideMonthly ? "checked" : ""}> Hide Monthly Column
    </a></li>
    <li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('timers'); return false;">
        <input type="checkbox" class="form-check-input mt-0" ${state.hideTimers ? "checked" : ""}> Hide Reset Timers
    </a></li>
    <li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('footer'); return false;">
        <input type="checkbox" class="form-check-input mt-0" ${state.hideFooter ? "checked" : ""}> Hide Footer
    </a></li><hr class="dropdown-divider">`;

    html += `<li class="dropdown-header">Games</li>`;
    html += games.map(g => `<li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('game', '${g.id}'); return false;">
        <input type="checkbox" class="form-check-input mt-0" ${!state.hidden.includes(g.id) ? "checked" : ""}> ${g.name}
    </a></li>`).join("");

    let optionalItemsHtml = `<li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('weeklystreak'); return false;">
        <input type="checkbox" class="form-check-input mt-0" ${state.gwEnabled ? "checked" : ""}>
        <span class="opt-item-badge gi-theme">GI</span> Weekly Streak
    </a></li>` + (state.gwEnabled ? `
    <li><a class="dropdown-item d-flex align-items-center gap-2 ps-4" href="#" onclick="startWeeklyProgressEdit(); return false;">
        <span class="opt-item-override">✎</span> Edit Weekly Progress
    </a></li>
    <li><a class="dropdown-item d-flex align-items-center gap-2 ps-4" href="#" onclick="overrideRewardProgress(); return false;">
        <span class="opt-item-override">✎</span> Set Reward Progress (${state.gwPoints}/8)
    </a></li>` : "");
    games.forEach(g => {
        g.daily.forEach((t, i) => {
            if (typeof t === 'object' && t.optional) {
                const taskId = `${g.id}-d-${i}`;
                const isVisible = !state.hidden.includes(taskId);
                optionalItemsHtml += `<li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('game', '${taskId}'); return false;">
                    <input type="checkbox" class="form-check-input mt-0" ${isVisible ? "checked" : ""}>
                    <span class="opt-item-badge ${g.style}">${g.badge}</span> ${t.label}
                </a></li>`;
            }
        });
    });

    if (optionalItemsHtml) {
        html += `<hr class="dropdown-divider"><li class="dropdown-header">Optional Items</li>` + optionalItemsHtml;
    }

    document.getElementById("visibility-menu").innerHTML = html;
}

window.toggleConfig = (type, id) => {
    if (type === 'monthly') {
        state.hideMonthly = !state.hideMonthly;
    } else if (type === 'timers') {
        state.hideTimers = !state.hideTimers;
    } else if (type === 'footer') {
        state.hideFooter = !state.hideFooter;
    } else if (type === 'weeklystreak') {
        state.gwEnabled = !state.gwEnabled;
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

// 1. Daily Reset Check
if (state.lastD < getReset("d") - 86400000) {
    if (state.gwEnabled) {
        const endedDayIdx = mondayIndex(new Date(getReset("d") - 86400000));
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

runWeeklyStreakCycleCheck();

buildDashboard();
setInterval(updateLiveText, 1000);
