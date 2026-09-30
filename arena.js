// --- arena.js — «میدان کانفیگ»: the user's cloud panels race each other, every number measured ---
//
// Port of Android 1.2.36's arena (engines/arena/*.kt; docs/ANDROID-1.2.36-TO-WINDOWS.fa.md › ۴).
// One button: every panel on the chosen Cloudflare account is made ready, each gives its configs,
// they are put on ONE clean IP (the same for everybody — the user's rule: fair, fast, stable), and
// they race on real measurements. NOTHING in the score is adjusted for anyone.
//
// Lineup on Windows: BPB, Edge, Zeus, Nahan, MLM, Spider, Netra, Gozargah and Nova — every one
// installed here when missing (BPB, Edge and Zeus through the Cloud window's own deploy routes —
// Zeus's is an upsert that reuses the account's panel and database — the rest through
// cloud-panels.js). Zeus joined on the user's word (2026-09-30), after being left out the day before.
//
// Rounds, round-robin so a dip in the line lands on everyone:
//   qualify   parse → TCP → TLS with the config's own name and its first request (scan-scout.alive)
//             → one real request through Xray; up to 3 candidates, the fastest represents the panel.
//   latency   3 real requests, median.
//   reach     https://www.cloudflare.com/cdn-cgi/trace through the config (a Worker with no exit
//             cannot open Cloudflare-hosted sites).
//   speed     (full) the same 1 MB file (proof.ovh.net, not on Cloudflare), one panel at a time,
//             measured exactly — no rounding (Android's rounding once made every panel 3.2 or 4.0).
//   stability (full) 6 requests 3 s apart: success share, jitter (p90−p10), worst spike.
// Score: each round 0–100 relative to the best in it (a ratio: half as fast scores 50); weights
// latency 35, reach 20, speed 25, stability 20, renormalised over the rounds that ran.

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const HISTORY = path.join(os.homedir(), '.mlmvpn', 'arena-history.json');
const PREFS = path.join(os.homedir(), '.mlmvpn', 'arena-prefs.json');
const REACH_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const SPEED_URL = 'https://proof.ovh.net/files/1Mb.dat';
const MAX_CANDIDATES = 3;
// The user the arena makes in panels that hand configs out per user (the same name everywhere).
const ARENA_USER = 'mlmvpn-arena';
const CF_RANGES = ['104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '162.158.0.0/15', '188.114.96.0/20', '141.101.64.0/18'];

const FAIL = {
    NOT_INSTALLED: 'نصب نشد', NO_CONFIG: 'کانفیگی نداد', INVALID: 'کانفیگ نامعتبر',
    UNREACHABLE: 'سرور در دسترس نیست', TLS_REFUSED: 'دست‌دادن TLS رد شد', NO_RESPONSE: 'از تونل جوابی نیامد',
};
const FAIL_ORDER = ['NOT_INSTALLED', 'NO_CONFIG', 'INVALID', 'UNREACHABLE', 'TLS_REFUSED', 'NO_RESPONSE'];

const PANELS = [
    { id: 'BPB', name: 'BPB', color: '#0A84FF', letter: 'B' },
    { id: 'EDG', name: 'Edge', color: '#30D158', letter: 'E' },
    { id: 'ZEU', name: 'Zeus', color: '#FFD60A', letter: 'Z' },
    { id: 'NHN', name: 'Nahan', color: '#BF5AF2', letter: 'N' },
    { id: 'MLM', name: 'MLM', color: '#FF9F0A', letter: 'M' },
    { id: 'SPD', name: 'Spider', color: '#FF375F', letter: 'S' },
    { id: 'NTR', name: 'Netra', color: '#9B59F6', letter: 'Nt' },
    { id: 'GZG', name: 'Gozargah', color: '#40C8E0', letter: 'G' },
    { id: 'NVA', name: 'Nova', color: '#5E5CE6', letter: 'Nv' },
];

// ── small helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CfUri = require('./public/cf-uri');
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); }
function tester() { return require('./xray-tester'); }
async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
}
function tcpMs(ip, port, timeoutMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const s = net.connect({ host: CfUri.stripBrackets(ip), port });
        let done = false;
        const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { s.destroy(); } catch (e) {} resolve(v); };
        const t = setTimeout(() => fin(-1), timeoutMs);
        s.once('connect', () => fin(Math.max(1, Date.now() - t0)));
        s.once('error', () => fin(-1));
    });
}
async function realMs(uri, timeoutMs = 10000, probeUrl = null) {
    const [ms] = await tester().measureUris([uri], { timeoutMs, basePort: 27000, probeUrl });
    return ms > 0 ? ms : null;
}
/** Megabits per second over the fixed 1 MB file, exact (KB/s from the tester × 8 / 1000). */
async function mbpsOf(uri) {
    const [kbs] = await tester().measureUris([uri], { timeoutMs: 30000, basePort: 27100, mode: 'speed', probeUrl: SPEED_URL });
    return kbs > 0 ? (kbs * 8) / 1000 : null;
}

