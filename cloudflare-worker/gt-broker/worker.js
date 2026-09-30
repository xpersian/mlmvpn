/**
 * MLMVPN GitHub Tunnel — Tailscale key broker.
 *
 * Deployed by the desktop app itself (github-tunnel/gt-broker-deploy.js) onto the user's
 * OWN Cloudflare account, one copy per installation. It is the only place that ever holds
 * a real Tailscale credential: the desktop app calls this Worker's HTTP API and never sees
 * the OAuth client secret.
 *
 * Why it has to exist: the product requirement is that end users never see or configure
 * Tailscale, which means auth keys must be minted on their behalf, which means a
 * server-side credential — and a server-side credential can never ship inside a
 * distributed desktop binary.
 *
 * ── AUTHENTICATION — READ THIS BEFORE CHANGING ANYTHING ─────────────────────────────
 * Every request is signed: HMAC-SHA256 of `${sessionId}.${ts}` under GT_SIGNING_SECRET,
 * hex, in `sig`. The secret is generated per-installation by the desktop app
 * (~/.mlmvpn/github-tunnel-broker.json) and uploaded here as an encrypted binding at
 * deploy time, so exactly one machine can talk to any given deployment.
 *
 * An earlier version of this file accepted the `sig` field and never checked it. That was
 * not a small gap. This Worker sits on a public URL, and what it hands out is a
 * PREAUTHORIZED, TAGGED Tailscale auth key — and the tag is the one the setup guide tells
 * users to put in `autoApprovers.exitNode`. Anyone who found the URL could therefore mint
 * themselves a node inside the user's tailnet, reach every device on it, and have it
 * accepted as an exit node without the user approving anything. Unauthenticated key
 * minting is also unbounded spend on the user's own Tailscale account.
 *
 * The keys minted here are ephemeral and tagged, so a mistake is recoverable — but the
 * signature check is the thing that makes this safe to leave on a public hostname at all.
 * Do not weaken it.
 *
 * ── API ─────────────────────────────────────────────────────────────────────────────
 *   POST /mint    { sessionId, ts, sig, expirySeconds?, reusable? } -> { key, expiresAt }
 *   POST /revoke  { sessionId, ts, sig }                            -> { ok: true }
 *   ANY  /p/<payload>.<sig>/<path>   GitHub Tunnel v2 passthrough — see THE PASSTHROUGH below
 *
 * Rejections carry a machine-readable `code` and, for clock problems, this Worker's own
 * `now` so the caller can correct its offset and retry instead of failing forever.
 *
 * ── Bindings ────────────────────────────────────────────────────────────────────────
 *   TS_OAUTH_CLIENT_ID / TS_OAUTH_CLIENT_SECRET   Tailscale OAuth client, "Devices: Write"
 *   TS_TAILNET                                    e.g. "example.com", or "-" for default
 *   GT_SIGNING_SECRET                             the caller's per-install secret
 *   GT_SLOT_A / GT_SLOT_B / GT_SLOT_C             optional Workers VPC networks: the three stable
 *                                                 tunnels (github-tunnel/gt-slots.js)
 */

// The version of THIS script — read off the deployed copy by «ام‌ال‌ام استور». 2 is the build
// that verifies signatures, 3 the one with the v2 passthrough, 4 the one that also reaches the
// stable tunnels (THE STABLE SLOTS below). BROKER_AUTH_VERSION in
// github-tunnel/gt-broker-deploy.js follows when the app starts relying on a route — raising it
// earlier would ask every user to redeploy for a route nothing uses yet.
const WORKER_VERSION = 4;

// Where the runner's Xray listens (github-tunnel/runner/xray-config.mjs › WS_PORT), reached on
// the runner itself through its stable tunnel.
const SLOT_PORT = 10001;

const TS_API = 'https://api.tailscale.com/api/v2';

// How far apart the caller's clock and this Worker's may be. Wide enough to survive an
// ordinarily wrong PC clock and a slow link, narrow enough that a captured request is not
// replayable for long. The caller corrects its offset from the `now` we return, so this
// does not need to be generous.
const SIG_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSION_ID = 128;

const enc = new TextEncoder();

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

/**
 * @returns null when the request is authentic, or a Response describing why it is not.
 */
