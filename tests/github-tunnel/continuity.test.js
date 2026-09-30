// P3 — the tunnel outliving its cloud session (routes.js › MAKE-BEFORE-BREAK, FAILOVER).
//
//   1. The runner says its end is near: the next session is made ready (STANDBY) while the tunnel
//      is in use, proven through the Worker, swapped in HOT (only the core restarts; the adapter
//      is never touched), and only then is the old runner cancelled — with the kill switch up the
//      whole time.
//   2. A swap to a session that will not carry traffic is undone: back on the old one. A hot swap
//      whose restart carried nothing falls back to a full reconnect on the NEW session; a next
//      session that never answers through the Worker is not switched to at all.
//   3. Nothing happens for a tunnel nobody is using, or with «تمدید خودکار» switched off.
//   4. FAILOVER: a runner lost mid-session is replaced while the guard keeps the machine CLOSED;
//      with «تمدید خودکار» off, the repair reports the session ended instead.
//   5. The status channel's news (a replaced quick tunnel) lands in the store.
//   6. THE EXIT COUNTRY (P4): a chosen country is brought up on the runner, THEN the connection
//      moves onto its user; site rules on top; a failed exit leaves by the runner's own address
//      and says why; a renewal prepares the exits on the next runner before the hot swap.
//
// Real routes, real guard (PowerShell recorded, never run), real session store in a sandbox; the
// tunnel, the engine and the deployer are fakes. Nothing leaves the machine.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const Module = require('module');

const SANDBOX = path.join(__dirname, 'home-continuity');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const seq = [];

// ── no real process, ever ─────────────────────────────────────────────────────
const scripts = [];
cp.execFile = (exe, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const script = Array.isArray(args) ? String(args[args.length - 1] || '') : '';
    scripts.push({ exe, script });
    if (/Set-NetFirewallProfile -All[^\n]*-DefaultOutboundAction Block/.test(script)) seq.push('guard:engage');
    if (/Set-NetFirewallProfile -Name[^\n]*-DefaultOutboundAction/.test(script)) seq.push('guard:restore');
    const out = /Get-NetConnectionProfile/.test(script)
        ? JSON.stringify({ profiles: ['Domain', 'Private', 'Public'].map((Name) => ({ Name, Enabled: 'True', Inbound: 'Block' })), categories: ['Public'] })
        : /Get-NetFirewallProfile/.test(script)
            ? JSON.stringify([{ Name: 'Public', Outbound: 'Allow', Enabled: 'True' }])
            : '';
    if (cb) setImmediate(() => cb(null, out, ''));
    return new EventEmitter();
};
cp.execFileSync = (exe, args) => { scripts.push({ exe, script: String((args || []).slice(-1)[0] || ''), sync: true }); return ''; };
cp.exec = (cmd, opts, cb) => { if (typeof opts === 'function') cb = opts; if (cb) setImmediate(() => cb(null, '', '')); return new EventEmitter(); };
cp.execSync = () => '';
cp.spawn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 0; c.exitCode = 0; c.kill = () => true; return c; };

const stub = (rel, exports) => {
    const file = require.resolve(ROOT + rel);
    const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports;
    require.cache[file] = m;
};

