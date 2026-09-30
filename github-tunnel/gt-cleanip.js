// --- GitHub Tunnel v2: which Cloudflare addresses carry THIS line to the tunnel ---
//
// The client reaches its session through the user's own Worker (cloudflare-worker/gt-broker ›
// THE PASSTHROUGH), so every connection starts with a TLS handshake to a Cloudflare address
// with the Worker's name in it. Which addresses let that through is a property of the user's
// line and of the day — measured on 2026-09-23, a line whose five clean IPs all worked with
// the fragment profile OFF had every one of them fail with it ON. So nothing here is assumed:
// candidates are tried through the real outbound, in parallel, and the winners are remembered
// per network so the next connect starts from what worked.
//
// Order of candidates, best evidence first:
//   1. this network's winners from last time
//   2. addresses the user's own assistant/scanner already proved on their line (IPv4 AND IPv6)
//   3. a fresh sample of Cloudflare's IPv6 edge (half as many), then of its IPv4 ranges
// Both families since the filtering of 2026-09-28, which left Cloudflare IPv4 passing TLS and
// carrying no data while IPv6 worked (cf-family.js). When the family verdict says IPv4 is dead
// here, IPv6 goes first; the real test through the outbound still has the last word. Measured on
// the phone: connected on 2606:4700:3031:… and 2400:cb00:2049:… (360 ms), 2.2 Mbit/s.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const CACHE_FILE = path.join(HOME_DIR, 'gt-cleanip.json');