function accounts() {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        return typeof d.cf_accounts === 'string' ? JSON.parse(d.cf_accounts) : (d.cf_accounts || []);
    } catch (e) { return []; }
}
function network() { try { return require('./cf-family').networkKey(); } catch (e) { return 'unknown'; } }
function networkLabel() {
    const k = network();
    return k.split('|').map((p) => p.split('=')[0]).join(' · ') || 'نامعلوم';
}

// ── the adapters (Android ArenaPanels.kt) ─────────────────────────────────────────

function cloud() { return require('./cloud-panels'); }

// BPB and Edge are installed by the Cloud window's own deploy routes (server.js), and their records
// live in the Cloud window's accounts (cf_accounts). server.js hands those routes in here; what an
// install learns is queued for the window to merge into cf_accounts — the renderer owns that list,
// and writing it from here would be overwritten by its next save. The queue is on disk until the
// window confirms (the app may close first), and it is read over REST only: `state` is pushed on
// a WebSocket any local process can read, and these fields are the panel's UUID and password.
let installers = {};
function setInstallers(x) { installers = x || {}; }
function pendingPatches() { return require('./account-patches').pending(); }
function ackPatches(ids) { require('./account-patches').ack(ids); }
function patchAccount(acc, fields) {
    Object.assign(acc, fields);
    require('./account-patches').push(acc.id, fields, 'arena');
}

function adapter(p, acc) {
    const cp = cloud();
    switch (p.id) {
        case 'BPB': return {
            installed: () => !!acc.url,
            canInstall: !!installers.BPB && !!acc.email,
            cantInstall: !acc.email ? 'نصب BPB ایمیل حساب کلادفلر را می‌خواهد (ورود به پنل با همان ایمیل است) — از بخش ابری نصبش کنید' : null,
            install: async (onStep) => patchAccount(acc, await installers.BPB(acc, onStep)),
            candidates: async () => {
                const gt = require('./github-tunnel/gt-net').gtFetch;
                const tries = [`${acc.url}/${encodeURIComponent(acc.subPath || '')}/sub/raw?app=xray`, `${acc.url}/sub/raw/${encodeURIComponent(acc.subPath || '')}?app=xray`];
                for (const u of tries) {
                    try {
                        const r = await gt(u, { timeoutMs: 20000 });
                        if (!r.ok) continue;
                        let t = (await r.text()).trim();
                        if (!t.includes('://')) t = Buffer.from(t, 'base64').toString('utf8');
                        const links = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(vless|trojan):\/\//.test(l) && !/@(127\.0\.0\.1|0\.0\.0\.0):/.test(l));
                        if (links.length) return links;
                    } catch (e) { /* next */ }
                }
                throw new Error('اشتراک BPB جواب نداد');
            },
        };
        case 'EDG': return {
            installed: () => !!(acc.edgeUrl && acc.edgeUuid),
            canInstall: !!installers.EDG,
            install: async (onStep) => patchAccount(acc, await installers.EDG(acc, onStep)),
            candidates: async () => {
                const host = acc.edgeUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
                let pth = '/?ed=2560';
                if (acc.edgeProxyIp) pth += '&proxyip=' + encodeURIComponent(acc.edgeProxyIp);
                return [`vless://${acc.edgeUuid}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&sni=${host}&fp=random&alpn=http%2F1.1&path=${encodeURIComponent(pth)}#Edge-${host}`];
            },
        };
        case 'ZEU': return {
            installed: () => !!acc.zeusUrl,
            canInstall: !!installers.ZEUS,
            install: async (onStep) => patchAccount(acc, await installers.ZEUS(acc, onStep)),
            candidates: () => zeusCandidates(acc),
        };
        default: return {
            installed: () => !!cp.install(p.id, acc.id),
            canInstall: true,
            install: (onStep) => cp.deploy(p.id, acc.id, { onStep }),
            candidates: () => cp.configs(p.id, acc.id),
        };
    }
}