// ── fakes ─────────────────────────────────────────────────────────────────────
const fakeTun = {
    running: false, engineName: null, owner: null, calls: [], TUN_IFACE_NAME: 'MLMVPN',
    isRunning() { return this.running; },
    currentEngine() { return this.running ? this.engineName : null; },
    currentOwner() { return this.owner; },
    stopTun() { this.running = false; this.owner = null; },
    async stopTunAsync(onLog, reason, opts) { this.calls.push(`stop:${(opts && opts.by) || '-'}`); seq.push('tun:stop'); this.running = false; this.owner = null; },
    async verifyTornDown() { return { ok: true }; },
    async startTun(port, onLog, opts) { this.calls.push('start'); seq.push('tun:start'); this.running = true; this.engineName = opts.processName[0]; this.owner = opts.owner; },
    async verifyTunCarriesTraffic() { return true; },
    async pickTunnelResolver() { return { server: '8.8.8.8', udp: true }; },
    async fastLive() { return { ok: true, adapter: this.running, defaultViaTun: this.running }; },
    binPaths() { return { exe: 'C:\\app\\core\\sing-box.exe', config: 'C:\\app\\core\\tun-config.json' }; },
    readTrafficCounters() { return null; },
};
const fakeCore = {
    PROCESS_NAME: 'gtcore.exe', SOCKS_PORT: 20812, HTTP_PORT: 20813, TUN_ADAPTER: 'MLMVPN',
    st: { running: false, connected: false, mode: '', ips: [], exit: null, error: '', ending: false },
    calls: [], hooks: {}, failFor: '',
    daemonExe() { return 'C:\\store\\gt\\gtcore.exe'; },
    get DAEMON_EXE() { return this.daemonExe(); },
    async connect({ session, mode }) {
        this.calls.push(`connect:${session.id}:${mode}`);
        seq.push(`core:connect:${session.id}`);
        this.st = { running: false, connected: false, mode: '', ips: [], exit: null, error: '', ending: false };
        if (this.failFor === session.id) throw Object.assign(new Error('تونل بالا آمد ولی داده‌ای از آن عبور نکرد.'), { code: 'NO_EGRESS' });
        this.st = { running: true, connected: true, mode, ips: ['104.19.1.1'], exit: { ip: '20.1.2.3', country: 'US' }, error: '', ending: false };
        return { mode };
    },
    // The hot swap (gt-core.js › swapSession): `failFor`/`swapRefuse` → the proof on the current
    // addresses fails and nothing is touched; `swapStop` → the restart happened but carried nothing.
    swapRefuse: '', swapStop: '', proveFail: '',
    async proveSession(session) {
        this.calls.push(`prove:${session.id}`);
        seq.push(`core:prove:${session.id}`);
        if (this.proveFail === session.id) return { ok: false, reason: 'HTTP_530', status: 530, code: 'TUNNEL_UNREACHABLE', message: 'Worker به سرور ابری نمی‌رسد (HTTP 530)' };
        return { ok: true, ips: ['104.19.1.1'] };
    },
    async swapSession(session, opts = {}) {
        this.calls.push(`swap:${session.id}`);
        seq.push(`core:swap:${session.id}`);
        this.lastSwapPlan = opts.exitPlan || null;
        if (this.failFor === session.id || this.swapRefuse === session.id) return { ok: false, stopped: false, reason: 'unproven' };
        if (this.swapStop === session.id) { this.st = { ...this.st, connected: false, error: 'NO_EGRESS' }; return { ok: false, stopped: true, reason: 'NO_EGRESS' }; }
        this.st = { ...this.st, running: true, connected: true, ips: ['104.19.1.1'], exit: { ip: '20.9.9.9', country: 'US' }, error: '', ending: false, exitPlan: opts.exitPlan || { use: 'direct', rules: [] } };
        return { ok: true, ips: ['104.19.1.1'] };
    },
    // THE EXIT BROKER on each fake runner (runner/exits.mjs): /x?cc= brings a country up on the
    // next free slot — ready at once, or failed when `exitFail` names it.
    exitsOn: {}, exitFail: '',
    askRunnerLog: [],
    _ask(sid, p) {
        const list = (this.exitsOn[sid] = this.exitsOn[sid] || []);
        const stop = /^\/x\/stop\?id=(x\d)$/.exec(p);
        if (stop) { const x = list.find((e) => e.id === stop[1]); if (x) x.state = 'idle'; }
        const m = /^\/x\?cc=([A-Z]{2})/.exec(p);
        if (m && !list.some((e) => e.country === m[1] && e.state !== 'idle')) {
            const failed = this.exitFail === m[1];
            list.push({ id: `x${list.length + 1}`, country: m[1], provider: 'vpngate', state: failed ? 'failed' : 'ready', error: failed ? 'no server answered' : '' });
        }
        return { status: 200, payload: { exits: list.map((e) => ({ ...e })) } };
    },
    async askRunner(p) { const s = store.getActiveSession(); this.askRunnerLog.push(p); return this._ask(s && s.id, p); },
    async askSession(session, p) { this.calls.push(`askSession:${session.id}:${p}`); seq.push(`core:askSession:${session.id}`); return this._ask(session.id, p); },
    async applyExitPlan(plan) {
        this.calls.push(`apply:${JSON.stringify(plan)}`);
        const s = store.getActiveSession();
        const x = (this.exitsOn[s && s.id] || []).find((e) => e.id === plan.use);
        this.st = { ...this.st, exitPlan: plan, exit: { ip: '1.2.3.4', country: x ? x.country : 'US' } };
        return { ok: true, plan, exit: this.st.exit };
    },
    shareLink() { return null; },
    async disconnect() { this.calls.push('disconnect'); this.st = { running: false, connected: false, mode: '', ips: [], exit: null, error: '', ending: false }; },
    getStatus() { return { dataPlane: 'v2', ...this.st }; },
    setMode(m) { this.st.mode = m; return true; },
    setLivenessCheck(fn) { this.hooks.liveness = fn; },
    setGaveUpHandler(fn) { this.hooks.gaveUp = fn; },
    setDegradedHandler(fn) { this.hooks.degraded = fn; },
    setRebuildHandler(fn) { this.hooks.rebuild = fn; },
    setWatchdogLogger(fn) { this.hooks.log = fn; },
    setTransportHandler(fn) { this.hooks.transport = fn; },
    setEndingHandler(fn) { this.hooks.ending = fn; },
    pokeWatchdog() {},
    registerEmergencyUndo() {}, installExitHooks() {}, async sweepStaleState() {}, bailSync() {},
    async readTrafficCounters() { return null; },
};
stub('/tun-manager', fakeTun);
stub('/github-tunnel/gt-core', fakeCore);
stub('/github-tunnel/gt-verify', { async lineIdentity() { return null; }, async run() { return { verdict: 'clean', checks: [] }; } });

