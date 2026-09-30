// --- cf-family.js — which family of Cloudflare's edge carries tunnel data on THIS network ---
//
// Measured on the phone, 2026-09-28, after Iran's filtering was tightened: through Cloudflare
// IPv4 a Worker tunnel opened (TCP, TLS, even the WebSocket 101) and then carried no data at all
// — not a byte back for plain HTTP or TLS inside it, even on «clean» 172.67.x.x — while the same
// config on Cloudflare IPv6 got Google's ServerHello in 1.1–1.9 s, and 48 of 54 random addresses
// across 16 Cloudflare v6 prefixes answered. So nothing may assume IPv4. The families are
// measured with a REAL test (a TLS or WebSocket pass is not proof), whatever works is used, and
// when the filter moves back the verdict expires and IPv4 is tried again.
//
// Port of Android's data/CfFamily.kt. The verdict is per network and lives 20 minutes; the
// scanner writes it, and the connect path, the delay test, the Worker route, GitHub Tunnel and
// the WARP engines read it.

const os = require('os');
const net = require('net');
const crypto = require('crypto');

const TTL_MS = 20 * 60 * 1000;
const ROUTE_TTL_MS = 60 * 1000;

/**
 * Cloudflare's IPv6 prefixes that served Workers on the phone (2026-09-28), each a /48. Any
 * address inside one reaches the same edge — the interface id is free — which is why v6 needs no
 * scan in the v4 sense, only a pick and a check. Closed there: 2405:b500:1, 2606:4700:f1.
 */
const V6_PREFIXES = [
    '2606:4700:3030', '2606:4700:3031', '2606:4700:3032', '2606:4700:3033',
    '2606:4700:3034', '2606:4700:3035', '2606:4700:3036', '2606:4700:3037',
    '2606:4700:10', '2606:4700:20', '2606:4700:7', '2606:4700:4400',
    '2803:f800:50', '2a06:98c1:3120', '2a06:98c1:3121', '2400:cb00:2049',
];

const isV6 = (ip) => String(ip || '').replace(/^\[|\]$/g, '').includes(':');

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** `n` random edge addresses spread across `prefixes` (prefix + five random groups). */
function sampleV6(n, prefixes = V6_PREFIXES) {
    const list = prefixes && prefixes.length ? prefixes : V6_PREFIXES;
    const out = [];
    for (let i = 0; i < n; i++) {
        const groups = [];
        for (let g = 0; g < 5; g++) groups.push(crypto.randomInt(0, 0x10000).toString(16));
        out.push(list[i % list.length] + ':' + groups.join(':'));
    }
    return shuffle(out);
}

/** The /48 an address belongs to, in V6_PREFIXES' own spelling. */
const prefixOf = (ip) => String(ip).replace(/^\[|\]$/g, '').split(':').slice(0, 3).join(':');

// Adapters that are not the line itself — this app's own tunnel, other VPNs, VMs.
const VIRTUAL = /vmware|virtual|vbox|hyper-v|vethernet|tap|tun|wintun|wireguard|vpn|softether|tailscale|zerotier|loopback|mlmvpn|sing|npcap|bluetooth/i;

/**
 * Which network this is: the physical adapters and their IPv4 addresses. Instant and sync —
 * the verdict is read on every connect and a PowerShell round-trip there would freeze the
 * window (server.js runs in Electron's main thread). A café's address is not home's, so a move
 * reads as a new network and the verdict starts again.
 */
function networkKey() {
    const parts = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs).sort()) {
        if (VIRTUAL.test(name)) continue;
        for (const a of ifs[name] || []) {
            if (a.internal || a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue;
            parts.push(`${name}=${a.address}`);
        }
    }
    return parts.join('|') || 'unknown';
}

/** A global IPv6 address on a physical adapter — not link-local, not ULA, not Teredo. */
function globalIpv6() {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        if (VIRTUAL.test(name)) continue;
        for (const a of ifs[name] || []) {
            if (a.internal || a.family !== 'IPv6') continue;
            const s = a.address.toLowerCase();
            if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) continue;
            if (/^f[cd]/.test(s)) continue;                 // fc00::/7
            if (s.startsWith('2001:0:') || s === '::1') continue;   // Teredo, loopback
            return a.address;
        }
    }
    return null;
}

function tcpReach(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port });
        const done = (ok) => { clearTimeout(t); try { s.destroy(); } catch (e) {} resolve(ok); };
        const t = setTimeout(() => done(false), timeoutMs);
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

