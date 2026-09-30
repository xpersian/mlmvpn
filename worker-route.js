// --- worker-route.js — a self-diagnosing route to `*.workers.dev`, for EVERY client ---
//
// Port of Android's engines/cloud/WorkerRoute.kt. Measured on the phone (2026-09-28): on some
// networks a Cloudflare IP completes the TLS handshake for a Worker's name and then never answers
// the HTTP request — 104.21.4.61 went silent for 8 s while 172.67.154.11, handed out by the same
// DNS for the same Worker, answered in 1.3 s — and on the filtered IPv4 small answers pass while
// larger ones stall (MLM's config list hung 40 s while its user list answered in 1.5 s). DNS picks
// at random and the client never moves on (the connection DID open), so every panel whose configs
// come from its own Worker timed out at random, and the fault read as «the panel is broken».
//
// Here the fault is found and routed around instead of waited out:
//  - every address the name resolves to, every address already proven on this network, and two
//    fresh Cloudflare IPv6 edges (any v6 edge serves any Worker name) are checked with a real
//    request — TCP, TLS with the Worker's name, `HEAD /`: any status line counts (401 and 404 are
//    answers, silence is not);
//  - each IP's verdict lives 10 minutes and is shared by every Worker (IP health is a property of
//    the network, not of one Worker);
//  - ONLY the healthy addresses are returned (IPv6 first, then fastest); all of them only when
//    none is healthy. On the phone a silent IP left even last in the list got used through HTTP/2
//    coalescing — every workers.dev name of an account shares one wildcard certificate;
//  - what was found is kept in words (report / latestReport) and logged under [WorkerRoute].
//
// HOW IT COVERS EVERY CLIENT: Node's net layer reads `dns.lookup` at connect time, so wrapping it
// once reaches axios, https, undici's fetch and gtFetch alike — BPB, Edge, Nahan, MLM, Zeus, the
// cloud manager, the store, dedicated DNS, the GitHub Tunnel broker. (On the phone they had to be
// wired one by one, and the ones left out kept timing out.) A client with its own resolver
// (gt-net.js › ownLookup) keeps it: this only answers lookups that reach dns.lookup.
// HTTP/1.1: Node's https and undici speak HTTP/1.1 unless told otherwise, so nothing here can
// coalesce across names the way OkHttp's HTTP/2 did.
//
// Probes are tls.connect({ host: ip, servername }) — never tls.connect({ socket }), which is an
// access violation on this machine class (memory: tls-over-socket-crash) — and they dial an IP
// literal, so they never come back through the wrapped lookup.

const dns = require('dns');
const tls = require('tls');
const net = require('net');
const cfFamily = require('./cf-family');

const TTL_MS = 10 * 60 * 1000;
const PROBE_MS = 3500;

const verdicts = new Map();      // ip → { ok, at, stage, ms }
const reports = new Map();       // host → { at, text }
const inflight = new Map();      // host → Promise<string[]>
const listeners = new Set();
let origLookup = null;

const isWorkerName = (h) => typeof h === 'string' && /\.workers\.dev\.?$/i.test(h) && !net.isIP(h);

function stageFa(stage) {
    if (stage === 'tcp') return 'وصل نشد';
    if (stage === 'tls') return 'دست‌دهی TLS نکرد';
    if (stage === 'http') return 'دست‌دهی کرد ولی جواب HTTP نداد';
    return 'جواب نداد';
}

// One report per silent address per name per TTL: the address it moved TO differs every time
// (fresh IPv6 edges), so comparing the whole sentence repeated the same finding on every request.
const said = new Map();
function recentlySaid(host, ip) {
    const k = host.toLowerCase() + '|' + ip;
    const at = said.get(k) || 0;
    if (Date.now() - at < TTL_MS) return true;
    said.set(k, Date.now());
    return false;
}

function note(host, text) {
    // The same finding for the same name is said once per TTL, not on every request.
    const prev = reports.get(host.toLowerCase());
    if (prev && prev.text === text && Date.now() - prev.at < TTL_MS) return;
    reports.set(host.toLowerCase(), { at: Date.now(), text });
    console.log('[WorkerRoute] ' + text);
    for (const fn of listeners) { try { fn(text, host); } catch (e) {} }
}

