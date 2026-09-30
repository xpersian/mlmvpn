// --- GitHub Tunnel: control-plane fetch with an automatic fallback ---
//
// THE PROBLEM
// Setting a session up needs three services that are all reachable-until-they-aren't from
// Iran: GitHub's API, Cloudflare's API, and the broker Worker on workers.dev. When any of
// them is blocked the whole feature dies at "fetch failed" — and it dies precisely when a
// user most needs a tunnel, because they have no working VPN to fix it with. Telling them
// to turn on some other VPN first is not a product.
//
// THE FIX
// The Android app already solved this: a small edge proxy that forwards a request given as
// a query parameter (see emergency/EmergencyInterceptor.kt). This reuses the same,
// already-deployed proxy.
//
// It is a FALLBACK, not a mode. The direct request is always tried first, so nothing is
// slower or routed through a third party when the network is fine; the proxy is used only
// after a direct attempt fails at the network level. That means there is no switch to
// forget to turn off, and no state left behind — which is what was asked for, arrived at
// from the other direction.
//
// SCOPE: control-plane HTTPS only — API calls this app makes about a session. The tunnel's
// own data never touches it.
//
// THE ORDER (2026-09-11): direct → the user's own system proxy → the app's own connected
// engine (Xray's HTTP inbound) → the edge proxy. The edge proxy stopped working from Iran and
// its deployment now answers every request with 402 DEPLOYMENT_DISABLED, so it is the last
// resort, and its own failures are never handed to a caller as if the host had answered.

const VERCEL_PROXY = 'https://mlm-proxy.vercel.app/api?url=';

// --- attempt 3 of 4: the app's own engine ---
//
// Whenever a V2Ray node or a WARP engine (ماسک، وایرگارد، وارپ در وارپ, chained through Xray)
// is connected, Xray listens as an HTTP proxy on 127.0.0.1:20809 and exits outside the block.
// Nothing ever chains Xray into this tunnel, so setup traffic sent there cannot loop back into
// the tunnel it is setting up. MLMVPN_GT_LOCAL_ENGINE_PORT=0 turns it off (the tests do).
// The env var pins it (the tests set 0 to turn the path off); otherwise it is wherever the
// app's Xray serves HTTP right now — «پورت محلی» in Settings can move it off 20809.
// Read once, at load, as it always was: the tests pin it for one module instance and then reset
// the variable for the next.
const LOCAL_ENGINE_PORT_PIN = process.env.MLMVPN_GT_LOCAL_ENGINE_PORT;
function localEnginePort() {
    if (LOCAL_ENGINE_PORT_PIN !== undefined) return Number(LOCAL_ENGINE_PORT_PIN);
    try { return require('../xray-manager').getPorts().http; } catch (e) { return 20809; }
}
let localEngineCheck = { at: 0, up: false };
let localEngineAgentCache = null;

