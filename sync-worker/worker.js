// Tiny sync + push backend for the Gacha Checklist PWA.
//
// Stores one JSON blob per PIN in a Workers KV namespace for cross-device
// state sync. There is no account system - the PIN itself is the only
// thing gating read/write access to a slot, so treat it like a shared
// password and keep it long and random rather than "1234".
//
// Also stores one push-subscription record per device (independent of the
// sync PIN - a push subscription is inherently per-browser, so tying it to
// the shared sync identity would force "must set up sync to get
// reminders") and, on a cron schedule, sends Web Push notifications for
// due reset reminders and low-progress nudges.
//
// Routes:
//   GET    /state/:pin      -> the last-saved JSON blob for that pin, or `null`
//   PUT    /state/:pin      -> body becomes the new blob for that pin (must be JSON)
//   PUT    /push/:deviceId  -> upsert a push-subscription record
//   DELETE /push/:deviceId  -> remove a push-subscription record

const ALLOWED_ORIGINS = [
    "https://nazhromar.github.io",
];

function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // Local dev servers (any port).
    return /^http:\/\/localhost(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
    if (!isAllowedOrigin(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    };
}

const MAX_BODY_BYTES = 200 * 1024; // 200KB is generous for this app's state
const PIN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin") || "";
        const cors = corsHeaders(origin);
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors });
        }

        const stateMatch = url.pathname.match(/^\/state\/([^/]+)$/);
        if (stateMatch) return handleState(request, env, cors, stateMatch[1]);

        const pushMatch = url.pathname.match(/^\/push\/([^/]+)$/);
        if (pushMatch) return handlePush(request, env, cors, pushMatch[1]);

        return new Response("Not found", { status: 404, headers: cors });
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScheduledPushes(env));
    },
};

async function handleState(request, env, cors, rawPin) {
    const pin = decodeURIComponent(rawPin);
    if (!PIN_RE.test(pin)) {
        return new Response("Pin must be 6-64 letters/numbers/-/_", { status: 400, headers: cors });
    }
    const key = `sync:${pin}`;

    if (request.method === "GET") {
        const value = await env.SYNC_KV.get(key);
        return new Response(value === null ? "null" : value, {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
        });
    }

    if (request.method === "PUT") {
        const body = await request.text();
        if (body.length > MAX_BODY_BYTES) {
            return new Response("Payload too large", { status: 413, headers: cors });
        }
        try {
            JSON.parse(body);
        } catch (e) {
            return new Response("Body must be valid JSON", { status: 400, headers: cors });
        }
        await env.SYNC_KV.put(key, body);
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
        });
    }

    return new Response("Method not allowed", { status: 405, headers: cors });
}

// A push-subscription record: one per device, independent of any sync
// PIN. `resetAt`/`checkpoints[].at` are absolute timestamps the CLIENT
// resolved from its own local time (the worker never does timezone math -
// see the client's refreshPushSchedule()). `sentFor` tracks what's
// already been notified so a refresh (which re-sends the whole record)
// never re-fires something already sent.
async function handlePush(request, env, cors, rawDeviceId) {
    const deviceId = decodeURIComponent(rawDeviceId);
    if (!DEVICE_ID_RE.test(deviceId)) {
        return new Response("Invalid device id", { status: 400, headers: cors });
    }
    const key = `push:${deviceId}`;

    if (request.method === "PUT") {
        const body = await request.text();
        if (body.length > MAX_BODY_BYTES) {
            return new Response("Payload too large", { status: 413, headers: cors });
        }
        let incoming;
        try {
            incoming = JSON.parse(body);
        } catch (e) {
            return new Response("Body must be valid JSON", { status: 400, headers: cors });
        }

        const existingRaw = await env.SYNC_KV.get(key);
        const existing = existingRaw ? JSON.parse(existingRaw) : null;
        const subscription = incoming.subscription || existing?.subscription;
        if (!subscription || !subscription.endpoint) {
            return new Response("Missing subscription", { status: 400, headers: cors });
        }

        // Match incoming checkpoints to existing ones by time-of-day string so
        // a refresh (new `at` for the next occurrence) doesn't wipe out
        // today's `sentFor` unless the resolved timestamp actually changed.
        const checkpoints = (incoming.checkpoints || []).map((cp) => {
            const prev = existing?.checkpoints?.find((e) => e.time === cp.time);
            return { time: cp.time, at: cp.at, sentFor: prev && prev.at === cp.at ? prev.sentFor : null };
        });

        const record = {
            subscription,
            prefs: incoming.prefs || existing?.prefs || {},
            resetAt: incoming.resetAt || existing?.resetAt || {},
            sentFor: existing?.sentFor || {},
            checkpoints,
            dailyProgressPct: incoming.dailyProgressPct ?? existing?.dailyProgressPct ?? 0,
        };
        await env.SYNC_KV.put(key, JSON.stringify(record));
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
        });
    }

    if (request.method === "DELETE") {
        await env.SYNC_KV.delete(key);
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
        });
    }

    return new Response("Method not allowed", { status: 405, headers: cors });
}

// --- Scheduled push sending ---

// Below this daily-completion percentage, a check-in checkpoint fires a
// nudge. Not user-configurable (yet) - one named constant to tune later.
const NUDGE_THRESHOLD_PCT = 20;

const RESET_MESSAGES = {
    daily: "Daily reset is here - commissions, resin, and dailies are ready.",
    weekly: "Weekly reset is here - trounce domains and weekly bosses are up.",
    monthly: "Monthly reset is here - monthly tasks are ready.",
};