/** TCP, then TLS with `host` as SNI, then `HEAD /`: the first stage that fails names the fault. */
function probe(ip, host) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let stage = 'tcp';
        let settled = false;
        let sock = null;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock && sock.destroy(); } catch (e) {}
            resolve({ ok, at: Date.now(), stage, ms: Date.now() - t0 });
        };
        const timer = setTimeout(() => done(false), PROBE_MS);
        try {
            sock = tls.connect({ host: ip, port: 443, servername: host, ALPNProtocols: ['http/1.1'] });
            sock.once('connect', () => { stage = 'tls'; });
            sock.once('secureConnect', () => {
                stage = 'http';
                sock.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: mlmvpn\r\nConnection: close\r\n\r\n`);
            });
            let buf = '';
            sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.length >= 5) done(buf.startsWith('HTTP/')); });
            sock.on('error', () => done(false));
            sock.on('close', () => done(buf.startsWith('HTTP/')));
        } catch (e) { done(false); }
    });
}

function resolveAll(host) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve([]), 5000);
        origLookup.call(dns, host, { all: true, family: 0 }, (err, list) => {
            clearTimeout(t);
            resolve(err || !Array.isArray(list) ? [] : list.map((a) => String(a.address).split('%')[0]));
        });
    });
}

async function ordered(host) {
    const resolved = await resolveAll(host);
    const now = Date.now();
    const proven = [...verdicts.entries()].filter(([, v]) => v.ok && now - v.at < TTL_MS).map(([ip]) => ip);
    const v6 = (await cfFamily.hasIpv6RouteCached().catch(() => false)) ? cfFamily.sampleV6(2) : [];
    const candidates = [...new Set([...resolved, ...proven, ...v6])];
    if (!candidates.length) {
        note(host, `نام ${host} ترجمه نشد (DNS).`);
        return resolved;
    }
    const unknown = candidates.filter((ip) => { const v = verdicts.get(ip); return !v || now - v.at >= TTL_MS; });
    const got = await Promise.all(unknown.map((ip) => probe(ip, host)));
    unknown.forEach((ip, i) => verdicts.set(ip, got[i]));

    const good = candidates.filter((ip) => (verdicts.get(ip) || {}).ok)
        .sort((a, b) => (a.includes(':') ? 0 : 1) - (b.includes(':') ? 0 : 1) || verdicts.get(a).ms - verdicts.get(b).ms);
    const first = resolved[0];
    if (!good.length) {
        const parts = candidates.map((ip) => `${ip}: ${stageFa((verdicts.get(ip) || {}).stage)}`).join('، ');
        note(host, `هیچ آی‌پی سالمی برای ${host} نبود (${parts}).`);
        return candidates;
    }
    if (first && good[0] !== first && !recentlySaid(host, first)) {
        const v = verdicts.get(first);
        note(host, `آی‌پی ${first} برای ${host} ${stageFa(v && v.stage)}؛ به ${good[0]} رفت.`);
    }
    return good;
}

function orderedShared(host) {
    const key = host.toLowerCase();
    if (!inflight.has(key)) inflight.set(key, ordered(key).finally(() => inflight.delete(key)));
    return inflight.get(key);
}

function wrappedLookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!isWorkerName(hostname)) return origLookup.apply(this, arguments);
    if (typeof opts === 'number') opts = { family: opts };
    opts = opts || {};
    const fam = Number(opts.family) || (opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : 0);
    orderedShared(hostname).then((ips) => {
        let list = ips.filter((ip) => net.isIP(ip));
        if (fam) list = list.filter((ip) => net.isIP(ip) === fam);
        if (!list.length) return origLookup.call(dns, hostname, options, callback);
        if (opts.all) return cb(null, list.map((address) => ({ address, family: net.isIP(address) })));
        cb(null, list[0], net.isIP(list[0]));
    }, () => origLookup.call(dns, hostname, options, callback));
}

/** Wrap dns.lookup once, at startup. Safe to call again. */
function install() {
    if (origLookup) return;
    origLookup = dns.lookup;
    dns.lookup = wrappedLookup;
    cfFamily.hasIpv6RouteCached().catch(() => {});
}

/** Forget every verdict (a network change). */
function reset() { verdicts.clear(); }

/** What was found for `host` in the last few minutes, in words, or null. */
function report(host) {
    const r = reports.get(String(host || '').toLowerCase());
    return r && Date.now() - r.at < TTL_MS ? r.text : null;
}
/** The most recent report for any Worker, for a caller that does not know which name failed. */
function latestReport() {
    let best = null;
    for (const r of reports.values()) if (Date.now() - r.at < TTL_MS && (!best || r.at > best.at)) best = r;
    return best ? best.text : null;
}
function onReport(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function snapshot() {
    return [...verdicts.entries()].map(([ip, v]) => ({ ip, ok: v.ok, stage: v.stage, ms: v.ms, ageS: Math.round((Date.now() - v.at) / 1000) }));
}

module.exports = { install, reset, report, latestReport, onReport, snapshot, probe, isWorkerName };