/** Is the app's Xray listening? A quick local connect, remembered for a few seconds. */
function localEngineUp() {
    if (!localEnginePort()) return Promise.resolve(false);
    if (Date.now() - localEngineCheck.at < 5000) return Promise.resolve(localEngineCheck.up);
    return new Promise((resolve) => {
        const net = require('net');
        const s = net.connect({ host: '127.0.0.1', port: localEnginePort() });
        const done = (up) => { s.destroy(); localEngineCheck = { at: Date.now(), up }; resolve(up); };
        s.setTimeout(400, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

function localEngineAgent() {
    if (localEngineAgentCache) return localEngineAgentCache;
    try {
        const { ProxyAgent } = require('undici');
        localEngineAgentCache = new ProxyAgent(`http://127.0.0.1:${localEnginePort()}`);
    } catch (e) {
        localEngineAgentCache = null;
    }
    return localEngineAgentCache;
}

// The edge proxy's own failure — a disabled deployment, a payload over its limit — carries
// this header. It is not the requested host speaking and must never be read as if it were.
function isEdgeProxyFailure(res) {
    try { return !!(res && res.headers && res.headers.get('x-vercel-error')); } catch (e) { return false; }
}

const ALL_PATHS_FAILED =
    'دسترسی به سرویس‌های موردنیاز برقرار نشد: مسیر مستقیم بسته است و مسیر جایگزین هم در دسترس نیست. ' +
    'یکی از موتورها (V2Ray، ماسک، وایرگارد یا وارپ در وارپ) را وصل کنید و دوباره امتحان کنید؛ ' +
    'تنظیم تونل خودکار از همان عبور می‌کند.';

// --- attempt 2 of 3: the proxy the user already turned on ---
//
// Node's fetch does NOT read Windows' proxy settings. So a user who switches the app's
// proxy on precisely BECAUSE github.com / api.cloudflare.com are unreachable gets no
// benefit from it here: every control-plane call still goes out direct, fails, and lands
// on the third-party edge proxy — or fails outright. That is most of the "sometimes it
// works, sometimes it doesn't" in tunnel setup, and it looks random because it depends on
// which of the three hosts happens to be reachable at that moment.
//
// So when the system proxy is on and is NOT one of our own listeners, route the retry
// through it. Our own ports are excluded deliberately: sending the tunnel's setup traffic
// into the tunnel it is still setting up is the loop that cannot complete.
const OWN_PROXY_PORTS_FIXED = ['20810', '20812', '20813'];
function ownProxyPorts() {
    const set = new Set(OWN_PROXY_PORTS_FIXED);
    try { const p = require('../xray-manager').getPorts(); set.add(String(p.http)); set.add(String(p.socks)); } catch (e) { set.add('20809'); }
    return set;
}
const WIN_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

let proxyAgentCache = { server: '', agent: null };

/** The system proxy's "host:port", or '' when it is off / ours / unreadable. */
function systemProxyServer() {
    if (process.platform !== 'win32') return '';
    try {
        const { execSync } = require('child_process');
        const out = execSync(`reg query "${WIN_PROXY_KEY}" /v ProxyEnable`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/i);
        if (!m || !parseInt(m[1], 16)) return '';
        const s = execSync(`reg query "${WIN_PROXY_KEY}" /v ProxyServer`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const sm = s.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
        const server = sm ? sm[1].trim() : '';
        // A per-protocol value ("http=host:port;https=…") — take the https/http entry.
        const picked = server.includes('=')
            ? (server.match(/https?=([^;]+)/i) || [])[1] || ''
            : server;
        if (!picked) return '';
        const port = picked.split(':').pop();
        if (ownProxyPorts().has(port)) return '';
        return picked;
    } catch (e) {
        return '';
    }
}

function systemProxyAgent() {
    const server = systemProxyServer();
    if (!server) return null;
    if (proxyAgentCache.server === server && proxyAgentCache.agent) return proxyAgentCache.agent;
    try {
        const { ProxyAgent } = require('undici');
        proxyAgentCache = { server, agent: new ProxyAgent(`http://${server}`) };
        return proxyAgentCache.agent;
    } catch (e) {
        return null;
    }
}

// ── WHEN THIS MACHINE CANNOT LOOK A NAME UP ─────────────────────────────────────────
//
// The moment a GitHub Tunnel repair needs GitHub most — the runner gone, the full tunnel down,
// the kill switch holding the machine closed — is the moment Windows cannot resolve anything:
// its lookups go out from the DNS Client service, which the kill switch does not let out, and the
// router's DNS is blocked on top (gt-guard.js › THE DNS LEAK). This app IS on the allow-list. So a
// lookup that failed is asked again from here: DNS over TCP to public resolvers — the lines this
// was measured on hijack UDP/53 and nothing else (tun-manager.js › engine-dns) — and failing that,
// the last address that worked for the name. Control-plane names only; the tunnel's own traffic
// never comes here.
const os = require('os');
const path = require('path');
const OWN_RESOLVERS = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];
const LKG_FILE = path.join(os.homedir(), '.mlmvpn', 'gt-lkg-dns.json');
const LKG_MAX = 64;
let lkg = null;
const lkgRefreshedAt = new Map();

function loadLkg() {
    if (lkg) return lkg;
    try { lkg = JSON.parse(require('fs').readFileSync(LKG_FILE, 'utf8')) || {}; } catch (e) { lkg = {}; }
    return lkg;
}
function saveLkg() {
    try {
        const fs = require('fs');
        fs.mkdirSync(path.dirname(LKG_FILE), { recursive: true });
        const keys = Object.keys(lkg).sort((a, b) => (lkg[b].at || 0) - (lkg[a].at || 0)).slice(0, LKG_MAX);
        const trimmed = {};
        for (const k of keys) trimmed[k] = lkg[k];
        lkg = trimmed;
        fs.writeFileSync(LKG_FILE, JSON.stringify(lkg));
    } catch (e) { /* a cache, never a failure */ }
}
function remember(host, ips) {
    const good = (ips || []).filter((ip) => require('net').isIPv4(ip));
    if (!good.length) return;
    loadLkg()[host] = { ips: good.slice(0, 8), at: Date.now() };
    saveLkg();
}
const validName = (n) => typeof n === 'string' && n.length < 254 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(n) && !require('net').isIP(n);

/** A DNS question for the A records of `name`, framed for TCP (two-byte length first). */
function dnsQuery(name, id) {
    const labels = name.split('.').filter(Boolean);
    const qname = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')])), Buffer.from([0])]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2);   // standard query, recursion desired
    header.writeUInt16BE(1, 4);        // one question
    const msg = Buffer.concat([header, qname, Buffer.from([0x00, 0x01, 0x00, 0x01])]);   // A, IN
    const len = Buffer.alloc(2);
    len.writeUInt16BE(msg.length, 0);
    return Buffer.concat([len, msg]);
}

function skipName(buf, off) {
    for (let guard = 0; guard < 128; guard++) {
        if (off >= buf.length) return -1;
        const len = buf[off];
        if (len === 0) return off + 1;
        if ((len & 0xc0) === 0xc0) return off + 2;
        off += 1 + len;
    }
    return -1;
}

/** The A records in an answer to OUR question — the id and the response bit are checked. */
function parseAnswer(msg, id) {
    if (msg.length < 12 || msg.readUInt16BE(0) !== id) throw new Error('dns: not our answer');
    const flags = msg.readUInt16BE(2);
    if (!(flags & 0x8000)) throw new Error('dns: not a response');
    if ((flags & 0x000f) !== 0) throw new Error(`dns: rcode ${flags & 0x000f}`);
    const qd = msg.readUInt16BE(4);
    const an = msg.readUInt16BE(6);
    let off = 12;
    for (let i = 0; i < qd; i++) { off = skipName(msg, off); if (off < 0) throw new Error('dns: bad question'); off += 4; }
    const ips = [];
    for (let i = 0; i < an && off > 0 && off + 10 <= msg.length; i++) {
        off = skipName(msg, off);
        if (off < 0 || off + 10 > msg.length) break;
        const type = msg.readUInt16BE(off);
        const rdlen = msg.readUInt16BE(off + 8);
        const rd = off + 10;
        if (type === 1 && rdlen === 4 && rd + 4 <= msg.length) ips.push(`${msg[rd]}.${msg[rd + 1]}.${msg[rd + 2]}.${msg[rd + 3]}`);
        off = rd + rdlen;
    }
    return ips;
}

function tcpResolve(name, server, timeoutMs = 4000, port = 53) {
    return new Promise((resolve, reject) => {
        const net = require('net');
        const id = require('crypto').randomInt(0, 65536);
        const sock = net.connect(port, server);
        let buf = Buffer.alloc(0);
        let done = false;
        const finish = (err, ips) => { if (done) return; done = true; sock.destroy(); if (err) reject(err); else resolve(ips); };
        sock.setTimeout(timeoutMs, () => finish(new Error('dns: timeout')));
        sock.on('connect', () => sock.write(dnsQuery(name, id)));
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 2) return;
            const len = buf.readUInt16BE(0);
            if (buf.length < 2 + len) return;
            try { finish(null, parseAnswer(buf.subarray(2, 2 + len), id)); } catch (e) { finish(e); }
        });
        sock.on('error', (e) => finish(e));
        sock.on('close', () => finish(new Error('dns: closed')));
    });
}

/** The machine could not resolve `name`: ask the public resolvers over TCP, then the cache. */
async function resolveOwn(name, { servers = OWN_RESOLVERS, port = 53, timeoutMs = 4000 } = {}) {
    if (!validName(name)) throw Object.assign(new Error(`bad name ${name}`), { code: 'ENOTFOUND' });
    for (const server of servers) {
        try {
            const ips = await tcpResolve(name, server, timeoutMs, port);
            if (ips.length) { remember(name, ips); return ips; }
        } catch (e) { /* the next resolver */ }
    }
    const known = loadLkg()[name];
    if (known && known.ips && known.ips.length) return known.ips;
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND', hostname: name });
}

/** dns.lookup's shape, over resolveOwn — for sockets undici opens. */
function ownLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    resolveOwn(hostname).then((ips) => {
        if (options && options.all) cb(null, ips.map((address) => ({ address, family: 4 })));
        else cb(null, ips[0], 4);
    }, (e) => cb(e));
}