/**
 * Zeus: the arena user's subscription. Zeus authorises by a cookie that IS sha256(password) (see the
 * zeus-panel-integration note), so no login round trip; every call goes through gtFetch (workers.dev
 * is filtered). Zeus builds VLESS/Trojan over WebSocket from the user's own ips/port.
 */
async function zeusCandidates(acc) {
    const gt = require('./github-tunnel/gt-net').gtFetch;
    const base = String(acc.zeusUrl || '').replace(/\/$/, '');
    // The panel's own password (a new install gets a random one), then what the account's registry
    // recorded for this panel — the Cloud window may not have merged it yet — then the old default.
    const reg = require('./panel-registry');
    const known = [acc.zeusPassword];
    try {
        const g = await reg.get(acc, 'ZEU');
        if (g && g.s && g.s.password && reg.scriptOf(g.url) === reg.scriptOf(base)) known.push(g.s.password);
    } catch (e) { /* nothing recorded */ }
    known.push('Admin123!');
    const tries = [...new Set(known.filter(Boolean))];
    const cookieOf = (pw) => 'panel_session=' + require('crypto').createHash('sha256').update(String(pw)).digest('hex');
    const H = { Cookie: cookieOf(tries[0]), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };
    const call = async (p, method = 'GET', body = null) => {
        const r = await gt(base + p, { method, headers: Object.assign({}, H, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, timeoutMs: 25000 });
        const t = await r.text();
        if (r.status === 401) throw new Error('پنل زئوس رمز را نپذیرفت (رمز پنل عوض شده است)');
        if (!r.ok) throw new Error('پنل زئوس: HTTP ' + r.status);
        try { return JSON.parse(t); } catch (e) { return {}; }
    };
    let users = null;
    for (const pw of tries) {
        H.Cookie = cookieOf(pw);
        try { users = (await call('/api/users?t=' + Date.now())).users || []; } catch (e) {
            if (!/رمز را نپذیرفت/.test(e.message) || pw === tries[tries.length - 1]) throw e;
            continue;
        }
        if (pw !== acc.zeusPassword && pw !== 'Admin123!') patchAccount(acc, { zeusPassword: pw });
        break;
    }
    if (!users.some((u) => u.username === ARENA_USER)) {
        await call('/api/users', 'POST', { username: ARENA_USER, limit_gb: null, expiry_days: null, ips: null, port: '443', tls: 'on', fingerprint: 'chrome' });
    }
    const r = await gt(`${base}/sub/${encodeURIComponent(ARENA_USER)}`, { headers: { 'User-Agent': H['User-Agent'] }, timeoutMs: 25000 });
    if (!r.ok) throw new Error('اشتراک زئوس: HTTP ' + r.status);
    let t = (await r.text()).trim();
    if (!t.includes('://')) { try { t = Buffer.from(t, 'base64').toString('utf8'); } catch (e) { /* as is */ } }
    const links = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(vless|trojan):\/\//.test(l) && !/@(127\.0\.0\.1|0\.0\.0\.0):/.test(l));
    if (!links.length) throw new Error('اشتراک زئوس خالی بود');
    return links;
}

// ── scoring (Android ArenaScore.kt, verbatim in effect) ─────────────────────────

const WEIGHTS = { latency: 0.35, reach: 0.20, speed: 0.25, stability: 0.20 };
const median = (a) => { const v = a.filter((x) => x > 0).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
function jitter(e) {
    const v = (e.stability || []).map((s) => s.ms).filter((x) => x > 0).sort((a, b) => a - b);
    if (v.length < 3) return null;
    return v[Math.floor((v.length - 1) * 9 / 10)] - v[Math.floor((v.length - 1) / 10)];
}
function stabSuccess(e) { return e.stability && e.stability.length ? e.stability.filter((s) => s.ms > 0).length / e.stability.length : null; }
const lowerBetter = (v, best) => (v <= 0 ? 0 : Math.min(100, (100 * best) / v));
const higherBetter = (v, best) => (best <= 0 ? 0 : Math.max(0, Math.min(100, (100 * v) / best)));

function score(entries) {
    const q = entries.filter((e) => !e.fail && e.uri);
    if (!q.length) return { standings: [], categories: {}, weights: {} };
    const parts = {};
    const put = (id, r, v) => { (parts[id] = parts[id] || {})[r] = v; };
    const ran = [];
    const lat = (e) => median((e.latency || []).map((s) => s.ms));
    if (q.some((e) => (e.latency || []).length)) {
        ran.push('latency');
        const vals = q.map(lat).filter((x) => x != null);
        const best = vals.length ? Math.min(...vals) : null;
        for (const e of q) put(e.id, 'latency', best == null || lat(e) == null ? 0 : lowerBetter(lat(e), best));
    }
    if (q.some((e) => e.reachTried)) {
        ran.push('reach');
        const vals = q.map((e) => e.reachMs).filter((x) => x > 0);
        const best = vals.length ? Math.min(...vals) : null;
        for (const e of q) put(e.id, 'reach', best == null || !(e.reachMs > 0) ? 0 : lowerBetter(e.reachMs, best));
    }
    if (q.some((e) => e.mbps != null)) {
        ran.push('speed');
        const best = Math.max(0, ...q.map((e) => e.mbps || 0));
        for (const e of q) put(e.id, 'speed', e.mbps != null ? higherBetter(e.mbps, best) : 0);
    }
    if (q.some((e) => (e.stability || []).length)) {
        ran.push('stability');
        const js = q.map(jitter).filter((x) => x != null);
        const bestJ = js.length ? Math.min(...js) : null;
        const raw = {};
        for (const e of q) {
            const s = stabSuccess(e);
            if (s == null) { raw[e.id] = 0; continue; }
            const j = jitter(e);
            const jp = bestJ == null || j == null ? 1 : Math.min(1, (bestJ + 20) / (j + 20));
            raw[e.id] = 100 * (0.7 * s + 0.3 * jp);
        }
        const best = Math.max(0, ...Object.values(raw));
        for (const e of q) put(e.id, 'stability', higherBetter(raw[e.id], best));
    }
    const sum = ran.reduce((s, r) => s + WEIGHTS[r], 0);
    const weights = Object.fromEntries(ran.map((r) => [r, WEIGHTS[r] / sum]));
    const standings = q.map((e) => ({ id: e.id, total: ran.reduce((s, r) => s + weights[r] * ((parts[e.id] || {})[r] || 0), 0), parts: parts[e.id] || {} }))
        .sort((a, b) => (b.total - a.total) || ((lat(q.find((e) => e.id === a.id)) || 1e9) - (lat(q.find((e) => e.id === b.id)) || 1e9)));
    const cats = {};
    if (standings.length >= 2) cats.OVERALL = standings[0].id;
    const withLat = q.filter((e) => lat(e) != null);
    if (withLat.length >= 2) cats.LATENCY = withLat.sort((a, b) => lat(a) - lat(b))[0].id;
    const withSp = q.filter((e) => e.mbps != null);
    if (withSp.length >= 2) cats.SPEED = withSp.sort((a, b) => b.mbps - a.mbps)[0].id;
    if (ran.includes('stability') && q.filter((e) => (e.stability || []).length).length >= 2) {
        cats.STABLE = standings.slice().sort((a, b) => (b.parts.stability || -1) - (a.parts.stability || -1))[0].id;
    }
    const withReach = q.filter((e) => e.reachMs > 0);
    if (q.filter((e) => e.reachTried).length >= 2 && withReach.length) cats.REACH = withReach.sort((a, b) => a.reachMs - b.reachMs)[0].id;
    return { standings, categories: cats, weights };
}

// ── the clean IP (Android ArenaCleanIp.kt) ───────────────────────────────────────

function lastWinner() { return (readJson(PREFS, {}).ip || {})[network()] || null; }
function rememberWinner(ip) { const p = readJson(PREFS, {}); p.ip = p.ip || {}; p.ip[network()] = ip; writeJson(PREFS, p); }
function archiveIps(n) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        const raw = d.ipscanner_archived_ips;
        const list = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
        return list.filter((x) => x && x.healthy !== false).map((x) => CfUri.bareAddress(typeof x === 'string' ? x : x.ip)).filter(CfUri.isIpLiteral).reverse().slice(0, n);
    } catch (e) { return []; }
}
function sampleV4(n) {
    return require('./ip-provider').sampleFromRanges(CF_RANGES.map((cidr) => ({ cidr, provider: 'cloudflare' })), n).map((x) => x.ip);
}