async function runScheduledPushes(env) {
    const vapidPrivateJwk = JSON.parse(env.VAPID_PRIVATE_KEY);
    const now = Date.now();
    let cursor;
    do {
        const list = await env.SYNC_KV.list({ prefix: "push:", cursor });
        for (const k of list.keys) {
            await processOneRecord(env, k.name, now, vapidPrivateJwk);
        }
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
}

async function processOneRecord(env, key, now, vapidPrivateJwk) {
    const raw = await env.SYNC_KV.get(key);
    if (!raw) return;
    let record;
    try {
        record = JSON.parse(raw);
    } catch (e) {
        return;
    }

    // Figure out what's due WITHOUT mutating `record` yet - sentFor only
    // gets written after a confirmed send, so a transient failure (network
    // blip, push service hiccup) retries on the next tick instead of being
    // silently marked "sent" and lost forever.
    const due = [];
    for (const type of ["daily", "weekly", "monthly"]) {
        const at = record.resetAt?.[type];
        if (record.prefs?.[type] && at && at <= now && record.sentFor?.[type] !== at) {
            due.push({ kind: "reset", type, at, notification: { title: "Gacha Checklist", body: RESET_MESSAGES[type], tag: `reset-${type}` } });
        }
    }
    if (record.prefs?.nudges && Array.isArray(record.checkpoints)) {
        for (const cp of record.checkpoints) {
            if (cp.at <= now && cp.sentFor !== cp.at) {
                const shouldNotify = (record.dailyProgressPct ?? 100) < NUDGE_THRESHOLD_PCT;
                due.push({
                    kind: "checkpoint",
                    cp,
                    notification: shouldNotify
                        ? { title: "Gacha Checklist", body: "You still have unfinished dailies today.", tag: "nudge" }
                        : null,
                });
            }
        }
    }

    let changed = false;
    for (const item of due) {
        if (item.notification) {
            try {
                const res = await sendWebPush(record.subscription, item.notification, vapidPrivateJwk);
                if (res.status === 404 || res.status === 410) {
                    // Subscription is gone (revoked/uninstalled) - stop
                    // tracking it instead of retrying forever.
                    await env.SYNC_KV.delete(key);
                    return;
                }
                if (!res.ok) continue; // transient failure - leave sentFor unset, retry next tick
            } catch (e) {
                continue; // network error - leave sentFor unset, retry next tick
            }
        }
        // Either the send succeeded, or (checkpoint case) progress was above
        // threshold so there was nothing to send - either way this
        // occurrence is resolved and shouldn't be re-evaluated later.
        if (item.kind === "reset") {
            record.sentFor = { ...record.sentFor, [item.type]: item.at };
        } else {
            item.cp.sentFor = item.cp.at;
        }
        changed = true;
    }

    if (changed) {
        await env.SYNC_KV.put(key, JSON.stringify(record));
    }
}

// --- Web Push (RFC 8291 message encryption + RFC 8292 VAPID), implemented
// directly on Workers' native crypto.subtle - no npm dependency. The
// standard `web-push` package is Node-only; this worker has never had a
// dependency and third-party Workers-compatible alternatives can't be
// verified without directly testing them, so it's implemented by hand
// against the two RFCs instead. ---

function b64urlEncode(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
    const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function concatBytes(...parts) {
    const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

async function hkdf(saltBytes, ikmBytes, infoBytes, lengthBytes) {
    const key = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes },
        key,
        lengthBytes * 8
    );
    return new Uint8Array(bits);
}

async function buildVapidAuthHeader(endpoint, vapidPrivateJwk) {
    const origin = new URL(endpoint).origin;
    const header = { typ: "JWT", alg: "ES256" };
    const claims = {
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: "mailto:push@gacha-checklist.app",
    };
    const signingInput = `${b64urlEncode(utf8(JSON.stringify(header)))}.${b64urlEncode(utf8(JSON.stringify(claims)))}`;

    const signKey = await crypto.subtle.importKey(
        "jwk", vapidPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, utf8(signingInput));
    const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;

    const publicPoint = concatBytes([0x04], b64urlDecode(vapidPrivateJwk.x), b64urlDecode(vapidPrivateJwk.y));
    return `vapid t=${jwt}, k=${b64urlEncode(publicPoint)}`;
}

// Encrypts `payloadObj` per RFC 8291 and POSTs it to the subscriber's push
// service endpoint. Returns the raw fetch Response so the caller can check
// for a 404/410 (subscription gone).
async function sendWebPush(subscription, payloadObj, vapidPrivateJwk) {
    const uaPublicBytes = b64urlDecode(subscription.keys.p256dh);
    const authSecret = b64urlDecode(subscription.keys.auth);
    const plaintext = utf8(JSON.stringify(payloadObj));

    const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

    const uaPublicKey = await crypto.subtle.importKey(
        "raw", uaPublicBytes, { name: "ECDH", namedCurve: "P-256" }, [], []
    );
    const ecdhSecret = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256)
    );

    const keyInfo = concatBytes(utf8("WebPush: info"), [0x00], uaPublicBytes, asPublicBytes);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(salt, ikm, concatBytes(utf8("Content-Encoding: aes128gcm"), [0x00]), 16);
    const nonce = await hkdf(salt, ikm, concatBytes(utf8("Content-Encoding: nonce"), [0x00]), 12);

    const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    // Delimiter 0x02 marks this as the only (and therefore last) record -
    // no extra padding needed for a payload this small.
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concatBytes(plaintext, [0x02]))
    );

    const recordSize = new Uint8Array(4);
    new DataView(recordSize.buffer).setUint32(0, 4096, false);
    const body = concatBytes(salt, recordSize, [asPublicBytes.length], asPublicBytes, ciphertext);

    return fetch(subscription.endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
            "TTL": "86400",
            "Authorization": await buildVapidAuthHeader(subscription.endpoint, vapidPrivateJwk),
        },
        body,
    });
}