let ownAgent = null;
function ownResolverAgent() {
    if (ownAgent) return ownAgent;
    try {
        const { Agent } = require('undici');
        ownAgent = new Agent({ connect: { lookup: ownLookup } });
    } catch (e) { ownAgent = null; }
    return ownAgent;
}

const isDnsFailure = (err) => {
    const s = `${(err && err.message) || ''} ${(err && err.cause && (err.cause.code || err.cause.message)) || ''}`;
    return /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s);
};

/** Keep the last good address of a name that just worked — what resolveOwn falls back to. */
function rememberAsync(host) {
    if (!validName(host)) return;
    const last = lkgRefreshedAt.get(host) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    lkgRefreshedAt.set(host, Date.now());
    require('dns').lookup(host, { all: true, family: 4 }, (err, list) => {
        if (!err && Array.isArray(list)) remember(host, list.map((a) => a.address));
    });
}

// A failed direct attempt is remembered briefly so a burst of calls during setup doesn't
// each pay the full timeout before falling back.
let directFailedUntil = 0;
// PER HOST. One global cooldown meant that one failing Worker switched the direct path off for
// every other host for a minute: in the arena (2026-09-29) Gozargah's fetch failed and Nova's,
// right after, never tried direct — «مسیر مستقیم بسته است» for a Worker that was fine.
// `directFailedUntil` stays as the latest of them, for isUsingFallback() only.
const directFailedByHost = new Map();
const DIRECT_COOLDOWN_MS = 60 * 1000;