async function chooseCleanIp(sample, extra, onStep) {
    const fam = require('./cf-family');
    await fam.hasIpv6RouteCached().catch(() => false);
    const v6 = fam.hasIpv6RouteNow() ? fam.sampleV6(15) : [];
    const v4 = sampleV4(30);
    const fresh = fam.preferV6() ? v6.concat(v4) : v4.concat(v6);
    const last = lastWinner();
    const cands = [...new Set([last, ...extra, ...archiveIps(30), ...fresh].filter(Boolean).map(CfUri.bareAddress).filter(CfUri.isIpLiteral))];
    if (!cands.length) return null;
    onStep(`پینگ ${cands.length} آی‌پی کلادفلر…`);
    const port = CfUri.parse(sample).port || 443;
    let answered = (await pool(cands, 16, async (ip) => [ip, await tcpMs(ip, port, 1200)])).filter((x) => x[1] > 0).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    if (fam.preferV6()) { const only6 = answered.filter(CfUri.isV6); if (only6.length) answered = only6; }
    const proven = [last, ...extra].filter((ip) => ip && answered.includes(ip));
    // With no verdict for this network, both families get seats: sorted by TCP time alone the twenty
    // were all IPv4 (it answers TCP faster here) — and on this line IPv4 carries nothing, so the
    // step found no IP at all (measured 2026-09-29). IPv6, IPv4, IPv6… — the real test decides.
    let ordered = answered;
    if (!fam.current()) {
        const a6 = answered.filter(CfUri.isV6), a4 = answered.filter((ip) => !CfUri.isV6(ip));
        ordered = [];
        for (let i = 0; i < Math.max(a6.length, a4.length); i++) { if (a6[i]) ordered.push(a6[i]); if (a4[i]) ordered.push(a4[i]); }
    }
    const open = [...new Set([...proven, ...ordered])].slice(0, Math.max(20, proven.length));
    if (!open.length) return null;
    onStep(`تست واقعی ${open.length} آی‌پی با کانفیگ پایه (هر کدام دو بار)…`);
    const real = (await pool(open, 5, async (ip) => {
        const uri = CfUri.rewrite(sample, ip);
        const a = await realMs(uri, 5000);
        if (!a) return null;
        const b = await realMs(uri, 5000);
        if (!b) return null;
        return { ip, ms: Math.max(a, b), spread: Math.abs(a - b) };   // the SLOWER shot: a lucky one cannot win
    })).filter(Boolean).sort((x, y) => x.ms - y.ms);
    if (!real.length) return null;
    onStep(`سرعت ${Math.min(2, real.length)} آی‌پی برتر (دانلود ۱ مگابایت، یکی‌یکی)…`);
    const timed = [];
    for (const r of real.slice(0, 2)) timed.push(Object.assign({}, r, { mbps: await mbpsOf(CfUri.rewrite(sample, r.ip)), tried: cands.length }));
    const withSpeed = timed.filter((t) => t.mbps != null).sort((a, b) => (b.mbps - a.mbps) || (a.ms - b.ms));
    return withSpeed[0] || timed[0];
}