const store = require(ROOT + '/github-tunnel/gt-config');
const newSession = (fields) => {
    const s = store.addSession({ repository: 'acct/repo', status: 'SETTING_UP', dataPlane: 'v2', accountId: '', accountLogin: 'acct' });
    return store.updateSession(s.id, Object.assign({ expiresAt: Date.now() + 3 * 3600e3, workflowRunId: 1000 + Math.floor(Math.random() * 1e6),
        v2: { sealKey: 'x', sealed: { v: 2 }, rev: 1, hosts: 3 } }, fields));
};
const fakeDeployer = {
    calls: [], runnerGone: false, createFails: false,
    activeSession: () => store.getActiveSession(),
    tick: (s) => s,
    async reconcile(s) { this.calls.push(`reconcile:${s && s.id}`); return this.runnerGone && s ? store.updateSession(s.id, { status: 'EXPIRED' }) : s; },
    async refreshTransport(s) { return s; },
    async createSession({ standby } = {}) {
        this.calls.push(`create:${standby ? 'standby' : 'active'}`);
        if (this.createFails) throw new Error('نشست ساخته نشد');
        const s = newSession({ status: standby ? 'STANDBY' : 'READY' });
        this.lastCreated = s;
        return s;
    },
    async endSession(s) { this.calls.push(`end:${s.id}`); seq.push(`end:${s.id}`); store.updateSession(s.id, { status: 'EXPIRED' }); },
    promoteStandby(next, prev) { this.calls.push(`promote:${next.id}`); if (prev) store.updateSession(prev.id, { status: 'ENDING' }); return store.updateSession(next.id, { status: 'READY' }); },
    demoteStandby(next, prev) { this.calls.push(`demote:${next.id}`); store.updateSession(next.id, { status: 'FAILED' }); if (prev) return store.updateSession(prev.id, { status: 'EXPIRING_SOON' }); return null; },
    async renewSession() { return {}; },
    busyAccountIds: () => [],
};
stub('/github-tunnel/gt-deployer', fakeDeployer);

