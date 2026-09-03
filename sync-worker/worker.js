// Tiny sync backend for the Gacha Checklist PWA.
//
// Stores one JSON blob per PIN in a Workers KV namespace. There is no
// account system - the PIN itself is the only thing gating read/write
// access to a slot, so treat it like a shared password and keep it long
// and random rather than "1234".
//
// Routes:
//   GET  /state/:pin  -> the last-saved JSON blob for that pin, or `null`
//   PUT  /state/:pin  -> body becomes the new blob for that pin (must be JSON)

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
        "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    };
}

const MAX_BODY_BYTES = 200 * 1024; // 200KB is generous for this app's state
const PIN_RE = /^[A-Za-z0-9_-]{6,64}$/;

export default {
    async fetch(request, env) {
        const origin = request.headers.get("Origin") || "";
        const cors = corsHeaders(origin);
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors });
        }

        const match = url.pathname.match(/^\/state\/([^/]+)$/);
        if (!match) {
            return new Response("Not found", { status: 404, headers: cors });
        }

        const pin = decodeURIComponent(match[1]);
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
    },
};