// ── the race director (Android ArenaEngine.kt) ───────────────────────────────────

let state = idle();
let runToken = 0;
const listeners = new Set();
function idle() { return { phase: 'IDLE', mode: 'QUICK', lanes: [], progress: 0, session: null, error: null, cleanIp: null, cleanNote: null }; }
function emit() { for (const fn of listeners) { try { fn(state); } catch (e) {} } }
function set(patch) { state = Object.assign({}, state, patch); emit(); }
function lane(id, f) { state = Object.assign({}, state, { lanes: state.lanes.map((l) => (l.id === id ? f(Object.assign({}, l)) : l)) }); emit(); }
function out(id, fail, detail) { lane(id, (l) => Object.assign(l, { lane: 'OUT', note: detail || FAIL[fail], entry: Object.assign({}, l.entry, { fail, failDetail: detail || null }) })); }
const racing = () => state.lanes.filter((l) => l.lane === 'RACING' || l.lane === 'READY');

/** What preparation would do for `accId`: install what is missing, and what cannot be installed here. */
function plan(accId) {
    const acc = accounts().find((a) => a.id === accId);
    if (!acc) throw new Error('حساب کلادفلر پیدا نشد.');
    return PANELS.map((p) => {
        const a = adapter(p, acc);
        const inst = a.installed();
        return { id: p.id, name: p.name, color: p.color, letter: p.letter,
            action: inst ? 'NONE' : a.canInstall ? 'INSTALL' : 'SKIP',
            note: inst ? 'آماده' : a.canInstall ? 'نصب می‌شود' : (a.cantInstall || 'نصب نیست — از کارت حساب در بخش ابری نصبش کنید') };
    });
}

