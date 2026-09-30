// --- GitHub Tunnel v2: the client engine ---
//
// v1 carried traffic as WireGuard over a hole-punched UDP path to the runner. Measured on a
// user's line (2026-09-22): the path was DIRECT, the runner had ~700 Mbit/s and the line 17,
// and the tunnel still gave under 1 Mbit/s — Iran throttles WireGuard's shape, so no tuning
// could fix it. v2 carries it as VLESS over WebSocket through Cloudflare instead:
//
//   this PC ──TLS (SNI: the user's own Worker)──► clean Cloudflare IP ──► the user's Worker
//     ──/p/<signed pass>──► <label>.trycloudflare.com ──► cloudflared on the runner ──► Xray
//
// The Worker hop exists because *.trycloudflare.com itself is blocked from Iran (DNS and SNI,
// measured 2026-09-23). Through it the same line measured 34–45 Mbit/s against a line of
// 22–49: effectively the whole line.
//
// The core is a PRIVATE copy of the app's Xray named gtcore.exe, in the admin-only store
// folder, hash-checked before every launch: the shared xray.exe is `taskkill /IM`'d by other
// features, shares stats port 20085 and core\config.json, and a binary in a user-writable
// folder launched by an elevated app is a privilege-escalation hole. Its configuration holds
// the session's credentials, so it is handed over on stdin and never written to disk.
//
// The contract with routes.js is gt-engine.js's (v1) — connect/disconnect/getStatus/
// verifyTunnel/readTrafficCounters/… — so the orchestration, the guards and the panel treat
// both the same way. See gt-dataplane.js for which one is live.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const corePaths = require('../core-paths');
const fp = require('../tls-fingerprint');
const secret = require('./gt-secret');
const cleanip = require('./gt-cleanip');

const PROCESS_NAME = 'gtcore.exe';
const SOCKS_PORT = 20812;
const HTTP_PORT = 20813;
const API_PORT = 20814;
const ENGINE_LABEL = 'GitHub Tunnel';
// v2 has no adapter of its own: its full tunnel is the shared tun-manager's, built by routes.js
// on top of this engine's SOCKS port — so the guard's allow rule names that adapter.
const TUN_ADAPTER = 'MLMVPN';
const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const DAEMON_LOG = path.join(HOME_DIR, 'gt-core.log');

// Quick tunnels refuse more than 200 in-flight requests each, and a full Windows machine goes
// past that easily with one WebSocket per connection — so connections are multiplexed. 8 per
// WebSocket measured the same throughput as none, with ~420 ms instead of ~1 s to open a new
// connection (the WebSocket is already up).
const DEFAULT_MUX = 8;
const WATCHDOG_INTERVAL_MS = 20000;
const BAD_VERDICTS_BEFORE_DEGRADE = 2;
const MAX_REPAIR_ATTEMPTS = 3;
// Between failed repairs: a runner that is replacing a quick tunnel needs tens of seconds, and
// hammering it meanwhile only spends the attempts.
const REPAIR_BACKOFF_MS = [3000, 10000, 30000];

let child = null;
let state = blank();
let transportCache = null; // { sessionId, transport }
let watchdog = null;
let badVerdicts = 0;
let repairs = 0;
let onDegraded = null;
let onRebuild = null;
let onGaveUp = null;
let watchdogLog = null;
let livenessCheck = null;
// THE REPAIR MUST OUTLIVE ITS OWN RECONNECT. A rebuild goes through connect(), which used to
// stop the watchdog and zero its count on the way in — so a failed repair left nothing watching
// and «three attempts» never counted past one. `intent` is the mode somebody asked for (cleared
// only by a disconnect from outside), `generation` moves on every connect and every outside
// disconnect so a repair that slept through one knows its turn is over, and `repairing` keeps the
// count across the reconnect the watchdog itself started.
let intent = null;
let generation = 0;
let repairing = false;
let ticking = false;
const emergencyUndo = [];

// ── the status channel (runner/xray-config.mjs) ─────────────────────────────────
// Every minute the runner is asked, THROUGH the tunnel, for its sealed status: a quick tunnel it
// had to replace, or its own end coming. Any live host carries the question, so this works when
// GitHub is unreachable and when the kill switch has the machine's own DNS shut.
const STATUS_HOST = 'status.gt.internal';
const STATUS_EVERY_MS = 60000;
let statusTimer = null;
let statusBusy = false;
let statusSession = null;
let onTransport = null;   // (session, sealed, payload) → the stored session, updated
let onEnding = null;      // (payload) → the runner says its session ends soon

function blank() {
    return { running: false, connected: false, mode: '', error: '', sessionId: '', ips: [], frag: false, mux: DEFAULT_MUX, exit: null, startedAt: 0 };
}

// ── the core binary ─────────────────────────────────────────────────────────────
function coreDir() {
    if (process.env.MLMVPN_GT_CORE_DIR) return path.resolve(process.env.MLMVPN_GT_CORE_DIR);
    return path.join(corePaths.storeRoot(), 'gt');
}
const daemonExe = () => path.join(coreDir(), PROCESS_NAME);
function sourceXray() { return corePaths.file('xray', 'xray.exe', corePaths.bundled('core', 'xray.exe')); }
function xrayVersion() {
    return corePaths.activeVersion('xray') || require('../store/shipped').SHIPPED.xray.version;
}