async function reject(env, body) {
    const secret = env.GT_SIGNING_SECRET;
    if (!secret) {
        // A deployment from before signing existed. Fail closed and say exactly what fixes
        // it — silently minting for anyone is the behaviour this replaced.
        return json({ error: 'relay has no signing secret; redeploy it from the app', code: 'NO_SECRET' }, 503);
    }

    const { sessionId, ts, sig } = body || {};
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID) {
        return json({ error: 'sessionId required', code: 'BAD_REQUEST' }, 400);
    }

    const now = Date.now();
    const n = Number(ts);
    if (!Number.isFinite(n) || Math.abs(now - n) > SIG_WINDOW_MS) {
        // `now` is returned deliberately: a wrong client clock is a real and common
        // failure, and without it the caller can only retry the same wrong timestamp.
        return json({ error: 'timestamp outside the accepted window', code: 'STALE', now }, 401);
    }

    if (typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig)) {
        return json({ error: 'bad signature', code: 'BAD_SIG' }, 401);
    }

    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    // subtle.verify rather than comparing strings: it does not leak how much of the digest
    // matched through timing.
    const ok = await crypto.subtle.verify('HMAC', key, hexToBytes(sig.toLowerCase()), enc.encode(`${sessionId}.${ts}`));
    if (!ok) return json({ error: 'bad signature', code: 'BAD_SIG' }, 401);

    return null;
}