function start(accId, mode = 'QUICK', only = null) {
    if (state.phase !== 'IDLE' && state.phase !== 'DONE') throw new Error('یک مسابقه در جریان است.');
    const acc = accounts().find((a) => a.id === accId);
    if (!acc) throw new Error('حساب کلادفلر پیدا نشد.');
    const my = ++runToken;
    const alive = () => my === runToken;
    const preps = plan(accId).filter((p) => p.action !== 'SKIP' && (!only || only.includes(p.id)));
    if (!preps.length) throw new Error('هیچ پنلی برای مسابقه آماده یا قابل نصب نیست.');
    const started = Date.now();
    state = Object.assign(idle(), { phase: 'PREPARING', mode, accId,
        lanes: preps.map((p) => ({ id: p.id, name: p.name, color: p.color, letter: p.letter, lane: 'WAITING', note: null, entry: { id: p.id, name: p.name, latency: [], stability: [] } })) });
    emit();
    (async () => {
        const pending = {};
        const originals = {};
        try {
            // 1. preparation
            for (let i = 0; i < preps.length && alive(); i++) {
                const p = preps[i];
                set({ progress: i / preps.length });
                if (p.action === 'NONE') { lane(p.id, (l) => Object.assign(l, { lane: 'READY' })); continue; }
                lane(p.id, (l) => Object.assign(l, { lane: 'PIT', note: 'نصب…' }));
                try {
                    await adapter(PANELS.find((x) => x.id === p.id), acc).install((s) => lane(p.id, (l) => Object.assign(l, { note: String(s).replace(/^\[[^\]]+\]\s*/, '') })));
                    lane(p.id, (l) => Object.assign(l, { lane: 'READY', note: 'نصب شد' }));
                } catch (e) { out(p.id, 'NOT_INSTALLED', e.message); }
            }
            // 2. configs — a failed fetch is tried once more; by then the Worker route has probed
            // every address for the name and reports in words what it found.
            set({ phase: 'CONFIGS', progress: 0 });
            const ready = state.lanes.filter((l) => l.lane === 'READY');
            for (let i = 0; i < ready.length && alive(); i++) {
                const l = ready[i];
                set({ progress: i / ready.length });
                lane(l.id, (x) => Object.assign(x, { note: 'گرفتن کانفیگ…' }));
                const a = adapter(PANELS.find((x) => x.id === l.id), acc);
                let list = null, err = null;
                try { list = await a.candidates(); } catch (e) { err = e; }
                if (!list || !list.length) {
                    lane(l.id, (x) => Object.assign(x, { note: (require('./worker-route').latestReport() || 'دوباره…') }));
                    try { list = await a.candidates(); err = null; } catch (e) { err = e; }
                }
                if (!list || !list.length) out(l.id, 'NO_CONFIG', [require('./worker-route').latestReport(), err && err.message].filter(Boolean).join(' — ') || null);
                else { pending[l.id] = list; lane(l.id, (x) => Object.assign(x, { note: `${list.length} کانفیگ`, entry: Object.assign({}, x.entry, { candidates: list.length }) })); }
            }
            if (!alive()) return;
            // 3. the same clean IP for everyone
            set({ phase: 'CLEAN_IP', progress: 0, cleanNote: 'انتخاب کانفیگ آزمایشی…' });
            const firsts = Object.entries(pending).map(([id, list]) => [id, pick(list)[0]]);
            const tried = await pool(firsts, 3, async ([id, u]) => [id, u, await realMs(u, 8000)]);
            const sample = tried.filter((t) => t[2]).sort((a, b) => ((a[0] === 'BPB' ? 0 : 1) - (b[0] === 'BPB' ? 0 : 1)) || (a[2] - b[2]))[0];
            let chosen = null;
            if (sample) {
                const extra = [...new Set(Object.values(pending).flat().map((u) => CfUri.addressOf(u)).filter(CfUri.isIpLiteral))];
                try { chosen = await chooseCleanIp(sample[1], extra, (s) => set({ cleanNote: s })); } catch (e) { chosen = null; }
            }
            for (const k of Object.keys(pending)) {
                originals[k] = pending[k];
                pending[k] = pick(chosen ? pending[k].map((u) => CfUri.rewrite(u, chosen.ip)) : pending[k]);
            }
            // No shared IP: each panel races on its own address — through the self-healing layer
            // (cf-edge-heal.js), the same rule for everyone. A config on a Worker NAME is otherwise
            // resolved by the core itself and lands on dead IPv4 at random (Gozargah, 2026-09-29).
            if (!chosen) {
                const heal = require('./cf-edge-heal');
                let probed = false;
                for (const k of Object.keys(pending)) {
                    const out = [];
                    for (const u of pending[k]) {
                        const r = await heal.heal(u, { probe: !probed }).catch(() => ({ uri: u }));
                        probed = true;
                        out.push(r.uri);
                    }
                    pending[k] = out;
                }
            }
            if (chosen) { rememberWinner(chosen.ip); set({ cleanIp: chosen, cleanNote: null, progress: 1 }); }
            else set({ cleanNote: 'آی‌پی تمیز پایداری پیدا نشد؛ هر پنل با نشانی خودش مسابقه می‌دهد.', progress: 1 });
            // 4. qualifying — and the safe fall-back: if the clean IP carried nobody, everyone
            // requalifies on their own addresses (still one rule for all) and the screen says so.
            await qualify(pending, alive);
            if (chosen && !racing().length) {
                const retry = state.lanes.filter((l) => l.lane === 'OUT' && originals[l.id] && ['UNREACHABLE', 'TLS_REFUSED', 'NO_RESPONSE'].includes(l.entry.fail));
                if (retry.length) {
                    for (const l of retry) { pending[l.id] = pick(originals[l.id]); lane(l.id, (x) => Object.assign(x, { lane: 'READY', note: null, entry: Object.assign({}, x.entry, { fail: null, failDetail: null }) })); }
                    set({ cleanIp: null, cleanNote: 'هیچ کانفیگی با آی‌پی تمیز جواب نداد؛ همه با نشانی خودشان مسابقه می‌دهند.' });
                    await qualify(pending, alive);
                }
            }
            // 5. the rounds
            await roundRobin('LATENCY', 3, 0, alive, async (l) => {
                const ms = await realMs(l.entry.uri, 10000);
                lane(l.id, (x) => Object.assign(x, { entry: Object.assign({}, x.entry, { latency: x.entry.latency.concat([{ at: Date.now(), ms }]) }) }));
            });
            await roundRobin('REACH', 1, 0, alive, async (l) => {
                const ms = await realMs(l.entry.uri, 10000, REACH_URL);
                lane(l.id, (x) => Object.assign(x, { entry: Object.assign({}, x.entry, { reachTried: true, reachMs: ms }) }));
            });
            if (mode === 'FULL') {
                await roundRobin('SPEED', 1, 0, alive, async (l) => {
                    // One download that fails is retried once — for every panel alike: a single
                    // dropped transfer read Spider as «no speed» while three runs after gave 5.8–13.8.
                    const mbps = (await mbpsOf(l.entry.uri)) || (await mbpsOf(l.entry.uri));
                    lane(l.id, (x) => Object.assign(x, { entry: Object.assign({}, x.entry, { mbps, speedTried: true }) }));
                });
                await roundRobin('STABILITY', 6, 3000, alive, async (l) => {
                    const ms = await realMs(l.entry.uri, 8000);
                    lane(l.id, (x) => Object.assign(x, { entry: Object.assign({}, x.entry, { stability: x.entry.stability.concat([{ at: Date.now(), ms }]) }) }));
                });
            }
            if (!alive()) return;
            const session = { id: 'arena-' + started, startedAt: started, finishedAt: Date.now(), mode, network: network(), networkLabel: networkLabel(),
                accId, cleanIp: state.cleanIp ? state.cleanIp.ip : null, entries: state.lanes.map((l) => l.entry) };
            session.board = score(session.entries);
            addHistory(session);
            set({ phase: 'DONE', progress: 1, session, lanes: state.lanes.map((l) => (l.lane === 'RACING' ? Object.assign({}, l, { lane: 'FINISHED' }) : l)) });
        } catch (e) {
            if (alive()) set({ phase: 'DONE', error: e.message });
        }
    })();
    return state;
}