function hashFile(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('error', reject);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/**
 * gtcore.exe, byte-identical to the Xray the app would run, checked right before launch.
 * Copied through a side name and renamed, so an interrupted copy never looks ready.
 */
async function ensureCore(onLog) {
    const src = sourceXray();
    const dst = daemonExe();
    const want = await hashFile(src);
    let have = null;
    try { have = await hashFile(dst); } catch (e) {}
    if (have !== want) {
        try { onLog && onLog('در حال آماده‌سازی هستهٔ تونل…'); } catch (e) {}
        fs.mkdirSync(coreDir(), { recursive: true });
        const staging = `${dst}.part`;
        fs.copyFileSync(src, staging);
        fs.renameSync(staging, dst);
        have = await hashFile(dst);
        if (have !== want) throw new Error('هستهٔ تونل درست کپی نشد.');
    }
    return { exe: dst, sha256: want, version: xrayVersion() };
}
function binariesReady() { return fs.existsSync(daemonExe()); }
const ensureBinaries = (onLog) => ensureCore(onLog);

// ── the session's transport ─────────────────────────────────────────────────────
/**
 * The runner's credentials, from the sealed file it published (gt-session-crypto.js). The key
 * that opens it is DPAPI-protected on disk; it is unwrapped once per session and kept in
 * memory, because DPAPI goes through a synchronous PowerShell and connect is a click path.
 */
// A few sessions, not one: make-before-break talks to the current session AND the next one, and a
// single entry would flip between them — a synchronous PowerShell per flip.
const keyCache = new Map(); // sessionId → jwk
function sealKeyFor(session) {
    if (keyCache.has(session.id)) return keyCache.get(session.id);
    const { unprotect } = require('./gt-crypto');
    const jwk = JSON.parse(unprotect(session.v2.sealKey));
    keyCache.set(session.id, jwk);
    while (keyCache.size > 4) keyCache.delete(keyCache.keys().next().value);
    return jwk;
}

function transportFor(session) {
    if (!session || session.dataPlane !== 'v2' || !session.v2 || !session.v2.sealed) throw new Error('این نشست ابری مال نسخهٔ جدید تونل نیست.');
    if (transportCache && transportCache.sessionId === session.id && transportCache.rev === (session.v2.rev || 0)) return transportCache.transport;
    const transport = require('./gt-session-crypto').open(sealKeyFor(session), session.v2.sealed, session.id);
    validateTransport(transport);
    transportCache = { sessionId: session.id, rev: session.v2.rev || 0, transport };
    return transport;
}

// What the runner hands us ends up in a config and a URL path. Nothing unexpected gets in.
function validateTransport(t) {
    const hostOk = (h) => typeof h === 'string' && /^[a-z0-9-]{3,63}\.trycloudflare\.com$/.test(h);
    // The stable tunnel (gt-slots.js), when the session has one: only which slot and whether its
    // connector is up — the destination itself is fixed in the Worker, never taken from here.
    const hasSlot = t && t.slot !== undefined && t.slot !== null;
    if (hasSlot && !(SLOT_NAMES.includes(t.slot.name) && typeof t.slot.ready === 'boolean')) throw new Error('اطلاعات نشست ابری معتبر نیست (مسیر پایدار).');
    if (!t || !Array.isArray(t.hosts) || !t.hosts.every((h) => hostOk(h.host || h))) throw new Error('اطلاعات نشست ابری معتبر نیست (نشانی تونل).');
    // No quick tunnel at all is fine only when the stable one answers.
    if (!t.hosts.length && !(hasSlot && t.slot.ready)) throw new Error('اطلاعات نشست ابری معتبر نیست (نشانی تونل).');
    if (typeof t.wsPath !== 'string' || !/^\/[A-Za-z0-9_-]{8,64}$/.test(t.wsPath)) throw new Error('اطلاعات نشست ابری معتبر نیست (مسیر).');
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uuid = t.uuids && t.uuids.direct;
    if (typeof uuid !== 'string' || !UUID.test(uuid)) throw new Error('اطلاعات نشست ابری معتبر نیست (شناسه).');
    // The exit slots (runner/exits.mjs): x1…x6, each a user of its own. Nothing else is accepted.
    for (const [k, v] of Object.entries(t.uuids)) {
        if (!/^(direct|x[1-6])$/.test(k) || typeof v !== 'string' || !UUID.test(v)) throw new Error('اطلاعات نشست ابری معتبر نیست (شناسهٔ خروجی).');
    }
    return true;
}
const SLOT_NAMES = ['a', 'b', 'c'];
const hostsOf = (t) => t.hosts.map((h) => h.host || h).filter(Boolean);
const labelOf = (host) => host.replace(/\.trycloudflare\.com$/, '');

/**
 * The stable slot this session may use: the one it was dispatched with (session.v2.slot), and
 * only while its runner says the connector is up. '' otherwise.
 */
function slotOf(session, transport) {
    const k = session && session.v2 && session.v2.slot;
    return SLOT_NAMES.includes(k) && transport && transport.slot && transport.slot.name === k && transport.slot.ready ? k : '';
}

/** For the panel: the session's slot, whether its connector is up, whether this connection rides it. */
function slotInfo(session, transport, used) {
    const k = session && session.v2 && session.v2.slot;
    if (!SLOT_NAMES.includes(k)) return null;
    return { name: k, ready: !!(transport && transport.slot && transport.slot.name === k && transport.slot.ready), used: !!used && !!slotOf(session, transport) };
}

/**
 * The ways into a session, best first — the stable slot, then the quick tunnels — each as a
 * maker of the exact outbound the tunnel will use (the clean-IP measurement tries this object).
 */
function pathsOf(session, transport, host) {
    const exp = session.expiresAt || (Date.now() + 6 * 3600e3);
    const out = [];
    const slot = slotOf(session, transport);
    if (slot) {
        const pass = secret.signSlotPass(slot, session.id, exp);
        out.push({ via: 'slot', make: (ip, { frag }) => buildOutbound({ ip, host, transport, frag, mux: DEFAULT_MUX, pass }) });
    }
    const hosts = hostsOf(transport);
    if (hosts.length) {
        const pass = secret.signPass(labelOf(hosts[0]), session.id, exp);
        out.push({ via: 'quick', make: (ip, { frag }) => buildOutbound({ ip, host, transport, frag, mux: DEFAULT_MUX, pass }) });
    }
    return out;
}

function brokerHost() {
    const url = require('./gt-broker-deploy').getBrokerUrl();
    if (!url) throw Object.assign(new Error('سرویس شبکهٔ امن (Worker کلادفلر شما) هنوز راه‌اندازی نشده است.'), { code: 'BROKER_NOT_DEPLOYED' });
    return new URL(url).host;
}

// ── configuration ───────────────────────────────────────────────────────────────
/** The exact outbound the tunnel uses — the clean-IP measurement tries this very object. */
function buildOutbound({ ip, host, pass, transport, frag, mux, user = 'direct' }) {
    // `user`: which of the runner's users — `direct` (the runner's own address) or an exit slot.
    const id = (transport.uuids && transport.uuids[user]) || transport.uuids.direct;
    const ob = {
        protocol: 'vless',
        settings: { vnext: [{ address: ip, port: 443, users: [{ id, encryption: 'none' }] }] },
        streamSettings: {
            network: 'ws',
            security: 'tls',
            // http/1.1 ONLY: offered h2, Cloudflare picks it, and a WebSocket cannot ride h2.
            // No allowInsecure anywhere — fatal in Xray ≥ 26.7.28, and never needed: the
            // certificate is the Worker's real one.
            tlsSettings: { serverName: host, fingerprint: 'chrome', alpn: ['http/1.1'] },
            wsSettings: { path: `/p/${pass}${transport.wsPath}?ed=2560`, host, heartbeatPeriod: 30 },
        },
        // TCP multiplexed (quick-tunnel in-flight cap), UDP carried as XUDP, and QUIC refused so
        // browsers use TCP instead of UDP-inside-TCP.
        // `mux: -1` (the stable slot): TCP gets its own WebSocket, UDP still rides XUDP.
        mux: { enabled: true, concurrency: mux || DEFAULT_MUX, xudpConcurrency: 16, xudpProxyUDP443: 'reject' },
    };
    if (frag) {
        ob.streamSettings.tlsSettings.fingerprint = fp.FINGERPRINT;
        ob.streamSettings.tlsSettings.cipherSuites = fp.CIPHER_SUITES;
        ob.streamSettings.finalmask = JSON.parse(JSON.stringify(fp.FINAL_MASK));
    }
    return ob;
}

/**
 * Every tunnel host × every chosen clean IP, behind one balancer that keeps sending traffic to
 * whichever still answers — so an address that gets filtered mid-session costs a retry, not
 * the connection.
 */
/**
 * The exit plan, checked against what the runner actually offers (runner/exits.mjs): `use` — the
 * user every connection leaves by (`direct` = the runner's own address, or an exit slot x1…x6);
 * `rules` — domains that leave by another slot. Anything the transport has no user for is dropped.
 */
function normalizePlan(plan, transport) {
    const users = (transport && transport.uuids) || {};
    const ok = (id) => typeof id === 'string' && /^x[1-6]$/.test(id) && !!users[id];
    const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
    const use = plan && ok(plan.use) ? plan.use : 'direct';
    const rules = [];
    for (const r of (plan && Array.isArray(plan.rules) ? plan.rules : [])) {
        if (!r || !ok(r.id) || r.id === use) continue;
        const domains = [...new Set((Array.isArray(r.domains) ? r.domains : []).map((d) => String(d).trim().toLowerCase().replace(/^\*\./, '')).filter((d) => DOMAIN.test(d)))].slice(0, 200);
        if (domains.length) rules.push({ id: r.id, domains });
    }
    return { use, rules };
}

function buildConfig({ session, transport, host, ips, frag, mux, listen = '127.0.0.1', useSlot = true, exitPlan = null }) {
    const exp = session.expiresAt || (Date.now() + 6 * 3600e3);
    // WHICH COUNTRY (P4, runner/exits.mjs): the runner's own address, or one of its exit slots —
    // a different VLESS user on the same tunnel, never a second tunnel here.
    const plan = normalizePlan(exitPlan, transport);
    const user = plan.use;
    // THE STABLE SLOT (gt-slots.js), when this session has one: `gt-s<n>`, WITHOUT TCP mux. A
    // named tunnel has no in-flight cap to multiplex around, and multiplexing has a price measured
    // 2026-09-23: after one large transfer is cancelled, the data still in flight for it holds the
    // WebSocket every other connection shares — 0 Mbit for the next test, 9 of 16 small requests
    // answered in 10 s. One WebSocket per connection means a cancelled download stalls nothing
    // else. UDP still rides XUDP.
    const slotOuts = [];
    const slot = useSlot ? slotOf(session, transport) : '';
    if (slot) {
        const pass = secret.signSlotPass(slot, session.id, exp);
        for (const ip of ips) slotOuts.push({ ...buildOutbound({ ip, host, pass, transport, frag, mux: -1, user }), tag: `gt-s${slotOuts.length}` });
    }
    // The quick tunnels, `gt-<n>`, multiplexed: 200 requests in flight each, or they refuse.
    const quickOuts = [];
    for (const h of hostsOf(transport)) {
        const pass = secret.signPass(labelOf(h), session.id, exp);
        for (const ip of ips) quickOuts.push({ ...buildOutbound({ ip, host, pass, transport, frag, mux, user }), tag: `gt-${quickOuts.length}` });
    }
    // SITE RULES («این سایت‌ها از فلان کشور»): per rule, the best path only (the slot, else the first
    // quick tunnel) × the clean addresses, as ITS user, behind its own balancer and a domain rule
    // ahead of the default. `gx-` so no main balancer's `gt-` selector ever picks them up.
    const ruleOuts = [];
    const ruleBalancers = [];
    const ruleRules = [];
    const firstHost = hostsOf(transport)[0];
    plan.rules.forEach((r, i) => {
        const pass = slot ? secret.signSlotPass(slot, session.id, exp) : firstHost ? secret.signPass(labelOf(firstHost), session.id, exp) : null;
        if (!pass) return;
        const base = `gx-r${i}-`;
        ips.forEach((ip, n) => ruleOuts.push({ ...buildOutbound({ ip, host, pass, transport, frag, mux: slot ? -1 : mux, user: r.id }), tag: `${base}${n}` }));
        ruleBalancers.push({ tag: `gx-r${i}`, selector: [base], strategy: { type: 'leastPing' }, fallbackTag: `${base}0` });
        ruleRules.push({ type: 'field', domain: r.domains.map((d) => `domain:${d}`), balancerTag: `gx-r${i}` });
    });
    const outbounds = [...slotOuts, ...quickOuts, ...ruleOuts];
    // With a slot, the balancer takes ONLY its outbounds and falls back to a quick tunnel when the
    // observatory finds them all dead — the stable path is preferred, not merely one candidate
    // among the multiplexed ones.
    const balancer = slotOuts.length
        ? { tag: 'gt', selector: ['gt-s'], strategy: { type: 'leastPing' }, fallbackTag: quickOuts.length ? 'gt-0' : 'gt-s0' }
        : { tag: 'gt', selector: ['gt-'], strategy: { type: 'leastPing' }, fallbackTag: 'gt-0' };
    return {
        // No access log: every destination the user visits would otherwise be written down.
        log: { loglevel: 'warning', access: 'none' },
        inbounds: [
            { tag: 'socks', listen, port: SOCKS_PORT, protocol: 'socks', settings: { udp: true, auth: 'noauth' },
              sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: true } },
            { tag: 'http', listen, port: HTTP_PORT, protocol: 'http', settings: {} },
            { tag: 'api', listen: '127.0.0.1', port: API_PORT, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
        ],
        outbounds: [...outbounds, { tag: 'block', protocol: 'blackhole' }],
        api: { tag: 'api', services: ['StatsService'] },
        stats: {},
        policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
        observatory: { subjectSelector: ruleOuts.length ? ['gt-', 'gx-'] : ['gt-'], probeUrl: 'https://www.gstatic.com/generate_204', probeInterval: '60s', enableConcurrency: true },
        routing: {
            domainStrategy: 'AsIs',
            balancers: [balancer, ...ruleBalancers],
            rules: [
                { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
                // Nothing on the user's own network leaves through the runner.
                { type: 'field', ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16'], outboundTag: 'block' },
                ...ruleRules,
                { type: 'field', network: 'tcp,udp', balancerTag: 'gt' },
            ],
        },
    };
}

// ── process ─────────────────────────────────────────────────────────────────────
function startCore(exe, cfg) {
    const out = fs.openSync(DAEMON_LOG, 'w');
    const p = spawn(exe, ['run', '-c', 'stdin:'], { windowsHide: true, stdio: ['pipe', out, out] });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(cfg));
    p.on('exit', (code) => {
        if (child === p) {
            child = null;
            if (state.connected) { state.connected = false; state.error = 'NOT_RUNNING'; }
            state.running = false;
        }
        try { fs.closeSync(out); } catch (e) {}
        void code;
    });
    return p;
}

function killChild(p) {
    return new Promise((resolve) => {
        if (!p || p.exitCode !== null) return resolve();
        const t = setTimeout(() => { try { process.kill(p.pid, 'SIGKILL'); } catch (e) {} resolve(); }, 3000);
        p.once('exit', () => { clearTimeout(t); resolve(); });
        try { p.kill(); } catch (e) { clearTimeout(t); resolve(); }
    });
}

function logTail(n = 8) {
    try { return fs.readFileSync(DAEMON_LOG, 'utf8').split('\n').filter(Boolean).slice(-n); } catch (e) { return []; }
}

// ── connect / disconnect ────────────────────────────────────────────────────────
const MODES = ['proxy', 'engine', 'tun'];
const WARMUP_TRIES = 4;
const WARMUP_SPACING_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * pick() and, when the Worker answers with a 5xx from behind it (a tunnel still warming up), a
 * bounded wait on the addresses that reached the Worker — see connect().
 */
async function pickWarm({ exe, make, tries, onLog, log }) {
    let picked = await cleanip.pick({ exe, buildOutbound: make, want: 2, onLog });
    for (let i = 0; !picked.ips.length && farSideWarming(picked.refused) && i < tries; i++) {
        if (i === 0) log('خط شما به Worker می‌رسد ولی تونل سرور ابری هنوز از آنجا جواب نمی‌دهد — چند ثانیه صبر…');
        await sleep(WARMUP_SPACING_MS);
        const diag = {};
        const r = picked.refused;
        const results = await cleanip.measure({ exe, ips: r.ips, buildOutbound: make, frag: r.frag, diag });
        if (results.length) picked = { ips: results.slice(0, 2).map((x) => x.ip), frag: r.frag, tried: picked.tried, results };
        else picked.refused = cleanip.refusalOf(diag, r.frag) || r;
    }
    return picked;
}

/** The Worker was reached and something behind it failed — a tunnel still warming, or gone. */
const farSideWarming = (r) => !!r && r.status >= 500 && r.status !== 503;

/**
 * Nothing got through: say WHICH side, from what the Worker answered (gt-cleanip.js › refusalsIn).
 * Each code has its own finding and button in the panel (github-tunnel.js › GT_ADVICE).
 */
function noPathError(picked) {
    const r = picked.refused;
    const say = (code, fa) => Object.assign(new Error(fa), { code, httpStatus: r ? r.status : null });
    if (r && r.status === 401) {
        return say('SESSION_ENDED', 'Worker کلادفلر شما می‌گوید برگهٔ عبور این نشست منقضی شده است. یک نشست تازه بسازید؛ اگر تکرار شد، ساعت و تاریخ ویندوز را بررسی کنید.');
    }
    if (r && (r.status === 404 || r.status === 503)) {
        return say('BROKER_NEEDS_UPDATE', `خط شما به Worker کلادفلرتان می‌رسد، ولی Worker این اتصال را نمی‌شناسد (HTTP ${r.status}) — «سرویس شبکهٔ امن» باید دوباره راه‌اندازی شود.`);
    }
    if (r && r.status === 429) {
        return say('BROKER_LIMIT', 'Worker کلادفلر شما درخواست‌ها را محدود کرده است (HTTP 429) — معمولاً یعنی سقف روزانهٔ حساب رایگان کلادفلر پر شده و فردا دوباره باز می‌شود.');
    }
    if (r && r.status >= 500) {
        return say('TUNNEL_UNREACHABLE', `خط شما به Worker کلادفلرتان می‌رسد، ولی Worker به سرور ابری نمی‌رسد (HTTP ${r.status}) — سرور ابری یا تونل‌هایش دیگر جواب نمی‌دهند. یک نشست تازه بسازید.`);
    }
    if (r) {
        return say('BROKER_REFUSED', `Worker کلادفلر شما این اتصال را رد کرد (HTTP ${r.status}).`);
    }
    return say('NO_CLEAN_IP', `هیچ آی‌پی کلادفلری از این خط به سرویس شبکهٔ امن شما نرسید (${picked.tried.toLocaleString('fa-IR')} نشانی امتحان شد). اگر فیلترشکن دیگری روشن است خاموشش کنید؛ اگر نه، از بخش «اسکن» آی‌پی تمیز تازه پیدا کنید.`);
}

/**
 * @param session  a v2 session record (gt-config.js), sealed transport included
 * @param mode     'proxy' (system proxy on our HTTP port), 'engine' (ports only, for the game
 *                 tab) or 'tun' (ports only here — routes.js builds the shared full tunnel on
 *                 top of them; the mode is recorded so the watchdog, the guards and the traffic
 *                 feed know the whole machine rides this engine).
 */
async function connect({ session, mode = 'proxy', onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (!MODES.includes(mode)) {
        throw Object.assign(new Error(`حالت اتصال ناشناخته است: ${mode}`), { code: 'MODE_UNSUPPORTED' });
    }
    generation++;
    intent = mode;
    await reset();
    const transport = transportFor(session);
    const host = brokerHost();
    const core = await ensureCore(onLog);

    // THE LINE IS FINE, THE FAR SIDE IS NOT (YET): the Worker answered, with an error from behind
    // it. A quick tunnel that has only just come up can take a few seconds to answer from the
    // Worker's Cloudflare location even though the runner's own check passed (measured: a connect
    // 2 s after «ready» found nothing, one 3 s after worked). Waited out on the addresses that
    // reached the Worker — they are proven for this line — instead of blaming the line.
    //
    // The stable slot is measured first, the quick tunnels only if the slot's far side failed:
    // the line part (TLS to the Worker, on these addresses) is the same for both, so a line that
    // reaches nothing is not measured twice.
    const paths = pathsOf(session, transport, host);
    let picked = { ips: [], tried: 0, results: [], refused: null };
    let via = '';
    for (const p of paths) {
        picked = await pickWarm({ exe: core.exe, make: p.make, tries: p.via === 'slot' ? 2 : WARMUP_TRIES, onLog, log });
        if (picked.ips.length) { via = p.via; break; }
        if (!picked.refused) break;
        if (p.via === 'slot' && paths.length > 1) log('مسیر پایدار هنوز از Worker جواب نمی‌دهد — این بار از تونل‌های موقت کلادفلر.');
    }
    if (!picked.ips.length) {
        const err = noPathError(picked);
        state = { ...blank(), error: err.code };
        throw err;
    }
    log(`آی‌پی‌های تمیز: ${picked.ips.join('، ')} — ${picked.results[0].delayMs.toLocaleString('fa-IR')} میلی‌ثانیه${picked.frag ? ' (با شکستن دست‌دادن TLS)' : ''}${via === 'slot' ? ' — از مسیر پایدار' : ''}`);

    // A slot that failed its measurement stays out of this connection: its outbounds would only be
    // the balancer's fallback into a dead path.
    const useSlot = via === 'slot';
    const cfg = buildConfig({ session, transport, host, ips: picked.ips, frag: picked.frag, mux: DEFAULT_MUX, useSlot });
    child = startCore(core.exe, cfg);
    state = { ...blank(), running: true, mode, sessionId: session.id, ips: picked.ips, frag: picked.frag, startedAt: Date.now(), slot: slotInfo(session, transport, useSlot) };

    // The first probe waits for the port instead of failing on it and sleeping 1.5 s.
    await cleanip.waitPort(SOCKS_PORT, 5000);
    const verdict = await verifyTunnel(mode, { attempts: 4 });
    if (!verdict.ok) {
        const tail = logTail(4).join(' | ');
        await reset();
        state.error = verdict.code;
        throw Object.assign(new Error(`${verdict.message}${tail ? ` (${tail.slice(0, 240)})` : ''}`), { code: verdict.code });
    }
    state.connected = true;
    state.error = '';
    state.delayMs = verdict.delayMs;
    log(`تونل برقرار شد — ${verdict.delayMs.toLocaleString('fa-IR')} میلی‌ثانیه تا اینترنت.`);
    locateExit().then((exit) => { if (exit && child) { state.exit = exit; log(`خروجی: ${exit.country || '?'}${exit.city ? ` (${exit.city})` : ''} — ${exit.ip}`); } }).catch(() => {});
    startWatchdog();
    startStatusWatch(session);
    return { mode, socksPort: SOCKS_PORT, httpPort: HTTP_PORT };
}

/**
 * The runner's own word, asked through the tunnel: its sealed status (same seal, same key as
 * the repo copy — a tampered or foreign one fails to open). Null when it cannot be had.
 */
async function fetchStatus(session, { timeoutMs = 12000 } = {}) {
    if (!child || !state.running || !session) return null;
    const r = await cleanip.socksHttpGet(SOCKS_PORT, STATUS_HOST, '/s', { timeoutMs, collect: true });
    if (!r || r.status !== 200 || !r.body) return null;
    return openStatus(session, r.body);
}

/** The status body, opened with this session's key — null if it is not JSON; throws if forged. */
function openStatus(session, body) {
    let sealed;
    try { sealed = JSON.parse(body); } catch (e) { return null; }
    const payload = require('./gt-session-crypto').open(sealKeyFor(session), sealed, session.id);
    return { sealed, payload };
}

function startStatusWatch(session) {
    stopStatusWatch();
    statusSession = session;
    statusTimer = setInterval(() => { statusTick().catch(() => {}); }, STATUS_EVERY_MS);
    if (statusTimer.unref) statusTimer.unref();
}
function stopStatusWatch() { if (statusTimer) clearInterval(statusTimer); statusTimer = null; }

async function statusTick() {
    if (statusBusy || !state.connected || !statusSession) return;
    statusBusy = true;
    try {
        let st = null;
        try { st = await fetchStatus(statusSession); } catch (e) { st = null; }
        if (!st || !state.connected) return;
        const p = st.payload;
        state.statusAt = Date.now();
        state.endsAt = p.endsAt || null;
        state.ending = !!p.ending;
        noteExits(p);
        // A quick tunnel the runner replaced: the new hosts, into the store and into the core.
        const have = (transportCache && transportCache.sessionId === statusSession.id) ? transportCache.rev : ((statusSession.v2 && statusSession.v2.rev) || 0);
        if (p.phase === 'ready' && (p.rev || 0) > have) {
            validateTransport(p);
            const fresh = onTransport ? await onTransport(statusSession, st.sealed, p) : null;
            if (fresh) {
                statusSession = fresh;
                wlog(`سرور ابری یکی از تونل‌های کلادفلر را عوض کرد — نشانی‌های تازه (${p.hosts.length.toLocaleString('fa-IR')}) بدون قطع تونل کامل اعمال می‌شوند.`);
                const r = await reloadTransport(fresh);
                if (!r.ok) {
                    wlog('اعمال نشانی‌های تازه جواب نداد — اتصال از نو ساخته می‌شود.');
                    try { onRebuild && onRebuild(state.mode || intent); } catch (e) {}
                }
            }
        }
        if (p.ending && onEnding) { try { onEnding(p); } catch (e) {} }
    } finally {
        statusBusy = false;
    }
}

/**
 * The same connection, new hosts: the core restarts on its own ports with a config built from
 * the updated session — the clean addresses, fragment choice and mode stay. Seconds, and the
 * shared adapter above it (the full tunnel) is never touched; with the kill switch up, those
 * seconds are blocked, not leaked. Not ok → the caller rebuilds from scratch.
 */
async function reloadTransport(session, { exitPlan } = {}) {
    if (!child || !state.connected) return { ok: false, reason: 'not-connected' };
    let transport;
    try { transport = transportFor(session); } catch (e) { return { ok: false, reason: 'transport' }; }
    // A slot that came up since the connect joins the balancer; one that was up but failed its
    // measurement at connect stays out.
    const useSlot = !(state.slot && state.slot.ready && !state.slot.used);
    // The exit plan carries over unless a new one is given (applyExitPlan).
    const plan = exitPlan === undefined ? state.exitPlan : exitPlan;
    const cfg = buildConfig({ session, transport, host: brokerHost(), ips: state.ips, frag: state.frag, mux: state.mux || DEFAULT_MUX, useSlot, exitPlan: plan });
    const keep = { ...state, slot: slotInfo(session, transport, useSlot), exitPlan: normalizePlan(plan, transport) };
    stopWatchdog();
    const old = child;
    child = null;
    await killChild(old);
    child = startCore(daemonExe(), cfg);
    state = { ...keep, running: true, connected: false };
    await cleanip.waitPort(SOCKS_PORT, 5000);
    const v = await verifyTunnel(state.mode, { attempts: 3 });
    if (!v.ok) { state.error = v.code; return { ok: false, reason: v.code }; }
    state.connected = true;
    state.error = '';
    state.delayMs = v.delayMs;
    startWatchdog();
    return { ok: true };
}

// ── the exit country (P4, runner/exits.mjs) ────────────────────────────────────
/**
 * A question to the runner's exit broker, through the RUNNING tunnel (the status host is routed
 * to the agent before any user rule, so it works whatever exit the traffic is on).
 * @returns {Promise<{status, payload}|null>}
 */
async function askRunner(reqPath, { timeoutMs = 15000 } = {}) {
    if (!child || !state.running || !statusSession) return null;
    const r = await cleanip.socksHttpGet(SOCKS_PORT, STATUS_HOST, reqPath, { timeoutMs, collect: true });
    if (!r || !r.body || !r.status) return null;
    try {
        const st = openStatus(statusSession, r.body);
        if (st) noteExits(st.payload);
        return st ? { status: r.status, payload: st.payload } : null;
    } catch (e) { return null; }
}

/**
 * The same question to ANOTHER session — the next one, before make-before-break moves to it — on a
 * throwaway core over that session's best path; the running tunnel is not touched.
 */
async function askSession(session, reqPath, { timeoutMs = 15000, onLog } = {}) {
    let transport;
    let host;
    try { transport = transportFor(session); host = brokerHost(); } catch (e) { return null; }
    const paths = pathsOf(session, transport, host);
    const ip = state.ips && state.ips[0];
    if (!paths.length || !ip) return null;
    const core = await ensureCore(onLog);
    const port = await cleanip.freePort();
    const cfg = { log: { loglevel: 'none' }, inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth' } }], outbounds: [paths[0].make(ip, { frag: state.frag })] };
    const p = spawn(core.exe, ['run', '-c', 'stdin:'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify(cfg));
    try {
        if (!(await cleanip.waitPort(port, 5000))) return null;
        const r = await cleanip.socksHttpGet(port, STATUS_HOST, reqPath, { timeoutMs, collect: true });
        if (!r || !r.body || !r.status) return null;
        const st = openStatus(session, r.body);
        return st ? { status: r.status, payload: st.payload } : null;
    } catch (e) {
        return null;
    } finally {
        try { p.kill(); } catch (e) {}
    }
}

/**
 * A vless:// link into the RUNNING session through one exit (or `direct`), for the user's phone:
 * the same Worker, clean address and path this PC uses, valid until the session ends.
 */
function shareLink(exitId = 'direct') {
    if (!child || !state.connected || !statusSession || !state.ips.length) return null;
    let transport;
    let host;
    try { transport = transportFor(statusSession); host = brokerHost(); } catch (e) { return null; }
    const id = exitId === 'direct' || /^x[1-6]$/.test(exitId) ? exitId : 'direct';
    const uuid = transport.uuids && transport.uuids[id];
    if (!uuid) return null;
    const exp = statusSession.expiresAt || (Date.now() + 6 * 3600e3);
    const slot = state.slot && state.slot.used ? state.slot.name : '';
    const hosts = hostsOf(transport);
    const pass = slot ? secret.signSlotPass(slot, statusSession.id, exp) : hosts.length ? secret.signPass(labelOf(hosts[0]), statusSession.id, exp) : null;
    if (!pass) return null;
    const q = new URLSearchParams({
        encryption: 'none', security: 'tls', sni: host, fp: 'chrome', alpn: 'http/1.1',
        type: 'ws', host, path: `/p/${pass}${transport.wsPath}?ed=2560`,
    });
    const exit = id === 'direct' ? null : (state.exits || []).find((x) => x.id === id) || null;
    const label = id === 'direct' ? 'MAX' : (exit && exit.country) || id;
    return { link: `vless://${uuid}@${String(state.ips[0]).includes(':') ? `[${state.ips[0]}]` : state.ips[0]}:443?${q.toString()}#GT-${label}`, exit: id, country: exit ? exit.country : '', expiresAt: exp };
}

/** What the runner said about its exits and its catalog, kept for the panel. */
function noteExits(payload) {
    if (!payload) return;
    if (Array.isArray(payload.exits)) state.exits = payload.exits;
    if (payload.catalog) state.catalog = payload.catalog;
}

/**
 * The connection onto a new exit plan — the same tunnel, a different user (and site rules): only
 * the core restarts, like a replaced quick tunnel. Then the exit is VERIFIED from inside.
 */
async function applyExitPlan(plan, { onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (!statusSession) return { ok: false, reason: 'not-connected' };
    const r = await reloadTransport(statusSession, { exitPlan: plan });
    if (!r.ok) return r;
    state.exit = null;
    const exit = await locateExit().catch(() => null);
    if (exit && child) {
        state.exit = exit;
        log(`خروجی: ${exit.country || '?'}${exit.city ? ` (${exit.city})` : ''} — ${exit.ip}`);
    }
    return { ok: true, plan: state.exitPlan, exit };
}

/**
 * Does `session` answer through the Worker on the clean addresses this line is using right now?
 * Asked on a throwaway core; the running one keeps carrying traffic. A 5xx from behind the Worker
 * — a quick tunnel that has only just come up — is waited out (`tries`); anything else will not
 * change by waiting, and says what it is (`status`, `message`: the same words connect would use).
 * @returns {Promise<{ok: true, ips, transport, host, exe}|{ok: false, reason, status?, message?}>}
 */
async function proveSession(session, { onLog, tries = WARMUP_TRIES + 1, spacingMs = WARMUP_SPACING_MS } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (!child || !state.connected || !state.ips.length) return { ok: false, reason: 'not-connected' };
    let transport;
    let host;
    try { transport = transportFor(session); host = brokerHost(); } catch (e) { return { ok: false, reason: e.code || 'transport', message: e.message }; }
    const core = await ensureCore(onLog);
    // Every way into the next session, stable slot first: either one proven is enough.
    const paths = pathsOf(session, transport, host);
    let refused = null;
    for (let i = 0; i < tries; i++) {
        if (i) {
            if (i === 1) log('نشست بعدی هنوز از Worker شما جواب نمی‌دهد (تونل تازهٔ کلادفلر) — چند ثانیه صبر، نشست فعلی همچنان وصل است…');
            await sleep(spacingMs);
        }
        if (!child || !state.connected) return { ok: false, reason: 'not-connected' };
        refused = null;
        for (const p of paths) {
            const diag = {};
            const proven = await cleanip.measure({ exe: core.exe, ips: state.ips, buildOutbound: p.make, frag: state.frag, diag });
            if (proven.length) return { ok: true, ips: proven.map((r) => r.ip), transport, host, exe: core.exe, via: p.via };
            refused = cleanip.refusalOf(diag, state.frag) || refused;
        }
        if (!farSideWarming(refused)) break;
    }
    const err = noPathError({ refused, tried: state.ips.length });
    return { ok: false, reason: refused ? `HTTP_${refused.status}` : 'unproven', status: refused ? refused.status : null, code: err.code, message: err.message };
}

/**
 * MAKE-BEFORE-BREAK, the engine's half: the same connection moved to the NEXT session.
 *
 * The next session is proven on the clean addresses this line already uses — through a throwaway
 * core, while this one keeps carrying traffic — and only then does the core restart on its own
 * ports with it. The shared adapter above it (the full tunnel) is never touched: those addresses
 * are already outside it, and the DNS it measured is the runner's own either way. So the one gap
 * is the restart itself, about a second, and with the kill switch up that second is blocked, not
 * leaked. The previous way — a full reconnect — searched for clean addresses and rebuilt the
 * adapter while nothing carried traffic: 7 s measured in engine mode, more in the full tunnel.
 *
 * Not ok → `stopped` says whether the old connection is still up (proof failed: nothing was
 * touched) or gone (the restart did not carry traffic); either way the caller rebuilds.
 */
async function swapSession(session, { onLog, exitPlan = null } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (repairing) return { ok: false, stopped: false, reason: 'not-connected' };
    const proof = await proveSession(session, { onLog, tries: 1 });
    if (!proof.ok) return { ok: false, stopped: false, reason: proof.reason };
    // Taken down, or moved by somebody else, while the proof ran: not ours to restart any more.
    if (!child || !state.connected || repairing) return { ok: false, stopped: false, reason: 'not-connected' };

    const { ips, transport, host, exe } = proof;
    // Proven through the stable slot → it leads; proven only through the quick tunnels while the
    // slot says it is up → the slot stays out of this connection.
    const useSlot = proof.via === 'slot' || !slotOf(session, transport);
    // The exit plan, when the next session was asked for its exits beforehand (routes.js), lands
    // in the same restart — the country does not blink on a renewal.
    const cfg = buildConfig({ session, transport, host, ips, frag: state.frag, mux: DEFAULT_MUX, useSlot, exitPlan });
    const keep = { mode: state.mode, frag: state.frag };
    generation++;        // a repair waiting out its backoff belongs to the old session
    stopWatchdog();
    stopStatusWatch();
    const old = child;
    child = null;
    await killChild(old);
    child = startCore(exe, cfg);
    state = { ...blank(), running: true, mode: keep.mode, sessionId: session.id, ips, frag: keep.frag, startedAt: Date.now(), slot: slotInfo(session, transport, useSlot), exitPlan: normalizePlan(exitPlan, transport) };
    await cleanip.waitPort(SOCKS_PORT, 5000);
    const v = await verifyTunnel(state.mode, { attempts: 3 });
    if (!v.ok) { state.error = v.code; return { ok: false, stopped: true, reason: v.code }; }
    state.connected = true;
    state.delayMs = v.delayMs;
    log(`روی نشست تازه — همان آی‌پی‌های تمیز (${ips.join('، ')})، ${v.delayMs.toLocaleString('fa-IR')} میلی‌ثانیه تا اینترنت.`);
    locateExit().then((exit) => { if (exit && child) { state.exit = exit; log(`خروجی: ${exit.country || '?'}${exit.city ? ` (${exit.city})` : ''} — ${exit.ip}`); } }).catch(() => {});
    startWatchdog();
    startStatusWatch(session);
    return { ok: true, ips };
}

function setTransportHandler(fn) { onTransport = typeof fn === 'function' ? fn : null; }
function setEndingHandler(fn) { onEnding = typeof fn === 'function' ? fn : null; }

/** Down, without forgetting what was asked for — connect()'s own clean slate. */
async function reset(onLog) {
    stopWatchdog();
    stopStatusWatch();
    const p = child;
    child = null;
    if (p) await killChild(p);
    const was = state.running;
    state = blank();
    if (was) { try { onLog && onLog('اتصال قطع شد.'); } catch (e) {} }
}

/** Down because somebody outside asked — a repair that is waiting for its next try ends too. */
async function disconnect(onLog) {
    intent = null;
    generation++;
    await reset(onLog);
}

// ── health ──────────────────────────────────────────────────────────────────────
/** Data through the tunnel, not "a process is running": a 204 fetched through our SOCKS port. */
async function verifyTunnel(mode, { attempts = 2 } = {}) {
    if (!child || child.exitCode !== null) return { ok: false, code: 'NOT_RUNNING', message: 'هستهٔ تونل اجرا نمی‌شود.' };
    for (let i = 0; i < attempts; i++) {
        const d = await cleanip.probeDelay(SOCKS_PORT, 12000);
        if (d != null) return { ok: true, delayMs: d };
        if (!child || child.exitCode !== null) return { ok: false, code: 'NOT_RUNNING', message: 'هستهٔ تونل از کار افتاد.' };
        await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: false, code: 'NO_EGRESS', message: 'تونل بالا آمد ولی داده‌ای از آن عبور نکرد.' };
}

/**
 * Where the traffic actually leaves — asked THROUGH the tunnel. Plain HTTP on purpose (TLS
 * over a socket crashes on this machine class), and a free endpoint that returns the country
 * of the address it sees, which is the only thing a site geo-blocking the user sees too.
 */
async function locateExit() {
    let body = '';
    const r = await cleanip.socksHttpGet(SOCKS_PORT, 'ip-api.com', '/json/?fields=status,countryCode,country,city,isp,query', {
        timeoutMs: 12000, onData: () => {}, collect: true,
    });
    body = r.body || '';
    try {
        const j = JSON.parse(body);
        return j.status === 'success' ? { ip: j.query, country: j.countryCode, countryName: j.country, city: j.city, org: j.isp } : null;
    } catch (e) { return null; }
}

const wlog = (m) => { try { watchdogLog && watchdogLog(m); } catch (e) {} };

function startWatchdog() {
    stopWatchdog();
    badVerdicts = 0;
    // A reconnect the watchdog started itself keeps counting; any other connect starts afresh.
    if (!repairing) repairs = 0;
    watchdog = setInterval(() => { tick().catch(() => {}); }, WATCHDOG_INTERVAL_MS);
    if (watchdog.unref) watchdog.unref();
}
function stopWatchdog() { if (watchdog) clearInterval(watchdog); watchdog = null; }

/**
 * One look at the tunnel. Data through our SOCKS port is the test for every mode; in the full
 * tunnel the shared adapter is asked about first (routes.js › livenessCheck), because a dead
 * sing-box under a healthy engine is the case the SOCKS probe cannot see — and without the kill
 * switch it is a leak, so it is acted on at once rather than after a second bad look.
 */
async function tick() {
    if (ticking || !state.connected) return;
    ticking = true;
    try {
        let v = null;
        if (state.mode === 'tun' && livenessCheck) {
            try { v = await livenessCheck(); } catch (e) { v = null; }
            if (v && v.ok) v = null;
        }
        if (!v) v = await verifyTunnel(state.mode, { attempts: 1 });
        if (!state.connected) return;   // taken down while we looked
        if (v.ok) { badVerdicts = 0; repairs = 0; return; }
        badVerdicts++;
        if (!v.immediate && badVerdicts < BAD_VERDICTS_BEFORE_DEGRADE) return;
        try { onDegraded && onDegraded(v); } catch (e) {}
        await repair(v);
    } finally {
        ticking = false;
    }
}

/** Run a look now — the shared tunnel tells us the moment its process dies. */
function pokeWatchdog() {
    if (!state.connected) return;
    setImmediate(() => { tick().catch(() => {}); });
}

async function repair(verdict) {
    const mode = state.mode;
    stopWatchdog();
    while (repairs < MAX_REPAIR_ATTEMPTS) {
        repairs++;
        badVerdicts = 0;
        wlog(verdict && verdict.code === 'TUN_DOWN'
            ? `تونل کامل از کار افتاد — تلاش ${repairs.toLocaleString('fa-IR')} برای ساختن دوباره‌اش…`
            : `تونل جواب نمی‌دهد — تلاش ${repairs.toLocaleString('fa-IR')} برای بازسازی با آی‌پی‌های تازه…`);
        repairing = true;
        let failure = null;
        try { await (onRebuild ? onRebuild(mode) : Promise.reject(new Error('no rebuild handler'))); }
        catch (e) { failure = e; }
        finally { repairing = false; }
        if (!failure && state.connected) return;   // connect() restarted the watchdog; the count carries
        if (failure) wlog(`بازسازی ناموفق بود: ${String(failure.message || failure).split('\n')[0]}`);
        // Somebody disconnected, or connected by hand, while this one was trying: not ours any more.
        const seen = generation;
        if (intent !== mode) return;
        await new Promise((r) => setTimeout(r, REPAIR_BACKOFF_MS[Math.min(repairs - 1, REPAIR_BACKOFF_MS.length - 1)]));
        if (generation !== seen || intent !== mode) return;
    }
    stopWatchdog();
    intent = null;
    state.connected = false;
    state.error = 'REPAIR_GAVE_UP';
    wlog('بازیابی خودکار چند بار تلاش کرد و موفق نشد.');
    try { onGaveUp && onGaveUp({ mode, verdict }); } catch (e) {}
}

/**
 * The full tunnel was handed to another feature that rides this very engine (the game tab's
 * tunnel on our SOCKS port): the engine stays, it just no longer carries the whole machine.
 */
function setMode(mode) {
    if (!MODES.includes(mode) || !state.running) return false;
    state.mode = mode;
    if (intent) intent = mode;
    return true;
}

function setDegradedHandler(fn) { onDegraded = fn; }
function setRebuildHandler(fn) { onRebuild = fn; }
function setGaveUpHandler(fn) { onGaveUp = fn; }
function setWatchdogLogger(fn) { watchdogLog = fn; }
/** routes.js: `async () => ({ ok }|{ ok:false, code, message, immediate })` for the full tunnel. */
function setLivenessCheck(fn) { livenessCheck = typeof fn === 'function' ? fn : null; }

function getStatus() {
    return {
        dataPlane: 'v2',
        running: !!(child && child.exitCode === null) && state.running,
        connected: state.connected,
        exitNodeIp: '',
        mode: state.mode,
        // A repair in progress: the panel says «بازسازی…» instead of a bare «قطع».
        repairing: !!repairing || (!!intent && !state.connected && repairs > 0),
        // The runner's own word, from the status channel: when it ends, and whether it says so.
        endsAt: state.endsAt || null,
        ending: !!state.ending,
        statusAt: state.statusAt || 0,
        // UDP rides the same WebSocket as XUDP — games and calls work, with TCP's jitter.
        udp: state.connected,
        socksPort: SOCKS_PORT,
        httpPort: HTTP_PORT,
        error: state.error,
        ips: state.ips,
        frag: state.frag,
        delayMs: state.delayMs || null,
        exit: state.exit,
        // The stable tunnel (gt-slots.js): { name, ready, used } or null.
        slot: state.slot || null,
        // The exit country (runner/exits.mjs): what this connection leaves by, what the runner has
        // up, and what it could bring up.
        exitPlan: state.exitPlan || { use: 'direct', rules: [] },
        exits: state.exits || [],
        catalog: state.catalog || null,
    };
}

/** Byte counts for traffic-feed.js, from the core's own stats API. */
function readTrafficCounters() {
    if (!child || !state.running) return Promise.resolve(null);
    return new Promise((resolve) => {
        execFile(daemonExe(), ['api', 'statsquery', `-server=127.0.0.1:${API_PORT}`], { windowsHide: true, timeout: 4000 }, (err, out) => {
            if (err) return resolve(null);
            try {
                const stats = (JSON.parse(out).stat) || [];
                let up = 0, down = 0;
                for (const s of stats) {
                    const m = /^outbound>>>(?:gt-s?\d+|gx-r\d+-\d+)>>>traffic>>>(uplink|downlink)$/.exec(s.name || '');
                    if (m) { if (m[1] === 'uplink') up += Number(s.value || 0); else down += Number(s.value || 0); }
                }
                resolve({ up, down });
            } catch (e) { resolve(null); }
        });
    });
}

// /128 for an IPv6 clean address (the edge is often IPv6 since the filtering of 2026-09-28).
function getUplinkCidrs() { return (state.ips || []).map((ip) => (String(ip).includes(':') ? `${ip}/128` : `${ip}/32`)); }

async function speedtest() { return require('./gt-speed').run({ socksPort: state.connected ? SOCKS_PORT : null, exit: state.exit }); }

async function diagnose() {
    return {
        dataPlane: 'v2',
        binaries: binariesReady(),
        daemonAlive: !!(child && child.exitCode === null),
        status: getStatus(),
        verify: state.running ? await verifyTunnel(state.mode, { attempts: 1 }) : null,
        log: logTail(20),
    };
}

// ── leaving cleanly ─────────────────────────────────────────────────────────────
function registerEmergencyUndo(fn) { if (typeof fn === 'function') emergencyUndo.push(fn); }
function bailSync() {
    for (const fn of emergencyUndo) { try { fn(); } catch (e) {} }
    stopWatchdog();
    stopStatusWatch();
    if (child) { try { process.kill(child.pid); } catch (e) {} child = null; }
}
let exitHooksInstalled = false;
function installExitHooks() {
    if (exitHooksInstalled) return;
    exitHooksInstalled = true;
    process.on('exit', bailSync);
}
/** A gtcore.exe from a run that died without cleaning up would keep the ports. Startup only. */
async function sweepStaleState() {
    await new Promise((resolve) => execFile('taskkill', ['/F', '/IM', PROCESS_NAME], { windowsHide: true }, () => resolve()));
}

module.exports = {
    connect, disconnect, getStatus, verifyTunnel, readTrafficCounters, speedtest, diagnose,
    ensureBinaries, binariesReady, ensureCore, sweepStaleState, getUplinkCidrs,
    setDegradedHandler, setRebuildHandler, setGaveUpHandler, setWatchdogLogger, setLivenessCheck, pokeWatchdog, setMode,
    // the status channel
    fetchStatus, openStatus, reloadTransport, proveSession, swapSession, noPathError, askRunner, askSession, applyExitPlan, normalizePlan, shareLink, setTransportHandler, setEndingHandler, statusTick, STATUS_HOST,
    registerEmergencyUndo, bailSync, installExitHooks,
    buildConfig, buildOutbound, validateTransport, transportFor, sealKeyFor, xrayVersion, locateExit,
    PROCESS_NAME, SOCKS_PORT, HTTP_PORT, API_PORT, ENGINE_LABEL, TUN_ADAPTER, DAEMON_LOG,
    get DAEMON_EXE() { return daemonExe(); },
    daemonExe,
};