// Where Cloudflare answers for everyone's zones — the same ranges the scanner samples.
const CF_RANGES = ['104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '162.158.0.0/15', '188.114.96.0/20', '141.101.64.0/18'];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIpv4 = (s) => IPV4.test(s) && s.split('.').every((o) => Number(o) <= 255);
const isIp = (s) => isIpv4(s) || net.isIPv6(String(s || ''));
const { bareAddress } = require('../public/cf-uri');

// ── plain HTTP through SOCKS5 ──────────────────────────────────────────────────────
// Plain HTTP on purpose: tls.connect({ socket }) is an access violation on this machine class
// (see memory tls-over-socket-crash), and a 204 over HTTP proves the path just as well.
function socksHttpGet(socksPort, host, reqPath, { timeoutMs = 10000, range = null, onData = null, collect = false } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        const sock = net.connect(socksPort, '127.0.0.1');
        let stage = 0;
        let status = 0;
        let bytes = 0;
        let headerBuf = Buffer.alloc(0);
        let firstByteAt = 0;
        const kept = [];          // the body, when the caller wants to read it (64 KB cap)
        let keptBytes = 0;
        const keep = (b) => { if (collect && keptBytes < 65536) { kept.push(b); keptBytes += b.length; } };
        let settled = false;
        const done = (ok, extra = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) {}
            resolve({ ok, status, bytes, ms: Date.now() - started, firstByteMs: firstByteAt ? firstByteAt - started : null,
                ...(collect ? { body: Buffer.concat(kept).toString('utf8') } : {}), ...extra });
        };
        const timer = setTimeout(() => done(bytes > 0 && status >= 200 && status < 300, { timedOut: true }), timeoutMs);
        sock.once('error', (e) => done(false, { error: e.code || e.message }));
        sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', (buf) => {
            if (stage === 0) {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return done(false, { error: 'socks auth' });
                stage = 1;
                const h = Buffer.from(host);
                sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([0, 80])]));
                return;
            }
            if (stage === 1) {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return done(false, { error: `socks connect ${buf[1]}` });
                stage = 2;
                sock.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\n`
                    + (range ? `Range: bytes=${range}\r\n` : '') + 'Connection: close\r\n\r\n');
                return;
            }
            if (!firstByteAt) firstByteAt = Date.now();
            if (stage === 2) {
                headerBuf = Buffer.concat([headerBuf, buf]);
                const end = headerBuf.indexOf('\r\n\r\n');
                if (end < 0) return;
                const m = headerBuf.subarray(0, end).toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/);
                status = m ? Number(m[1]) : 0;
                stage = 3;
                const body = headerBuf.subarray(end + 4);
                bytes += body.length;
                keep(body);
                if (onData && body.length) onData(body.length);
                if (status === 204) return done(true);
                return;
            }
            bytes += buf.length;
            keep(buf);
            if (onData) onData(buf.length);
        });
        sock.on('end', () => done(status >= 200 && status < 300 && (status === 204 || bytes > 0)));
    });
}

/** One request's round trip through a SOCKS port: the delay a page actually feels. */
async function probeDelay(socksPort, timeoutMs = 10000) {
    const r = await socksHttpGet(socksPort, 'clients3.google.com', '/generate_204', { timeoutMs });
    return r.ok && r.status === 204 ? r.ms : null;
}

// ── candidates ──────────────────────────────────────────────────────────────────
function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return {}; } }
function writeCache(c) {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(`${CACHE_FILE}.tmp`, JSON.stringify(c, null, 1));
        fs.renameSync(`${CACHE_FILE}.tmp`, CACHE_FILE);
    } catch (e) {}
}

/** Addresses the user's own assistant/scanner verified on this line (newest last). */
function provenByUser(limit = 12) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'user_data.json'), 'utf8'));
        const seen = [];
        for (const key of ['ipscanner_combo_groups', 'ipscanner_archived_ips']) {
            const raw = d[key];
            const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const text = JSON.stringify(v || []);
            for (const m of text.matchAll(/@(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(?:443|2053|2083|2087|2096|8443)\b/g)) {
                const ip = bareAddress(m[1]);
                if (isIp(ip) && !seen.includes(ip)) seen.push(ip);
            }
            // The archive keeps bare entries ({ ip }) too — brackets and a port come off, but only
            // an address with dots has its port split (a bare IPv6 is all colons).
            if (key === 'ipscanner_archived_ips' && Array.isArray(v)) {
                for (const n of v) {
                    if (!n || n.healthy === false) continue;
                    const ip = bareAddress(typeof n === 'string' ? n : n.ip);
                    if (isIp(ip) && !seen.includes(ip)) seen.push(ip);
                }
            }
        }
        return seen.slice(-limit).reverse();
    } catch (e) { return []; }
}

function sampled(n) {
    try { return require('../ip-provider').sampleFromRanges(CF_RANGES, n).map(String).filter(isIpv4); } catch (e) { return []; }
}

/**
 * Which network this is, so winners are remembered per network: a café's clean IPs are not
 * home's. The default route's adapter and gateway, without spawning anything slow.
 */
function networkKey() {
    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1; if ($r) { $r.InterfaceAlias + '|' + $r.NextHop }"],
        { windowsHide: true, timeout: 8000 }, (err, out) => resolve(String(out || '').trim() || 'unknown'));
    });
}

function candidates(key, { limit = 12 } = {}) {
    const fam = require('../cf-family');
    const cached = (readCache()[key] || {}).ips || [];
    const list = [];
    const add = (ip) => { ip = bareAddress(ip); if (isIp(ip) && !list.includes(ip)) list.push(ip); };
    cached.forEach(add);
    provenByUser().forEach(add);
    const v6 = fam.hasIpv6RouteNow() ? fam.sampleV6(Math.max(2, Math.ceil(limit / 2))) : [];
    const v4 = sampled(limit);
    (fam.preferV6() ? [...v6, ...v4] : [...v4, ...v6]).forEach(add);
    let out = list.slice(0, limit + cached.length + v6.length);
    // IPv4 measured dead here: every v6 candidate goes first.
    if (fam.preferV6()) out = [...out.filter((ip) => ip.includes(':')), ...out.filter((ip) => !ip.includes(':'))];
    return out;
}

// ── the measurement ─────────────────────────────────────────────────────────────
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

async function waitPort(port, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const up = await new Promise((res) => {
            const c = net.connect(port, '127.0.0.1');
            c.once('connect', () => { c.destroy(); res(true); });
            c.once('error', () => res(false));
        });
        if (up) return true;
        await new Promise((r) => setTimeout(r, 150));
    }
    return false;
}

/**
 * The HTTP answers the far side gave, from a measuring core's own log. A WebSocket the Worker
 * refused is logged as «failed to dial to (wss://<ip>/…): 530 <text> > websocket: bad handshake»
 * — which means the LINE is fine: TLS to the Worker got through on that address, and the error
 * came from behind it. Without this every failure read as a filtered line.
 * @returns {Object<string, number>} ip → HTTP status
 */
function refusalsIn(text) {
    const out = {};
    for (const m of String(text || '').matchAll(/failed to dial to \(wss?:\/\/(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])[:/][^)]*\): (\d{3})\b/g)) {
        const ip = bareAddress(m[1]);
        if (isIp(ip)) out[ip] = Number(m[2]);
    }
    return out;
}

/** One verdict from a round's refusals: the most common status, and the addresses that got it. */
function refusalOf(diag, frag) {
    const http = (diag && diag.http) || {};
    const ips = Object.keys(http);
    if (!ips.length) return null;
    const count = {};
    for (const ip of ips) count[http[ip]] = (count[http[ip]] || 0) + 1;
    const status = Number(Object.keys(count).sort((a, b) => count[b] - count[a])[0]);
    return { status, frag: !!frag, ips: ips.filter((ip) => http[ip] === status) };
}

/**
 * Try every address through the real outbound at once, on a throwaway core instance.
 * `buildOutbound(ip, { frag })` returns the exact outbound the tunnel will use. With `diag`,
 * the core logs its failures (info level) and `diag.http` gets the HTTP answers behind the Worker.
 * @returns {Promise<Array<{ip, delayMs}>>} working addresses, fastest first
 */
async function measure({ exe, ips, buildOutbound, frag = false, timeoutMs = 10000, diag = null }) {
    if (!ips.length) return [];
    const ports = [];
    for (let i = 0; i < ips.length; i++) ports.push(await freePort());
    const cfg = {
        // info, not warning: without mux a refused WebSocket is only logged at info.
        log: { loglevel: diag ? 'info' : 'none' },
        inbounds: ips.map((ip, i) => ({ tag: `in${i}`, listen: '127.0.0.1', port: ports[i], protocol: 'socks', settings: { udp: false, auth: 'noauth' } })),
        outbounds: ips.map((ip, i) => ({ ...buildOutbound(ip, { frag }), tag: `out${i}` })),
        routing: { rules: ips.map((ip, i) => ({ type: 'field', inboundTag: [`in${i}`], outboundTag: `out${i}` })) },
    };
    const out = diag ? 'pipe' : 'ignore';
    const child = spawn(exe, ['run', '-c', 'stdin:'], { windowsHide: true, stdio: ['pipe', out, out] });
    child.on('error', () => {});
    let said = '';
    if (diag) {
        const keep = (d) => { if (said.length < 262144) said += d; };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
    }
    child.stdin.end(JSON.stringify(cfg));
    try {
        if (!(await waitPort(ports[ports.length - 1]))) return [];
        // Two shots each, keep the better: the first pays for DNS-free TLS + the Worker hop +
        // the tunnel; a second shot shows whether that was a one-off.
        const results = await Promise.all(ports.map(async (p) => {
            const a = await probeDelay(p, timeoutMs);
            if (a == null) return null;
            const b = await probeDelay(p, timeoutMs);
            return b == null ? a : Math.min(a, b);
        }));
        return ips.map((ip, i) => ({ ip, delayMs: results[i] }))
            .filter((r) => r.delayMs != null)
            .sort((x, y) => x.delayMs - y.delayMs);
    } finally {
        try { child.kill(); } catch (e) {}
        if (diag) {
            // The log line can land a moment after the probe gave up.
            await new Promise((r) => setTimeout(r, 150));
            diag.http = refusalsIn(said);
        }
    }
}

/**
 * The addresses to use now. Fragment OFF first — on the measured line it broke everything —
 * and ON only when nothing got through without it. The answer is remembered per network.
 * Nothing through: `refused` says whether the Worker was reached and answered with an error
 * (the far side's problem, see refusalsIn) — then the fragment round is not even needed.
 * @returns {Promise<{ips: string[], frag: boolean, tried: number, results: Array, refused?: object}>}
 */
async function pick({ exe, buildOutbound, want = 2, onLog, preferFrag = null } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    const key = await networkKey();
    try { await require('../cf-family').hasIpv6RouteCached(); } catch (e) { /* v4 only */ }
    const cache = readCache();
    const remembered = cache[key] || {};
    const list = candidates(key);
    const order = preferFrag === true ? [true, false] : preferFrag === false ? [false] : (remembered.frag ? [true, false] : [false, true]);

    let refused = null;
    for (const frag of order) {
        log(`در حال یافتن آی‌پی تمیز برای این خط${frag ? ' (با شکستن دست‌دادن TLS)' : ''} — ${list.length.toLocaleString('fa-IR')} نشانی…`);
        const diag = {};
        const results = await measure({ exe, ips: list, buildOutbound, frag, diag });
        if (results.length) {
            const ips = results.slice(0, Math.max(want, 1)).map((r) => r.ip);
            cache[key] = { ips: results.slice(0, 6).map((r) => r.ip), frag, at: Date.now() };
            writeCache(cache);
            return { ips, frag, tried: list.length, results };
        }
        refused = refusalOf(diag, frag);
        // The line reached the Worker in this round: fragmenting the handshake cannot help.
        if (refused) break;
    }
    return { ips: [], frag: false, tried: list.length, results: [], refused };
}

function forget() { try { fs.rmSync(CACHE_FILE, { force: true }); } catch (e) {} }

module.exports = { pick, measure, refusalsIn, refusalOf, candidates, provenByUser, networkKey, socksHttpGet, probeDelay, waitPort, freePort, forget, CACHE_FILE, CF_RANGES };