/** Up to three candidates, the plain TLS-on-443 ones first: the panel's most typical config. */
function pick(list) {
    const ranked = list.map((u) => [u, CfUri.parse(u)]).filter((x) => x[1])
        .sort((a, b) => ((a[1].port === 443 ? 0 : 1) + (a[1].tls === 'tls' ? 0 : 2)) - ((b[1].port === 443 ? 0 : 1) + (b[1].tls === 'tls' ? 0 : 2)))
        .map((x) => x[0]);
    const uniq = [...new Set(ranked)];
    return (uniq.length ? uniq : list).slice(0, MAX_CANDIDATES);
}

async function qualifyOne(uri) {
    const p = CfUri.parse(uri);
    if (!p || !p.address) return { fail: 'INVALID' };
    // A Worker NAME is resolved first, outside the 3-second TCP clock: the Worker route probes the
    // name's addresses before it answers, and with nine qualifiers at once that alone ran past three
    // seconds — three panels whose configs carried data were called «unreachable» (2026-09-29).
    let addr = p.address;
    if (!CfUri.isIpLiteral(addr)) {
        addr = await new Promise((r) => require('dns').lookup(addr, (e, a) => r(e ? null : a)));
        if (!addr) return { fail: 'UNREACHABLE' };
    }
    if ((await tcpMs(addr, p.port, 3000)) < 0) return { fail: 'UNREACHABLE' };
    // The TLS + first-request check only NAMES a failure; the real request decides. Nova answers a
    // bare first request in a way the check reads as a refusal, while its tunnel works (297 ms).
    const scout = require('./scan-scout');
    const [okTls, ms] = await Promise.all([scout.alive(addr, p.port, scout.target(uri)).catch(() => false), realMs(uri, 10000)]);
    if (ms) return { ms };
    return { fail: okTls ? 'NO_RESPONSE' : 'TLS_REFUSED' };
}