const guard = require(ROOT + '/github-tunnel/gt-guard');
const express = require(ROOT + '/node_modules/express');
const app = express();
app.use(express.json());
const logs = [];
require(ROOT + '/github-tunnel/routes')(app, {
    broadcastLog: (m) => logs.push(m), broadcast: () => {},
    readSystemProxy: () => ({ enabled: false, server: '' }),
    withTunLock: (who, fn) => Promise.resolve().then(fn),
    tunWantedElsewhere: () => false,
});

(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((res) => server.once('listening', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, b) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: method === 'POST' ? JSON.stringify(b || {}) : undefined });
        let body = null; try { body = await res.json(); } catch (e) {}
        return { status: res.status, body };
    };
    const settle = async (want) => {
        for (let i = 0; i < 100; i++) {
            const s = await call('GET', '/api/github-tunnel/status');
            const phase = s.body && s.body.continuity && s.body.continuity.phase;
            if (want.includes(phase)) return s.body;
            await new Promise((r) => setTimeout(r, 30));
        }
        return (await call('GET', '/api/github-tunnel/status')).body;
    };

    try {
        // ── the tunnel in use on session A ──
        const A = newSession({ status: 'READY' });
        let res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        t('setup: the full tunnel is up on session A', res.status === 200 && fakeCore.calls.includes(`connect:${A.id}:tun`) && guard.isEngaged(), JSON.stringify(res.body));
        res = await call('GET', '/api/github-tunnel/status');
        t('«تمدید خودکار» is on unless switched off, and the panel can see it', res.body.autoRenew === true && res.body.continuity.phase === 'idle');

        // ════ 1. MAKE-BEFORE-BREAK ════
        seq.length = 0; fakeDeployer.calls.length = 0; fakeCore.calls.length = 0; fakeTun.calls.length = 0;
        fakeCore.st.ending = true;
        fakeCore.hooks.ending({ ending: true });
        let st = await settle(['done', 'failed']);
        const B = fakeDeployer.lastCreated;
        t('the runner says it is ending: the next session is made ready as STANDBY', fakeDeployer.calls[0] === 'create:standby', JSON.stringify(fakeDeployer.calls));
        t('…swapped in HOT: B promoted and the engine moved onto it without a reconnect',
            fakeDeployer.calls.includes(`promote:${B.id}`) && fakeCore.calls.join() === `prove:${B.id},swap:${B.id}`, JSON.stringify(fakeCore.calls));
        t('…proven through the Worker on the addresses in use BEFORE anything moved', seq.indexOf(`core:prove:${B.id}`) >= 0 && seq.indexOf(`core:prove:${B.id}`) < seq.indexOf(`core:swap:${B.id}`), seq.join(' → '));
        t('…the full tunnel above it untouched: the adapter was neither stopped nor rebuilt', fakeTun.calls.length === 0, JSON.stringify(fakeTun.calls));
        t('…and ONLY THEN the old runner is cancelled', seq.indexOf(`end:${A.id}`) > seq.indexOf(`core:swap:${B.id}`), seq.join(' → '));
        t('…with the kill switch up the whole time (never lifted during the swap)', !seq.includes('guard:restore') && guard.isEngaged(), seq.join(' → '));
        t('…B is the active session now, A is over', store.getActiveSession().id === B.id && store.getSession(A.id).status === 'EXPIRED');
        t('…and the panel reads «done»', st.continuity.phase === 'done', JSON.stringify(st.continuity));

        // ════ 2. a swap that would not carry traffic ════
        seq.length = 0; fakeDeployer.calls.length = 0; fakeCore.calls.length = 0;
        fakeDeployer.lastCreated = null;
        // The next one (C) will not carry traffic.
        const origCreate = fakeDeployer.createSession.bind(fakeDeployer);
        fakeDeployer.createSession = async (o) => { const s = await origCreate(o); fakeCore.failFor = s.id; return s; };
        fakeCore.st.ending = true;
        fakeCore.hooks.ending({ ending: true });
        st = await settle(['failed', 'done']);
        const C = fakeDeployer.lastCreated;
        t('a swap that would not carry traffic is undone', fakeDeployer.calls.includes(`demote:${C.id}`) && st.continuity.phase === 'failed', JSON.stringify(fakeDeployer.calls));
        t('…the hot swap was tried first, and a full reconnect on C only after its proof failed',
            fakeCore.calls[1] === `swap:${C.id}` && fakeCore.calls[2] === `connect:${C.id}:tun`, JSON.stringify(fakeCore.calls));
        t('…the dud is cancelled', fakeDeployer.calls.includes(`end:${C.id}`));
        t('…and the tunnel is back on the old session (B)', fakeCore.calls[fakeCore.calls.length - 1] === `connect:${B.id}:tun` && store.getActiveSession().id === B.id, JSON.stringify(fakeCore.calls));
        t('…still with the kill switch up', guard.isEngaged() && !seq.includes('guard:restore'));
        fakeDeployer.createSession = origCreate;
        fakeCore.failFor = '';

        // ════ 2b. a hot swap whose restart carried nothing: a full reconnect, on the NEW session ════
        seq.length = 0; fakeDeployer.calls.length = 0; fakeCore.calls.length = 0;
        fakeDeployer.createSession = async (o) => { const s = await origCreate(o); fakeCore.swapStop = s.id; return s; };
        fakeCore.st.ending = true;
        fakeCore.hooks.ending({ ending: true });
        st = await settle(['done', 'failed']);
        const E = fakeDeployer.lastCreated;
        fakeDeployer.createSession = origCreate;
        fakeCore.swapStop = '';
        t('a hot swap that carried nothing falls back to a full reconnect on the new session — not back to the old one',
            fakeCore.calls.join() === `prove:${E.id},swap:${E.id},connect:${E.id}:tun` && st.continuity.phase === 'done' && store.getActiveSession().id === E.id, JSON.stringify([fakeCore.calls, st.continuity]));
        t('…the old runner is cancelled only after that', seq.indexOf(`end:${B.id}`) > seq.indexOf(`core:connect:${E.id}`), seq.join(' → '));
        t('…and the kill switch stayed up through both attempts', guard.isEngaged() && !seq.includes('guard:restore'), seq.join(' → '));

        // ════ 2c. a next session that never answers through the Worker: NOTHING moves ════
        seq.length = 0; fakeDeployer.calls.length = 0; fakeCore.calls.length = 0; fakeTun.calls.length = 0;
        fakeDeployer.createSession = async (o) => { const s = await origCreate(o); fakeCore.proveFail = s.id; return s; };
        fakeCore.st.ending = true;
        fakeCore.hooks.ending({ ending: true });
        st = await settle(['failed', 'done']);
        const F = fakeDeployer.lastCreated;
        fakeDeployer.createSession = origCreate;
        fakeCore.proveFail = '';
        await new Promise((r) => setTimeout(r, 50));
        t('a next session that does not answer through the Worker is never switched to', fakeCore.calls.join() === `prove:${F.id}` && !fakeDeployer.calls.some((c) => c.startsWith('promote')) && fakeTun.calls.length === 0, JSON.stringify([fakeCore.calls, fakeDeployer.calls, fakeTun.calls]));
        t('…it is ended (no runner left spending minutes) and the current one stays active', fakeDeployer.calls.includes(`end:${F.id}`) && store.getActiveSession().id === E.id, JSON.stringify(fakeDeployer.calls));
        t('…and the panel says why, with the Worker\'s own answer', st.continuity.phase === 'failed' && /HTTP 530/.test(st.continuity.error), JSON.stringify(st.continuity));

        // ════ 3. nothing for a tunnel nobody uses, or with the switch off ════
        fakeDeployer.calls.length = 0;
        res = await call('POST', '/api/github-tunnel/autorenew', { enabled: false });
        fakeCore.st.ending = true;
        fakeCore.hooks.ending({ ending: true });
        await new Promise((r) => setTimeout(r, 150));
        t('«تمدید خودکار» off: no next session is made', res.body.autoRenew === false && !fakeDeployer.calls.some((c) => c.startsWith('create')), JSON.stringify(fakeDeployer.calls));
        await call('POST', '/api/github-tunnel/autorenew', { enabled: true });
        t('…and the choice is kept across restarts', JSON.parse(fs.readFileSync(store.STORE_FILE, 'utf8')).autoRenew === true);

        // ════ 4. FAILOVER ════
        seq.length = 0; fakeDeployer.calls.length = 0; fakeCore.calls.length = 0; fakeTun.calls.length = 0;
        fakeCore.st.ending = false;
        fakeDeployer.runnerGone = true;
        const repaired = await fakeCore.hooks.rebuild('tun');
        const D = fakeDeployer.lastCreated;
        fakeDeployer.runnerGone = false;
        t('a repair against a runner that is GONE becomes a failover to a new session',
            repaired && repaired.failover === true && fakeDeployer.calls.includes('create:active') && fakeCore.calls.includes(`connect:${D.id}:tun`), JSON.stringify([fakeDeployer.calls, fakeCore.calls]));
        t('…our tunnel into the dead runner came down first, as OURS', fakeTun.calls[0] === 'stop:github-tunnel', JSON.stringify(fakeTun.calls));
        t('…and the guard never opened: the machine stayed closed until the new session carried it',
            !seq.includes('guard:restore') && guard.isEngaged(), seq.join(' → '));
        t('…it is said, in the log', logs.some((l) => /سرور ابری از دست رفت/.test(l)) && logs.some((l) => /اتصال روی نشست تازه برگشت/.test(l)));

        await call('POST', '/api/github-tunnel/autorenew', { enabled: false });
        fakeDeployer.calls.length = 0;
        fakeDeployer.runnerGone = true;
        let err = null;
        try { await fakeCore.hooks.rebuild('tun'); } catch (e) { err = e; }
        fakeDeployer.runnerGone = false;
        store.updateSession(D.id, { status: 'READY' });   // the fake's «gone» marked it; the next checks need a live one
        t('«تمدید خودکار» off: the repair says the session ended — no new runner behind the user\'s back',
            err && err.code === 'SESSION_ENDED' && !fakeDeployer.calls.some((c) => c.startsWith('create')), err && err.message);
        await call('POST', '/api/github-tunnel/autorenew', { enabled: true });

        // ════ 5. the status channel's news lands in the store ════
        const cur = store.getActiveSession();
        const fresh = await fakeCore.hooks.transport(cur, { v: 2, ct: 'x' }, { rev: 7, hosts: [{ host: 'a' }, { host: 'b' }], phase: 'ready' });
        t('a quick tunnel the runner replaced: the new sealed transport and its rev are stored',
            fresh && fresh.v2.rev === 7 && fresh.v2.hosts === 2 && store.getSession(cur.id).v2.sealed.ct === 'x');

        // ════ 6. THE EXIT COUNTRY (P4): chosen, brought up on the runner, then moved onto ════
        const exitsNow = async () => (await call('GET', '/api/github-tunnel/exits')).body;
        const settleExit = async (want) => {
            for (let i = 0; i < 150; i++) { const e = await exitsNow(); if (want.includes(e.job.phase)) return e; await new Promise((r) => setTimeout(r, 30)); }
            return exitsNow();
        };
        const lastApply = () => { const a = fakeCore.calls.filter((c) => c.startsWith('apply:')).pop(); return a ? JSON.parse(a.slice(6)) : null; };
        fakeCore.calls.length = 0; seq.length = 0;
        res = await call('POST', '/api/github-tunnel/exit', { country: 'jp' });
        let ex = await settleExit(['done', 'partial', 'failed']);
        t('choosing Japan: the runner is asked for it, and the connection moves onto its user once it is READY',
            res.body.prefs.country === 'JP' && fakeCore.askRunnerLog.includes('/x?cc=JP') && JSON.stringify(lastApply()) === JSON.stringify({ use: 'x1', rules: [] }) && ex.job.phase === 'done', JSON.stringify([fakeCore.calls, ex.job]));
        t('…the same tunnel: no reconnect, no adapter touched', !fakeCore.calls.some((c) => c.startsWith('connect:')) && !seq.includes('tun:start') && !seq.includes('tun:stop'), seq.join(' → '));
        res = await call('POST', '/api/github-tunnel/exit/rules', { rules: [{ country: 'KR', domains: ['https://www.mexc.com/', 'mexc.co'] }] });
        ex = await settleExit(['done', 'partial', 'failed']);
        t('«these sites from Korea» on top: Korea brought up too, the sites on its user, the rest still on Japan',
            JSON.stringify(lastApply()) === JSON.stringify({ use: 'x1', rules: [{ id: 'x2', domains: ['mexc.com', 'mexc.co'] }] }), JSON.stringify(lastApply()));
        fakeCore.exitFail = 'SG';
        res = await call('POST', '/api/github-tunnel/exit', { country: 'SG' });
        ex = await settleExit(['partial', 'failed']);
        t('a country the runner cannot bring up: the traffic stays on the runner\'s own address, and the panel says which and why',
            lastApply().use === 'direct' && lastApply().rules.length === 1 && ex.job.phase === 'partial' && /no server answered/.test(ex.job.error), JSON.stringify([lastApply(), ex.job]));
        fakeCore.exitFail = '';
        res = await call('POST', '/api/github-tunnel/exit', { country: 'JP' });
        await settleExit(['done']);

        // make-before-break with a country: the next runner brings it up BEFORE the move
        seq.length = 0; fakeCore.calls.length = 0; fakeDeployer.calls.length = 0;
        fakeCore.st.ending = true;
        fakeCore.hooks.ending({ ending: true });
        st = await settle(['done', 'failed']);
        const X = fakeDeployer.lastCreated;
        t('a renewal asks the NEXT runner for the exits (through a throwaway core) before anything moves',
            seq.indexOf(`core:askSession:${X.id}`) >= 0 && seq.indexOf(`core:askSession:${X.id}`) < seq.indexOf(`core:swap:${X.id}`), seq.join(' → '));
        t('…and the hot swap lands straight on its exit plan — the country does not blink on a renewal',
            fakeCore.lastSwapPlan && fakeCore.lastSwapPlan.use === 'x1' && fakeCore.lastSwapPlan.rules.length === 1, JSON.stringify(fakeCore.lastSwapPlan));
        await call('POST', '/api/github-tunnel/exit', { country: '' });
        await call('POST', '/api/github-tunnel/exit/rules', { rules: [] });
        ex = await settleExit(['idle']);
        t('back to «حداکثر سرعت»: the direct user again', JSON.stringify(lastApply()) === JSON.stringify({ use: 'direct', rules: [] }) && ex.prefs.country === '' && !ex.prefs.rules.length, JSON.stringify([lastApply(), ex.prefs]));
        const runnerNow = fakeCore.exitsOn[store.getActiveSession().id] || [];
        t('…and the runner\'s exits nobody asks for any more are stopped (six slots, a process each)',
            runnerNow.length > 0 && runnerNow.every((x) => x.state === 'idle') && fakeCore.askRunnerLog.some((p) => /^\/x\/stop\?id=x\d$/.test(p)), JSON.stringify(runnerNow));

        // ════ error codes reach the panel ════
        fakeCore.failFor = store.getActiveSession().id;   // the session the renewal above moved to
        res = await call('POST', '/api/github-tunnel/connect', { mode: 'tun' });
        fakeCore.failFor = '';
        t('a failure carries its CODE to the panel (one finding, one button)', res.status === 500 && res.body.code === 'NO_EGRESS', JSON.stringify(res.body));
        await call('POST', '/api/github-tunnel/disconnect');
    } finally {
        server.close();
    }

    fs.rmSync(SANDBOX, { recursive: true, force: true });
    module.exports = results;
    if (require.main === module) {
        results.forEach((x) => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter((x) => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exitCode = bad ? 1 : 0;
        setTimeout(() => process.exit(bad ? 1 : 0), 50).unref();
    }
})().catch((e) => { console.error(e); process.exit(1); });