function proxied(url) {
    return VERCEL_PROXY + encodeURIComponent(url);
}

/** True for the kind of failure that means "couldn't reach the host", as opposed to the
 *  host answering with an error.
 *
 *  An HTTP status never reaches this function: fetch() RESOLVES for a 403, so a refusal is
 *  not an error here at all. Refusals are handled by `fallbackOnStatus` in gtFetch. */
function isNetworkFailure(err) {
    // A timeout IS a "couldn't reach the host" failure here — a filtered domain black-holes
    // the connection rather than refusing it, so hitting the deadline is the normal way it
    // fails and must trigger the fallback rather than propagate.
    const name = (err && err.name) || '';
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    const m = ((err && err.message) || '').toLowerCase();
    const cause = ((err && err.cause && (err.cause.code || err.cause.message)) || '').toString().toLowerCase();
    return /fetch failed|network|econnreset|enotfound|etimedout|econnrefused|socket hang up|aborted|timeout/.test(m + ' ' + cause);
}

/**
 * fetch(), with the edge proxy as a second attempt.
 * Same signature as fetch, so call sites read normally.
 *
 * Extra option `fallbackOnStatus: [403, 451]` — see BLOCKED-BY-STATUS below.
 */
async function gtFetch(url, options = {}) {
    let hostKey = '';
    try { hostKey = new URL(url).hostname.toLowerCase(); } catch (e) { hostKey = ''; }
    const useProxyFirst = Date.now() < (directFailedByHost.get(hostKey) || 0);

    // BLOCKED BY STATUS, not by silence.
    //
    // A sanctions geo-block is not a network failure: pkgs.tailscale.com sits behind a CDN
    // that answers an Iranian IP with a perfectly well-formed 403. fetch() resolves, the
    // catch below never runs, and the response is returned as if the host had spoken its
    // mind about the request — so the direct attempt short-circuits the two fallbacks that
    // exist for exactly this case. That is how the engine download died at "(403)" while
    // the edge proxy sitting one line away could fetch the file fine.
    //
    // OPT-IN, per call. A 403 from the GitHub or Cloudflare API is a real answer ABOUT THE
    // REQUEST — a missing workflow scope, a spent allowance — and those callers must keep
    // receiving it untouched (gt-deployer.js and gt-allocator.js both read it). Only a
    // caller that knows its host has no legitimate reason to say 403 passes this.
    const { fallbackOnStatus, ...fetchOptions } = options;
    const blockedStatuses = new Set(fallbackOnStatus || []);
    const isBlocked = (res) => blockedStatuses.has(res.status);
    // A response walked away from still holds its socket until the body is drained.
    const discard = (res) => {
        try { if (res && res.body && !res.bodyUsed) res.body.cancel().catch(() => {}); } catch (e) {}
    };
    // The ORIGIN's verdict, kept in case every fallback also fails. Reporting the proxy's
    // version of the failure instead would point the user at the wrong problem.
    let blockedRes = null;

    // Each attempt gets its OWN deadline.
    //
    // Passing a single `signal` in and reusing it for both attempts silently disables the
    // fallback: the direct attempt to a filtered host runs until the signal fires, and the
    // proxy attempt then starts with an already-aborted signal and dies instantly. The
    // symptom is a plain fetch error that looks like the proxy is unreachable, when in
    // fact it was never really tried. Callers pass `timeoutMs` and get a fresh timeout per
    // attempt; an explicitly supplied `signal` still works and is combined with it.
    const { timeoutMs, signal: callerSignal, ...rest } = fetchOptions;
    const attemptOptions = () => {
        if (!timeoutMs) return callerSignal ? { ...rest, signal: callerSignal } : rest;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = callerSignal && AbortSignal.any
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : timeoutSignal;
        return { ...rest, signal };
    };

    let host = '';
    try { host = new URL(url).hostname; } catch (e) { /* the fetch below says what is wrong */ }
    if (!useProxyFirst) {
        try {
            const res = await fetch(url, attemptOptions());
            if (isBlocked(res)) {
                // Deliberately NOT setting directFailedUntil: that cooldown is global across
                // every host, and one sanctioned CDN refusing us must not shove unrelated
                // GitHub and Cloudflare calls onto the third-party proxy for a minute.
                blockedRes = res;
            } else {
                directFailedByHost.delete(hostKey);
                rememberAsync(host);
                return res;
            }
        } catch (e) {
            if (!isNetworkFailure(e)) throw e;
            // The machine could not RESOLVE the name — the host itself may be perfectly
            // reachable. Same direct path, with this app answering the lookup itself (WHEN THIS
            // MACHINE CANNOT LOOK A NAME UP), before any proxy is considered.
            const own = isDnsFailure(e) ? ownResolverAgent() : null;
            if (own) {
                try {
                    const res = await fetch(url, { ...attemptOptions(), dispatcher: own });
                    if (!isBlocked(res)) {
                        try { Object.defineProperty(res, 'viaOwnResolver', { value: true, enumerable: false }); } catch (e2) {}
                        return res;
                    }
                    blockedRes = res;
                } catch (e2) {
                    if (!isNetworkFailure(e2)) throw e2;
                }
            }
            directFailedUntil = Date.now() + DIRECT_COOLDOWN_MS;
            directFailedByHost.set(hostKey, directFailedUntil);
        }
    }

    // Between direct and the third-party hop: the user's own proxy, if they have one on.
    const agent = systemProxyAgent();
    if (agent) {
        try {
            const res = await fetch(url, { ...attemptOptions(), dispatcher: agent });
            if (isBlocked(res)) {
                // The user's own proxy exits somewhere just as sanctioned. One hop left.
                discard(res);
            } else {
                try { Object.defineProperty(res, 'viaSystemProxy', { value: true, enumerable: false }); } catch (e2) {}
                discard(blockedRes);
                return res;
            }
        } catch (e) {
            if (!isNetworkFailure(e)) throw e;
        }
    }

    // The app's own connected engine, if any.
    if (await localEngineUp()) {
        const local = localEngineAgent();
        if (local) {
            try {
                const res = await fetch(url, { ...attemptOptions(), dispatcher: local });
                if (isBlocked(res)) {
                    // That engine exits somewhere just as sanctioned. One hop left.
                    discard(res);
                } else {
                    try { Object.defineProperty(res, 'viaLocalEngine', { value: true, enumerable: false }); } catch (e2) {}
                    discard(blockedRes);
                    return res;
                }
            } catch (e) {
                if (!isNetworkFailure(e)) throw e;
            }
        }
    }

    // Direct was skipped only because it failed a moment ago — and nothing else answered. The
    // cooldown is to try the alternatives FIRST, never to skip the one path that exists: a retry
    // after a single timeout (a cold Worker, measured on Gozargah 2026-09-29) otherwise failed at
    // once with «direct closed» and never reached the Worker that had woken up meanwhile.
    if (useProxyFirst) {
        try {
            const res = await fetch(url, attemptOptions());
            if (!isBlocked(res)) {
                directFailedByHost.delete(hostKey);
                discard(blockedRes);
                return res;
            }
            blockedRes = blockedRes || res;
        } catch (e) {
            if (!isNetworkFailure(e)) throw e;
        }
    }

    try {
        const res = await fetch(proxied(url), attemptOptions());
        if (isEdgeProxyFailure(res)) {
            // The edge proxy itself is down or refused the request. Report the origin's
            // answer when there is one, otherwise the plain fact that no path worked.
            discard(res);
            if (blockedRes) return blockedRes;
            throw new Error(ALL_PATHS_FAILED);
        }
        // Marked so callers can tell a real answer from the host apart from whatever came
        // back through a hop we do not control. It matters most for authentication: if the
        // proxy does not forward the Authorization header, GitHub answers 401, and reading
        // that as "your token is dead" sends the user off to disconnect and reconnect an
        // account that was never the problem. See gt-github.js.
        if (blockedRes && !res.ok) {
            // Everything refused. The origin's own answer is the one that names the cause.
            discard(res);
            return blockedRes;
        }
        try { Object.defineProperty(res, 'viaFallback', { value: true, enumerable: false }); } catch (e2) {}
        discard(blockedRes);
        return res;
    } catch (e) {
        if (e && e.message === ALL_PATHS_FAILED) throw e;
        // Every path is gone: report the original problem, not the proxy's version of it.
        if (blockedRes) return blockedRes;
        throw new Error(ALL_PATHS_FAILED);
    }
}

/** Lets callers show whether the fallback is currently carrying traffic. */
function isUsingFallback() {
    return Date.now() < directFailedUntil;
}

module.exports = {
    gtFetch, isUsingFallback, VERCEL_PROXY,
    // the app's own resolver (WHEN THIS MACHINE CANNOT LOOK A NAME UP) — exported for testing
    resolveOwn, tcpResolve, dnsQuery, parseAnswer, remember, LKG_FILE,
};
