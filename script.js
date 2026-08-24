import { games } from './data.js';

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js");
    });
}

let state = JSON.parse(localStorage.getItem("gacha_pwa_v1")) || {
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
    up: null,
    rs: null,
};
if (!state.collapsed) state.collapsed = [];
if (!state.activeType) state.activeType = "d";

const TYPE_LABELS = { d: "Daily", w: "Weekly", m: "Monthly" };
const isMobile = () => window.innerWidth < 768;

// --- Save & Global Functions ---
window.save = (isReset = false) => {
    state.up = new Date().toLocaleString();
    if (isReset) state.rs = new Date().toLocaleString();
    localStorage.setItem("gacha_pwa_v1", JSON.stringify(state));
    document.getElementById("last-updated").innerText = state.up || "-";
    document.getElementById("last-reset").innerText = state.rs || "-";
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
    let html = `<li><a class="dropdown-item d-flex align-items-center gap-2" href="#" onclick="toggleConfig('monthly'); return false;">
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

    let optionalItemsHtml = "";
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

buildDashboard();
setInterval(updateLiveText, 1000);