/** Does this machine have a global IPv6 address, and does it reach Cloudflare over it? */
async function hasIpv6Route() {
    if (!globalIpv6()) return false;
    return tcpReach('2606:4700:4700::1111', 443, 2500);
}

let routeAt = 0;
let routeVal = false;
let routeInflight = null;
/** hasIpv6Route, remembered for a minute: cheap enough for every lookup. */
async function hasIpv6RouteCached() {
    if (Date.now() - routeAt < ROUTE_TTL_MS) return routeVal;
    if (!routeInflight) {
        routeInflight = hasIpv6Route().then((v) => { routeVal = v; routeAt = Date.now(); return v; })
            .finally(() => { routeInflight = null; });
    }
    return routeInflight;
}
/** The last known answer, without waiting (a refresh is started when it is stale). */
function hasIpv6RouteNow() {
    if (Date.now() - routeAt >= ROUTE_TTL_MS) hasIpv6RouteCached().catch(() => {});
    return routeVal;
}

let last = null;
const listeners = new Set();

/** The verdict for this network, when fresh: { v4, v6, at, net } — true / false / null each. */
function current() {
    if (!last) return null;
    if (Date.now() - last.at >= TTL_MS) return null;
    if (last.net !== networkKey()) return null;
    return last;
}

function record(v4, v6, why = '') {
    last = { v4: v4 === undefined ? null : v4, v6: v6 === undefined ? null : v6, at: Date.now(), net: networkKey() };
    const text = `[CfFamily] حکم این شبکه: IPv4 ${fmt(last.v4)}، IPv6 ${fmt(last.v6)}${why ? ` (${why})` : ''}`;
    console.log(text);
    for (const fn of listeners) { try { fn(text, last); } catch (e) {} }
    return last;
}
const fmt = (b) => (b === true ? 'زنده' : b === false ? 'مرده' : 'نامعلوم');

function onVerdict(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** IPv6 first here: IPv4 measured dead and IPv6 measured alive. */
function preferV6() {
    const v = current();
    return !!(v && v.v4 === false && v.v6 === true);
}

/**
 * Which family the WARP-family cores should scan for endpoints. The user's explicit v6/both
 * stands; otherwise both whenever there is an IPv6 route — NEVER v6 alone on the CDN's verdict:
 * WARP runs on UDP to other Cloudflare ranges, and on the network where CDN IPv4 carried nothing
 * WARP IPv4 still worked (2026-09-28). Both lets the core use whichever answers, today and when
 * IPv4 comes back.
 */
async function warpScanFamily(stored) {
    if (stored === 'v6' || stored === 'both') return stored;
    let route = false;
    try {
        route = await Promise.race([hasIpv6RouteCached(), new Promise((r) => setTimeout(() => r(routeVal), 3000))]);
    } catch (e) { route = false; }
    return route ? 'both' : 'v4';
}

/**
 * Measure both families with the real test (Xray through `baseConfig`): up to `perFamily`
 * addresses each that already passed the cheap check, both families at once — a dead family
 * costs its timeouts, and there is no reason to pay them in turn. Records the verdict.
 */
async function measure({ baseConfig, port = 443, v4Alive = [], v6Alive = [], perFamily = 2, log = () => {} }) {
    const { rewrite } = require('./public/cf-uri');
    const tester = require('./xray-tester');
    const anyWorks = async (ips, basePort) => {
        if (!ips.length) return null;
        const picked = ips.slice(0, perFamily);
        const uris = picked.map((ip) => rewrite(baseConfig, ip, port));
        const ms = await tester.measureUris(uris, { timeoutMs: 12000, basePort });
        picked.forEach((ip, i) => log(`[CfFamily] آزمون واقعی ${ip}: ${ms[i] > 0 ? ms[i] + ' میلی‌ثانیه' : 'داده رد نشد'}`));
        return ms.some((x) => x > 0);
    };
    const [v4, v6] = await Promise.all([anyWorks(v4Alive, 26100), anyWorks(v6Alive, 26200)]);
    return record(v4, v6, 'آزمون واقعی اسکنر');
}

module.exports = {
    V6_PREFIXES, TTL_MS, sampleV6, prefixOf, isV6, networkKey, globalIpv6,
    hasIpv6Route, hasIpv6RouteCached, hasIpv6RouteNow, current, record, onVerdict, preferV6,
    warpScanFamily, measure,
};