async function qualify(pending, alive) {
    set({ phase: 'QUALIFY', progress: 0 });
    const lanes = state.lanes.filter((l) => l.lane === 'READY' && pending[l.id]);
    let done = 0;
    await pool(lanes, 3, async (l) => {
        if (!alive()) return;
        lane(l.id, (x) => Object.assign(x, { note: 'تعیین صلاحیت…' }));
        const results = await pool(pending[l.id], 3, async (u) => [u, await qualifyOne(u)]);
        const best = results.filter((r) => r[1].ms).sort((a, b) => a[1].ms - b[1].ms)[0];
        if (best) lane(l.id, (x) => Object.assign(x, { lane: 'RACING', note: null, entry: Object.assign({}, x.entry, { uri: best[0], qualifyMs: best[1].ms }) }));
        else {
            // The furthest any candidate got says the most: a TLS refusal beats «unreachable».
            const fails = results.map((r) => r[1].fail).filter(Boolean);
            const fail = fails.sort((a, b) => FAIL_ORDER.indexOf(b) - FAIL_ORDER.indexOf(a))[0] || 'NO_RESPONSE';
            out(l.id, fail, null);
        }
        done++;
        set({ progress: done / lanes.length });
    });
}

async function roundRobin(phase, samples, gapMs, alive, measure) {
    set({ phase, progress: 0 });
    const ids = racing().map((l) => l.id);
    if (!ids.length) return;
    const total = samples * ids.length;
    let n = 0;
    for (let k = 0; k < samples && alive(); k++) {
        for (const id of ids) {
            if (!alive()) return;
            await measure(state.lanes.find((l) => l.id === id));
            n++;
            set({ progress: n / total });
        }
        if (gapMs && k < samples - 1) await sleep(gapMs);
    }
}

function cancel() { runToken++; state = idle(); emit(); }
function reset() { if (state.phase === 'DONE') { state = idle(); emit(); } }

// ── history (Android ArenaStore.kt) ──────────────────────────────────────────────

function history() { return readJson(HISTORY, []); }
function addHistory(s) {
    const list = [s].concat(history().filter((x) => x.id !== s.id)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
    writeJson(HISTORY, list);
}
/** The newest race on this network within 24 hours — «current»; everything else is history. */
function latest() {
    const net = network();
    return history().find((s) => s.network === net && Date.now() - s.finishedAt < 24 * 3600 * 1000) || null;
}

module.exports = {
    setInstallers, pendingPatches, ackPatches, get installers() { return installers; },
    PANELS, FAIL, plan, start, cancel, reset, history, latest, score, pick,
    _zeusCandidates: zeusCandidates,   // tests
    get state() { return state; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