async function getAccessToken(env) {
    const res = await fetch(`${TS_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.TS_OAUTH_CLIENT_ID,
            client_secret: env.TS_OAUTH_CLIENT_SECRET,
        }).toString(),
    });
    if (!res.ok) throw new Error(`tailscale oauth failed (${res.status})`);
    const data = await res.json();
    return data.access_token;
}

async function mintKey(env, sessionId, expirySeconds, reusable) {
    const token = await getAccessToken(env);
    const res = await fetch(`${TS_API}/tailnet/${encodeURIComponent(env.TS_TAILNET)}/keys`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            capabilities: {
                devices: {
                    create: {
                        // The VM's key is redeemed once, immediately, so it stays
                        // single-use. The desktop client's key is pre-minted and must
                        // survive a reconnect — a dropped tunnel, a mode switch, the
                        // watchdog repairing itself — and a single-use key would be spent
                        // by the first connect, leaving every later one to fail with
                        // "invalid key" exactly when the broker is unreachable and the
                        // pre-minting was supposed to save us.
                        reusable: !!reusable,
                        ephemeral: true,
                        preauthorized: true,
                        tags: ['tag:mlmvpn-gt'],
                    },
                },
            },
            // Caller-chosen, clamped. 15 min is right for a key redeemed immediately, but
            // the desktop app mints the client's key up-front — while the broker is still
            // reachable — and may not redeem it until much later, so it must be allowed to
            // live as long as the session it belongs to.
            expirySeconds: Math.min(Math.max(Number(expirySeconds) || 900, 300), 6 * 60 * 60),
            // Tailscale rejects punctuation like ":" in the description — letters/digits/
            // hyphens only.
            description: `gt-${String(sessionId).replace(/[^a-zA-Z0-9-]/g, '-')}`,
        }),
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`tailscale key mint failed (${res.status}): ${errBody}`);
    }
    const data = await res.json();
    return { key: data.key, expiresAt: data.expires };
}

// ── THE PASSTHROUGH ───────────────────────────────────────────────────────────────
//
// GitHub Tunnel v2 runs its server behind Cloudflare quick tunnels (*.trycloudflare.com).
// Measured 2026-09-23 from an Iranian line: that domain is blocked by DNS (it answers with an
// address that refuses the connection) and by SNI (reset right after the ClientHello), while
// the very same clean Cloudflare IPs carry the user's own *.workers.dev without trouble. So
// the client reaches its session's quick tunnel THROUGH this Worker: the censor sees this
// Worker's name, and the hop to trycloudflare.com happens inside Cloudflare.
//
//   /p/<payload>.<sig>/<path>   payload = base64url(JSON { h: label, s: sessionId, e: expiresAtMs })
//                               sig     = base64url(HMAC-SHA256(GT_SIGNING_SECRET, payload))
//
// The pass names ONE quick tunnel and carries its own expiry, signed by the installation that
// deployed this Worker — so this is never an open relay, and a leaked path dies with its
// session. Every failure before the signature is proven looks exactly like any other unknown
// path. Returning the upstream fetch() hands a WebSocket upgrade straight through: the frames
// never pass through this code, so there is no CPU cost per byte. Not WebSocket-only on
// purpose: the UDP mode's rendezvous (hysteria realm) is plain HTTP through the same pass.
//
// ── THE STABLE SLOTS ──
// A pass can name a SLOT instead: { k: 'a'|'b'|'c', s, e }. The app creates three named Cloudflare
// tunnels on the user's account (github-tunnel/gt-slots.js) and binds them here as Workers VPC
// networks, GT_SLOT_A/B/C — no domain, no public hostname: the only way into them is
// this Worker. A session's runner runs the connector of its slot; another is free for the next
// session, so make-before-break never puts two runners behind one tunnel (Cloudflare sends
// a request to the NEAREST replica, not to the one that holds the session). Unlike a quick
// tunnel, a named tunnel has no 200-requests-in-flight cap and is not a testing service.
// Measured 2026-09-23 through a real runner: 26 Mbit on one connection, 35 on four — 90% of the
// 39 Mbit line in the same minute. The destination is fixed here, never taken from the pass.

function b64uDecode(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function passthrough(request, env, url) {
    const secret = env.GT_SIGNING_SECRET;
    if (!secret) return json({ error: 'relay has no signing secret; redeploy it from the app', code: 'NO_SECRET' }, 503);

    const m = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{8,512})\.([A-Za-z0-9_-]{43})(\/.*)?$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, payload, sig, rest] = m;

    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    let authentic = false;
    try { authentic = await crypto.subtle.verify('HMAC', key, b64uDecode(sig), enc.encode(payload)); } catch (e) {}
    if (!authentic) return json({ error: 'not found' }, 404);

    let claims = null;
    try { claims = JSON.parse(new TextDecoder().decode(b64uDecode(payload))); } catch (e) {}
    const quick = !!claims && typeof claims.h === 'string' && /^[a-z0-9-]{3,63}$/.test(claims.h);
    const slot = !!claims && typeof claims.k === 'string' && /^[abc]$/.test(claims.k);
    // Exactly one of the two: a pass naming both, or neither, names nothing.
    if (quick === slot) return json({ error: 'not found' }, 404);
    // Only an authentic pass gets this far, so saying «expired» reveals nothing to a prober —
    // and it tells the app to renew instead of blaming the line.
    if (!Number.isFinite(claims.e) || claims.e < Date.now()) return json({ error: 'pass expired', code: 'EXPIRED' }, 401);

    const headers = new Headers(request.headers);
    headers.delete('host');
    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
    if (slot) {
        const binding = env[`GT_SLOT_${claims.k.toUpperCase()}`];
        // Deployed without the slots (or before they were made): the app redeploys this Worker.
        if (!binding || typeof binding.fetch !== 'function') return json({ error: 'slot not bound; redeploy it from the app', code: 'NO_SLOT' }, 503);
        try {
            return await binding.fetch(`http://127.0.0.1:${SLOT_PORT}${rest || '/'}${url.search}`, init);
        } catch (e) {
            // No runner behind the slot right now, or it is still connecting.
            return json({ error: 'slot unreachable', code: 'SLOT_DOWN' }, 502);
        }
    }
    return fetch(`https://${claims.h}.trycloudflare.com${rest || '/'}${url.search}`, init);
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            // This is an API for one desktop app on one machine, never a browser origin.
            // Saying so keeps a page the user happens to have open from being able to read
            // a response even if it manages to send a valid request.
            'Cache-Control': 'no-store',
        },
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        // Before the POST-only gate: a WebSocket upgrade is a GET.
        if (url.pathname.startsWith('/p/')) return passthrough(request, env, url);
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (url.pathname !== '/mint' && url.pathname !== '/revoke') {
            return json({ error: 'not found' }, 404);
        }

        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'invalid body', code: 'BAD_REQUEST' }, 400); }

        // Before anything that costs money or grants access.
        const denied = await reject(env, body);
        if (denied) return denied;

        try {
            if (url.pathname === '/mint') {
                return json(await mintKey(env, body.sessionId, body.expirySeconds, body.reusable));
            }
            // Ephemeral + preauthorized keys self-clean when the node disconnects (the
            // workflow's last step runs `tailscale logout`, which triggers exactly that),
            // so there is nothing to undo here beyond acknowledging.
            return json({ ok: true });
        } catch (e) {
            return json({ error: e.message || 'broker error' }, 500);
        }
    },
};
