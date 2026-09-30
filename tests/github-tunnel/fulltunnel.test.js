// GitHub Tunnel v2's FULL TUNNEL (P2): the shared adapter on top of gtcore, the guards around it,
// and the rules for handing the adapter to another feature.
//
//   1. tun-manager's owner registry — the hand-over hook, who is told, and what comes next.
//   2. The configs: route_exclude_address in the full and the game tunnel, validated by sing-box.
//   3. routes.js driven for real against a fake tunnel and a fake engine: the order (tunnel proven
//      BEFORE the guards), the allow-list, the refusals, the cleanup, the kept guard on a reconnect,
//      the hand-over hook, the leak-test endpoint.
//   4. gt-verify's verdicts, with the network replaced.
//   5. The callers that used to stop whatever tunnel was up.
//
// Every process launch is stubbed: nothing here touches the firewall, a daemon or a real tunnel.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const Module = require('module');

const SANDBOX = path.join(__dirname, 'home-fulltunnel');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);
const HOME = path.join(SANDBOX, '.mlmvpn');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const seq = [];   // one timeline across the fakes and the firewall scripts
let fwOff = false; // the reporting machine: every Windows Firewall profile switched off

// ── the real tun-manager first, before anything is stubbed (part 1 and 2 use it) ──────────
const realTun = require(ROOT + '/tun-manager');

// ── no real process, ever ─────────────────────────────────────────────────────
const scripts = [];
const realExecFile = cp.execFile;
cp.execFile = (exe, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    // `sing-box check` is the one real process allowed: it validates a config and touches nothing.
    if (/sing-box\.exe$/i.test(String(exe)) && Array.isArray(args) && args[0] === 'check') return realExecFile(exe, args, opts, cb);
    const script = Array.isArray(args) ? String(args[args.length - 1] || '') : '';
    scripts.push({ exe, script });
    if (/Set-NetFirewallProfile -All[^\n]*-DefaultOutboundAction Block/.test(script)) seq.push('guard:engage');
    if (/Set-NetFirewallProfile -Name[^\n]*-DefaultOutboundAction/.test(script)) seq.push('guard:restore');
    if (/-Enabled True -DefaultInboundAction Allow/.test(script)) seq.push('fw:lease');
    if (/-Enabled False -DefaultInboundAction/.test(script)) seq.push('fw:release');
    const out = /Get-NetConnectionProfile/.test(script)
        ? JSON.stringify({ profiles: ['Domain', 'Private', 'Public'].map((Name) => ({ Name, Enabled: fwOff ? 'False' : 'True', Inbound: 'NotConfigured' })), categories: ['Public'] })
        : /Get-NetFirewallProfile/.test(script)
            ? JSON.stringify([{ Name: 'Domain', Outbound: 'NotConfigured', Enabled: 'True' }])
            : '';
    if (cb) setImmediate(() => cb(null, out, ''));
    return new EventEmitter();
};
cp.execFileSync = (exe, args) => { scripts.push({ exe, script: String((args || []).slice(-1)[0] || ''), sync: true }); return ''; };
cp.exec = (cmd, opts, cb) => { if (typeof opts === 'function') cb = opts; scripts.push({ exe: cmd, script: '' }); if (cb) setImmediate(() => cb(null, '', '')); return new EventEmitter(); };
cp.execSync = (cmd) => { scripts.push({ exe: cmd, script: '', sync: true }); return ''; };
cp.spawn = (exe) => {
    scripts.push({ exe, script: '', spawn: true });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.pid = 0; child.exitCode = 0; child.kill = () => true;
    return child;
};

(async () => {
    // ════ 1. the owner registry ════════════════════════════════════════════════════════
    {
        const calls = [];
        const hook = async (info) => { calls.push(info); await new Promise((r) => setTimeout(r, 30)); calls.push('hook-finished'); };
        realTun._setOwnerForTests({ id: 'github-tunnel', onPreempted: hook });
        t('a registered owner is reported', realTun.currentOwner() === 'github-tunnel');
        await realTun.stopTunAsync(null, 'handover to the V2Ray tunnel', { by: 'v2ray' });
        t('a stranger\'s stop calls the owner\'s hook, with who and why', calls[0] && calls[0].reason === 'handover to the V2Ray tunnel' && calls[0].by === 'v2ray' && calls[0].next === null, JSON.stringify(calls));
        t('…and WAITS for it before going on', calls[1] === 'hook-finished');
        t('…and the registration is gone afterwards', realTun.currentOwner() === null);

        calls.length = 0;
        realTun._setOwnerForTests({ id: 'github-tunnel', onPreempted: hook });
        await realTun.stopTunAsync(null, 'mine', { by: 'github-tunnel' });
        t('the owner\'s own stop does not call its own hook', calls.length === 0 && realTun.currentOwner() === null);

        calls.length = 0;
        realTun._setOwnerForTests({ id: 'github-tunnel', onPreempted: hook });
        realTun.stopTun(null, 'app quitting');
        await new Promise((r) => setTimeout(r, 60));
        t('the synchronous stop (quit, old callers) still tells the owner', calls[0] && calls[0].reason === 'app quitting' && realTun.currentOwner() === null, JSON.stringify(calls));

        calls.length = 0;
        realTun._setOwnerForTests({ id: 'github-tunnel', onPreempted: hook });
        let startErr = null;
        // A dead port: the start fails AFTER the hand-over, which is the part under test.
        try { await realTun.startTun(59999, () => {}, { processName: ['xray.exe'], mode: 'game', engineTag: 'v2ray' }); } catch (e) { startErr = e; }
        const n = calls[0] && calls[0].next;
        t('another feature\'s START hands over too, and says what comes next',
            n && n.socksPort === 59999 && n.processNames[0] === 'xray.exe' && n.mode === 'game' && startErr, JSON.stringify(calls));

        calls.length = 0;
        realTun._setOwnerForTests({ id: 'github-tunnel', onPreempted: async () => { throw new Error('boom'); } });
        let threw = false;
        try { await realTun.stopTunAsync(null, 'x', { by: 'other' }); } catch (e) { threw = true; }
        t('a hook that throws does not stop the takeover', !threw && realTun.currentOwner() === null);

        // A registration outlives a sing-box that died on its own; the next start still hands over.
        calls.length = 0;
        realTun._setOwnerForTests({ id: 'github-tunnel', onPreempted: hook });
        t('the registration is independent of a running process', realTun.isRunning() === false && realTun.currentOwner() === 'github-tunnel');
        try { await realTun.startTun(59999, () => {}, { processName: ['aether.exe'] }); } catch (e) { /* dead port */ }
        t('…so a start over a crashed owner still calls its hook', calls.length >= 1 && realTun.currentOwner() === null, JSON.stringify(calls));
        realTun._setOwnerForTests(null);
    }

    // ════ 2. the configs ═══════════════════════════════════════════════════════════════
    {
        const excl = ['104.19.152.248/32', 'not-a-cidr', '10.0.0.0/33', '2606:4700::/32', ''];
        const full = realTun.buildTunConfig(20812, { processName: ['gtcore.exe'], engineTag: 'gt', uplinkCidrs: [], apiSuffixes: [], uplinkIps: ['104.19.152.248'], routeExcludeAddress: excl, rejectQuic: true, remoteDns: '8.8.8.8' });
        const inb = full.inbounds[0];
        t('the full tunnel keeps the clean addresses out of its routes', JSON.stringify(inb.route_exclude_address) === JSON.stringify(['104.19.152.248/32', '2606:4700::/32']), JSON.stringify(inb.route_exclude_address));
        t('…and still has strict_route and the /32 backstop rule', inb.strict_route === true
            && full.route.rules.some((r) => Array.isArray(r.ip_cidr) && r.ip_cidr.includes('104.19.152.248/32') && r.outbound === 'direct'));
        t('…DNS through the engine, IPv6 refused, QUIC refused', full.dns.final === 'remote'
            && full.dns.servers.some((s) => s.tag === 'remote' && s.server === '8.8.8.8' && s.detour === 'gt')
            && full.route.rules.some((r) => r.ip_version === 6 && r.action === 'reject')
            && full.route.rules.some((r) => r.protocol === 'quic' && r.action === 'reject'));
        t('no exclusion list means no key at all (an empty one is not the same as none)',
            !('route_exclude_address' in realTun.buildTunConfig(20812, { processName: ['gtcore.exe'], uplinkCidrs: [] }).inbounds[0]));
        const game = realTun.buildGameTunConfig(20812, { processName: 'gtcore.exe', engineTag: 'github-tunnel', gameProcesses: ['game.exe'], uplinkCidrs: [], routeExcludeAddress: ['104.19.152.248/32'] });
        t('the game tunnel honours the exclusion too', JSON.stringify(game.inbounds[0].route_exclude_address) === '["104.19.152.248/32"]');

        const exe = realTun.binPaths().exe;
        if (fs.existsSync(exe)) {
            const check = (cfg) => new Promise((resolve) => {
                const f = path.join(SANDBOX, `check-${Math.random().toString(36).slice(2)}.json`);
                fs.writeFileSync(f, JSON.stringify(realTun.dropConditionlessRules(cfg, () => {})));
                cp.execFile(exe, ['check', '-c', f], { windowsHide: true, timeout: 20000 }, (err, out, errOut) => resolve({ ok: !err, msg: String(errOut || out || (err && err.message) || '').slice(0, 300) }));
            });
            const a = await check(full);
            t('sing-box accepts the full-tunnel config', a.ok, a.msg);
            const b = await check(game);
            t('sing-box accepts the game config with the exclusion', b.ok, b.msg);
        } else {
            t('sing-box check skipped (no binary in this checkout)', true);
        }
    }

    // ════ 3. routes.js, driven for real ════════════════════════════════════════════════
    const fakeTun = {
        running: false, engineName: null, owner: null, carries: true, calls: [], lastOpts: null,
        TUN_IFACE_NAME: 'MLMVPN',
        isRunning() { return this.running; },
        currentEngine() { return this.running ? this.engineName : null; },
        currentOwner() { return this.owner; },
        stopTun() { this.calls.push('stopTun'); this.running = false; },
        async stopTunAsync(onLog, reason, opts) { this.calls.push(`stopTunAsync:${reason}|by=${(opts && opts.by) || '-'}`); seq.push('tun:stop'); this.running = false; this.owner = null; },
        async verifyTornDown() { return { ok: true }; },
        async startTun(port, onLog, opts) {
            this.calls.push(`startTun:${port}`); seq.push('tun:start');
            this.lastOpts = opts; this.running = true; this.engineName = opts.processName[0]; this.owner = opts.owner || null;
        },
        async verifyTunCarriesTraffic() { seq.push('tun:verify'); return this.carries; },
        async pickTunnelResolver(port) { this.calls.push(`resolver:${port}`); return { server: '8.8.8.8', udp: true }; },
        async fastLive() { return { ok: true, adapter: this.running, defaultViaTun: this.running }; },
        binPaths() { return { exe: 'C:\\app\\core\\sing-box.exe', config: 'C:\\app\\core\\tun-config.json', wintun: '' }; },
        readTrafficCounters() { return null; },
    };
    const fakeCore = {
        PROCESS_NAME: 'gtcore.exe', SOCKS_PORT: 20812, HTTP_PORT: 20813, API_PORT: 20814, TUN_ADAPTER: 'MLMVPN', ENGINE_LABEL: 'GitHub Tunnel',
        state: { running: false, connected: false, mode: '', ips: [], exit: null, error: '' },
        calls: [], hooks: {}, failConnect: null,
        daemonExe() { return 'C:\\ProgramData\\MLMVPN\\store\\gt\\gtcore.exe'; },
        get DAEMON_EXE() { return this.daemonExe(); },
        async connect({ mode }) {
            this.calls.push(`connect:${mode}`); seq.push('core:connect');
            if (this.failConnect) throw this.failConnect;
            this.state = { running: true, connected: true, mode, ips: ['104.19.1.1', '104.19.2.2'], exit: { ip: '20.1.2.3', country: 'US' }, error: '' };
            return { mode, socksPort: 20812 };
        },
        async disconnect() { this.calls.push('disconnect'); seq.push('core:disconnect'); this.state = { running: false, connected: false, mode: '', ips: [], exit: null, error: '' }; },
        getStatus() { return { dataPlane: 'v2', ...this.state, socksPort: 20812, httpPort: 20813 }; },
        setMode(m) { this.calls.push(`setMode:${m}`); if (!this.state.running) return false; this.state.mode = m; return true; },
        setLivenessCheck(fn) { this.hooks.liveness = fn; },
        setGaveUpHandler(fn) { this.hooks.gaveUp = fn; },
        setDegradedHandler(fn) { this.hooks.degraded = fn; },
        setRebuildHandler(fn) { this.hooks.rebuild = fn; },
        setWatchdogLogger(fn) { this.hooks.log = fn; },
        setTransportHandler(fn) { this.hooks.transport = fn; },
        setEndingHandler(fn) { this.hooks.ending = fn; },
        pokeWatchdog() { this.calls.push('poke'); },
        registerEmergencyUndo() {}, installExitHooks() {}, async sweepStaleState() {}, bailSync() {},
        async readTrafficCounters() { return null; }, async speedtest() { return {}; }, async diagnose() { return {}; },
    };
    const fakeVerify = {
        lineCalls: 0,
        async lineIdentity() { this.lineCalls++; return { ip: '5.213.8.96', country: 'IR' }; },
        async run(args) { this.lastArgs = args; return { at: 1, verdict: 'clean', checks: [], note: '' }; },
    };
    const stub = (rel, exports) => {
        const file = require.resolve(ROOT + rel);
        const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports;
        require.cache[file] = m;
    };
    stub('/tun-manager', fakeTun);
    stub('/github-tunnel/gt-core', fakeCore);
    stub('/github-tunnel/gt-verify', fakeVerify);

    const NOW = Date.now();
    fs.writeFileSync(path.join(HOME, 'github-tunnel.json'), JSON.stringify({
        repo: null,
        sessions: [{ id: 'GT-2026-FULLTUN1', status: 'READY', createdAt: NOW, expiresAt: NOW + 3600e3, dataPlane: 'v2',
            v2: { sealKey: 'x', sealed: { v: 2 }, rev: 1, hosts: 3 } }],
    }));

    const guard = require(ROOT + '/github-tunnel/gt-guard');
    const express = require(ROOT + '/node_modules/express');
    const app = express();
    app.use(express.json());
    const locks = [];
    let wantedElsewhere = false;
    const logs = [];
    require(ROOT + '/github-tunnel/routes')(app, {
        broadcastLog: (m) => logs.push(m), broadcast: () => {},
        readSystemProxy: () => ({ enabled: false, server: '' }),
        withTunLock: (who, fn) => { locks.push(who); return Promise.resolve().then(fn); },
        tunWantedElsewhere: () => wantedElsewhere,
        dnsBridge: { stop: async () => { seq.push('bridge:stop'); }, restore: async () => { seq.push('bridge:restore'); } },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((res) => server.once('listening', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, b) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: method === 'POST' ? JSON.stringify(b || {}) : undefined });
        let body = null; try { body = await res.json(); } catch (e) {}
        return { status: res.status, body };
    };
    const reset = () => { seq.length = 0; scripts.length = 0; fakeTun.calls = []; fakeCore.calls = []; logs.length = 0; locks.length = 0; };

    try {
        // ── up ──
        reset();
        let res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        t('the full tunnel comes up for a v2 session', res.status === 200 && res.body && res.body.running === true, JSON.stringify(res.body));
        t('…the engine in its tun mode', fakeCore.calls.includes('connect:tun'), JSON.stringify(fakeCore.calls));
        const o = fakeTun.lastOpts || {};
        t('…the shared tunnel on gtcore\'s SOCKS port, under the adapter lock', fakeTun.calls.includes('startTun:20812') && locks.includes('github-tunnel-on'), JSON.stringify(locks));
        t('…registered as ours, with a hand-over hook and a crash hook', o.owner === 'github-tunnel' && typeof o.onPreempted === 'function' && typeof o.onExited === 'function');
        t('…the clean addresses kept out of the routes', JSON.stringify(o.routeExcludeAddress) === '["104.19.1.1/32","104.19.2.2/32"]' && JSON.stringify(o.uplinkIps) === '["104.19.1.1","104.19.2.2"]');
        t('…no WARP ranges, no WARP host, gtcore excluded by name', Array.isArray(o.uplinkCidrs) && !o.uplinkCidrs.length && Array.isArray(o.apiSuffixes) && !o.apiSuffixes.length && o.processName[0] === 'gtcore.exe');
        t('…DNS through the resolver measured through the engine, QUIC refused', o.remoteDns === '8.8.8.8' && o.supportsUdp === true && o.rejectQuic === true && fakeTun.calls.includes('resolver:20812'));
        const iStart = seq.indexOf('tun:start'), iVerify = seq.indexOf('tun:verify'), iEngage = seq.indexOf('guard:engage');
        t('the tunnel is PROVEN before any guard goes up', iStart >= 0 && iVerify > iStart && iEngage > iVerify, seq.join(' → '));
        t('a WARP engine\'s DNS bridge is taken down BEFORE the tunnel goes up', seq.indexOf('bridge:stop') >= 0 && seq.indexOf('bridge:stop') < iStart, seq.join(' → '));
        const engage = scripts.find((s) => /DefaultOutboundAction Block/.test(s.script));
        t('the kill switch allows the shared adapter by name', engage && /-InterfaceAlias 'MLMVPN'/.test(engage.script));
        t('…gtcore, sing-box and this app — and nothing of tailscale', engage
            && engage.script.includes("-Program 'C:\\ProgramData\\MLMVPN\\store\\gt\\gtcore.exe'")
            && engage.script.includes("-Program 'C:\\app\\core\\sing-box.exe'")
            && engage.script.includes(`-Program '${process.execPath.replace(/'/g, "''")}'`)
            && !/tailscale/i.test(engage.script));
        t('the DNS block and the IPv6 block are up too', guard.isDnsBlocked() && guard.isIpv6Blocked() && guard.isEngaged());
        t('the line\'s own address was taken on the way up', fakeVerify.lineCalls >= 1);
        res = await call('GET', '/api/github-tunnel/engine/status');
        t('status: the guards apply to v2\'s full tunnel, and the tunnel is ours', res.body && res.body.killSwitch.applicable === true && res.body.ipv6Guard.applicable === true && res.body.tun.ours === true && res.body.dataPlane === 'v2', JSON.stringify(res.body && res.body.killSwitch));

        // ── the liveness check the watchdog asks first ──
        let live = await fakeCore.hooks.liveness();
        t('liveness: our tunnel up and routing is healthy', live && live.ok === true);
        fakeTun.running = false;
        live = await fakeCore.hooks.liveness();
        t('liveness: a dead adapter is TUN_DOWN, acted on at once', live && live.ok === false && live.code === 'TUN_DOWN' && live.immediate === true);
        fakeTun.running = true;
        fakeTun.owner = 'v2ray';
        live = await fakeCore.hooks.liveness();
        t('liveness: somebody else\'s tunnel on the adapter is not ours', live && live.ok === false && live.code === 'TUN_DOWN');
        fakeTun.owner = 'github-tunnel';
        o.onExited({ code: 1 });
        t('a sing-box crash pokes the watchdog at once', fakeCore.calls.includes('poke'));

        // ── a reconnect keeps the guard ──
        reset();
        res = await call('POST', '/api/github-tunnel/connect', { mode: 'tun' });
        t('a guarded reconnect succeeds', res.status === 200, JSON.stringify(res.body));
        t('…without lifting the kill switch at any point', !seq.includes('guard:restore') && guard.isEngaged(), seq.join(' → '));
        t('…says so in the log', logs.some((l) => /محافظ نشت در طول اتصال مجدد فعال می‌ماند/.test(l)));
        t('…and stops our own tunnel as OURS before rebuilding it', fakeTun.calls.some((c) => /^stopTunAsync:github-tunnel: reconnect\|by=github-tunnel$/.test(c)), JSON.stringify(fakeTun.calls));

        // ── the leak test ──
        res = await call('POST', '/api/github-tunnel/leaktest');
        t('the leak test runs against the full tunnel', res.status === 200 && res.body.result && res.body.result.verdict === 'clean', JSON.stringify(res.body));
        t('…with the engine\'s exit, the line\'s address and the tunnel\'s resolver', fakeVerify.lastArgs && fakeVerify.lastArgs.exit.ip === '20.1.2.3'
            && fakeVerify.lastArgs.line.ip === '5.213.8.96' && fakeVerify.lastArgs.tunnelResolver === '8.8.8.8');
        t('…and reports the guards that were up', res.body.result.guards && res.body.result.guards.killSwitch === true);
        res = await call('GET', '/api/github-tunnel/engine/status');
        t('…and the panel can show it again later', res.body.leakTest && res.body.leakTest.verdict === 'clean');

        // ── handed over to another feature ──
        reset();
        await o.onPreempted({ reason: 'handover to the V2Ray tunnel', by: null, next: null });
        t('hand-over: the kill switch is lifted', !guard.isEngaged() && seq.includes('guard:restore'), seq.join(' → '));
        t('…the DNS and IPv6 blocks too', !guard.isDnsBlocked() && !guard.isIpv6Blocked());
        t('…the engine goes, and the panel says why', fakeCore.calls.includes('disconnect'));
        res = await call('GET', '/api/github-tunnel/engine/status');
        t('…PREEMPTED, not a bare «disconnected»', res.body.engine.error === 'PREEMPTED', JSON.stringify(res.body.engine));
        t('…and it takes no lock (it runs inside the other feature\'s transition)', !locks.length, JSON.stringify(locks));

        // chained: the game tab building on our engine keeps it
        fakeTun.running = false; fakeTun.owner = null;
        res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        const o2 = fakeTun.lastOpts;
        reset();
        await o2.onPreempted({ reason: 'replaced by game', next: { socksPort: 20812, processNames: ['gtcore.exe'], mode: 'game' } });
        t('a game tunnel on OUR port keeps the engine, as a bare engine', fakeCore.calls.includes('setMode:engine') && !fakeCore.calls.includes('disconnect'), JSON.stringify(fakeCore.calls));
        t('…but the guards built for the whole machine still come down', !guard.isEngaged() && !guard.isDnsBlocked());

        // ── refusals ──
        reset();
        fakeTun.running = true; fakeTun.engineName = 'gtcore.exe'; fakeTun.owner = 'github-tunnel';
        await call('POST', '/api/github-tunnel/disconnect');
        t('disconnect hands the DNS bridge back — last, once the firewall is open again',
            seq.includes('bridge:restore') && seq.indexOf('bridge:restore') > seq.lastIndexOf('guard:restore'), seq.join(' → '));
        Object.assign(fakeTun, { running: true, engineName: 'xray.exe', owner: null });
        reset();
        res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        t('someone else\'s tunnel up: refused', res.status === 500 && /تونل دیگر/.test(res.body.error || ''), JSON.stringify(res.body));
        t('…before the engine or the tunnel is touched', !fakeCore.calls.length && !fakeTun.calls.length, JSON.stringify([fakeCore.calls, fakeTun.calls]));
        Object.assign(fakeTun, { running: false, engineName: null });
        wantedElsewhere = true;
        reset();
        res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        t('another feature about to take the adapter back: refused too', res.status === 500 && !fakeCore.calls.length, JSON.stringify(res.body));
        wantedElsewhere = false;

        // ── a tunnel that carries nothing is not kept ──
        fakeTun.carries = false;
        reset();
        res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        t('no data through the finished tunnel: the connect fails', res.status === 500 && /داده از آن رد نشد/.test(res.body.error || ''), JSON.stringify(res.body));
        t('…the half-built tunnel comes down as ours', fakeTun.calls.some((c) => /^stopTunAsync:github-tunnel: start failed\|by=github-tunnel$/.test(c)) && !fakeTun.running, JSON.stringify(fakeTun.calls));
        t('…the engine goes with it', fakeCore.calls.includes('disconnect'));
        t('…and no guard was put up around nothing', !seq.includes('guard:engage') && !guard.isEngaged(), seq.join(' → '));
        fakeTun.carries = true;

        // ── the leak test refuses outside the full tunnel ──
        res = await call('POST', '/api/github-tunnel/leaktest');
        t('the leak test refuses when the full tunnel is not up', res.status === 500 && /تونل کامل/.test(res.body.error || ''));

        // ── the game tab: a bare engine for v2 ──
        reset();
        res = await call('POST', '/api/github-tunnel/proxy', { enabled: false });
        const src = fs.readFileSync(ROOT + '/github-tunnel/routes.js', 'utf8');
        t('the game tab can ask for a bare engine (v2) and v1 falls back to its full tunnel',
            /bringUp\(mode === 'proxy' \|\| mode === 'engine' \? mode : 'tun'\)/.test(src) && /if \(mode === 'engine'\) mode = 'tun';/.test(src));
        t('a bare engine never turns off another engine\'s system proxy', /if \(mode !== 'engine' \|\| systemProxyOwned\) clearSystemProxy\(\);/.test(src));

        // ── the reporting machine: Windows Firewall switched off ──
        fwOff = true;
        Object.assign(fakeTun, { running: false, engineName: null, owner: null });
        reset();
        res = await call('POST', '/api/github-tunnel/tun', { enabled: true });
        t('firewall off: the full tunnel still comes up (the tunnel itself is what stops leaks while up)', res.status === 200, JSON.stringify(res.body));
        t('…but no guard claims to be up over a firewall that enforces nothing',
            !seq.includes('guard:engage') && !guard.isEngaged() && !guard.isDnsBlocked() && !guard.isIpv6Blocked()
            && !scripts.some((s) => /New-NetFirewallRule/.test(s.script)), seq.join(' → '));
        t('…and it is said ONCE, with the one thing that fixes it',
            logs.filter((l) => /دیوارآتش ویندوز روی این سیستم خاموش است/.test(l)).length === 1
            && logs.some((l) => /روشن کردن دیوارآتش ویندوز فقط هنگام اتصال/.test(l)), JSON.stringify(logs.filter((l) => /دیوارآتش/.test(l))));
        res = await call('GET', '/api/github-tunnel/engine/status');
        t('…the status tells the panel', res.body.firewall && res.body.firewall.enforcing === false && res.body.firewall.autoEnable === false
            && res.body.killSwitch.engaged === false, JSON.stringify(res.body.firewall));

        reset();
        res = await call('POST', '/api/github-tunnel/firewall', { autoEnable: true });
        t('«روشن کردن دیوارآتش ویندوز فقط هنگام اتصال»: the firewall is switched on for the tunnel, THEN the guards',
            res.status === 200 && seq.indexOf('fw:lease') >= 0 && seq.indexOf('guard:engage') > seq.indexOf('fw:lease') && guard.isEngaged(), seq.join(' → '));
        t('…with inbound left allowed, and recorded before the change',
            scripts.some((s) => /-Enabled True -DefaultInboundAction Allow/.test(s.script)));
        const cfgFile = path.join(HOME, 'github-tunnel.json');
        t('…and the choice is kept across restarts', JSON.parse(fs.readFileSync(cfgFile, 'utf8')).firewallAutoEnable === true);

        reset();
        res = await call('POST', '/api/github-tunnel/firewall', { autoEnable: false });
        t('switching the choice off takes down what depended on it, and puts the firewall back off',
            res.status === 200 && !guard.isEngaged() && !guard.isDnsBlocked() && !guard.isIpv6Blocked()
            && seq.includes('fw:release') && seq.indexOf('fw:release') > seq.lastIndexOf('guard:restore'), seq.join(' → '));
        fwOff = false;
        await call('POST', '/api/github-tunnel/disconnect');
    } finally {
        server.close();
    }

    // ════ 4. gt-verify's verdicts ══════════════════════════════════════════════════════
    {
        delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-verify')];
        const verify = require(ROOT + '/github-tunnel/gt-verify');
        const exit = { ip: '20.1.2.3', country: 'US' };
        const line = { ip: '5.213.8.96', country: 'IR' };
        const clean = {
            whoAmI: async () => ({ ip: '20.1.2.3', country: 'US', countryName: 'United States', city: 'Phoenix' }),
            resolverSeen: async () => ({ ip: '172.253.1.1', geo: 'United States - Google', countryName: 'United States', iran: false, ecs: { ip: '20.1.2.0', geo: 'United States - Microsoft', iran: false } }),
            udpSeen: async () => ({ answered: 3, mapped: ['20.1.2.3'] }),
            // The tunnel's own stack accepts the handshake and refuses IPv6 — nothing comes back.
            ipv6Seen: async () => ({ reached: false, ip: null }),
            globalIpv6Addresses: () => ['2a02:4540:7057:7ca7::1'],
        };
        let r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: clean });
        t('verify: everything through the tunnel is «clean»', r.verdict === 'clean' && r.checks.every((c) => c.status === 'pass'), JSON.stringify(r.checks.map((c) => [c.id, c.status])));
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, whoAmI: async () => ({ ip: '5.213.8.96', country: 'IR' }) } });
        t('verify: the line\'s own address seen is a leak', r.verdict === 'leak' && r.checks.find((c) => c.id === 'ip').status === 'fail');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, whoAmI: async () => ({ ip: '9.9.9.9', country: 'DE' }) } });
        t('verify: an address that is not the exit is a leak (part of the traffic goes another way)', r.verdict === 'leak');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, resolverSeen: async () => ({ ip: '2.189.44.85', geo: 'Iran - Telecommunication Infrastructure Company', iran: true }) } });
        t('verify: an Iranian resolver is a DNS leak', r.verdict === 'leak' && r.checks.find((c) => c.id === 'dns').status === 'fail');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, resolverSeen: async () => ({ ip: '172.253.1.1', geo: 'United States - Google', iran: false, ecs: { ip: '5.213.8.0', geo: 'Iran - MCI', iran: true } }) } });
        t('verify: a resolver passing on an Iranian client subnet is a DNS leak', r.verdict === 'leak');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, resolverSeen: async () => ({ ip: '172.70.1.1', geo: 'Germany - Cloudflare, Inc.', iran: false, ecs: null }) } });
        t('verify: a foreign resolver in ANOTHER country than the server is «unsure», not «clean» (the bare line read «Germany - Cloudflare»)', r.verdict === 'partial' && r.checks.find((c) => c.id === 'dns').status === 'warn');
        r = await verify.run({ exit, line, probes: { ...clean, resolverSeen: async () => ({ ip: '162.158.1.1', geo: 'United States - Cloudflare, Inc.', countryName: 'United States', iran: false, ecs: null }) } });
        t('verify: the runner\'s own re-resolution (any operator, the server\'s country) is «clean»', r.checks.find((c) => c.id === 'dns').status === 'pass');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, udpSeen: async () => ({ answered: 2, mapped: ['5.213.8.96'] }) } });
        t('verify: STUN seeing the line\'s address is a WebRTC leak', r.verdict === 'leak' && r.checks.find((c) => c.id === 'udp').status === 'fail');
        r = await verify.run({ exit, line, probes: { ...clean, ipv6Seen: async () => ({ reached: true, ip: '2a02:4540:7057:7ca7:a2b8:258e:d98d:2' }) } });
        t('verify: the far end ANSWERING over IPv6 and seeing our own /64 is a leak', r.verdict === 'leak' && r.checks.find((c) => c.id === 'ipv6').status === 'fail');
        r = await verify.run({ exit, line, probes: { ...clean, ipv6Seen: async () => ({ reached: true, ip: null }) } });
        t('verify: an answer with no address to check is a leak too (the tunnel refuses IPv6)', r.checks.find((c) => c.id === 'ipv6').status === 'fail');
        r = await verify.run({ exit, line, probes: { ...clean, ipv6Seen: async () => ({ reached: true, ip: '2603:1030::5' }) } });
        t('verify: an answer that saw somebody else\'s address is not ours', r.checks.find((c) => c.id === 'ipv6').status === 'pass');
        t('verify: a handshake the tunnel accepted and then refused is NOT a leak (the 2026-09-23 false alarm)',
            (await verify.run({ exit, line, probes: clean })).checks.find((c) => c.id === 'ipv6').status === 'pass');
        r = await verify.run({ exit, line, probes: { ...clean, ipv6Seen: async () => ({ reached: true, ip: '2a02:4540:7057:7ca7::9' }), globalIpv6Addresses: () => [] } });
        t('verify: no IPv6 on the line is nothing to leak', r.checks.find((c) => c.id === 'ipv6').status === 'pass');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', appRouting: { mode: 'bypass', count: 2 }, probes: clean });
        t('verify: a split the user chose is said, not hidden', /۲ برنامه/.test(r.note) && r.verdict === 'clean');
        r = await verify.run({ exit, line, tunnelResolver: '8.8.8.8', probes: { ...clean, whoAmI: async () => null, udpSeen: async () => null } });
        t('verify: no answer is «unsure», never «clean»', r.verdict === 'partial');
        const src = fs.readFileSync(ROOT + '/github-tunnel/gt-verify.js', 'utf8');
        t('verify: the IPv6 check waits for an HTTP answer, not a handshake', /const reached = \/\^HTTP/.test(src) && !/once\('connect', \(\) => finish\(true\)\)/.test(src));
    }

    // ════ 5. the callers that used to stop whatever tunnel was up ═════════════════════
    {
        const server = fs.readFileSync(ROOT + '/server.js', 'utf8');
        t('server.js: no click path uses the synchronous stop any more', !/tun\.stopTun\(/.test(server));
        t('server.js hands the adapter lock and the other features\' intent to the routes',
            /require\('\.\/github-tunnel\/routes'\)\(app, \{[\s\S]{0,900}withTunLock,[\s\S]{0,400}tunWantedElsewhere: \(\) => aetherTunWanted \|\| v2rayTunWanted/.test(server));
        t('the game tab stops a v2 engine only if it started it', /const mine = gtStartedByGame;/.test(server) && /if \(up\) return;/.test(server));
        const xray = fs.readFileSync(ROOT + '/xray-manager.js', 'utf8');
        t('stopXray stops only a tunnel Xray carries', /if \(tun\.isRunning\(\) && tun\.currentEngine\(\) === 'xray\.exe'\) tun\.stopTun\(/.test(xray));
        const ddns = fs.readFileSync(ROOT + '/dedicated-dns-manager.js', 'utf8');
        t('dedicated DNS stops only its own split tunnel', /cur && cur\.mode === 'smart' && cur\.engine === 'xray\.exe'/.test(ddns));
        const boost = fs.readFileSync(ROOT + '/game/boost.js', 'utf8');
        t('the game booster stops only the game tunnel', /if \(cur && cur\.mode === 'game'\)/.test(boost) && /processName: spec\.processName \|\| engine\.processName/.test(boost));
        const gst = fs.readFileSync(ROOT + '/gst/gst-runtime.js', 'utf8');
        t('the Google Script runtime clears only a tunnel gst.exe carries', (gst.match(/if \(gstOwnsTunnel\(\)\)/g) || []).length === 3 && !/if \(tun\.isRunning\(\)\) \{/.test(gst));
        const engines = fs.readFileSync(ROOT + '/game/engines.js', 'utf8');
        t('the game tab treats v2 as an ordinary SOCKS engine', /processName: 'gtcore\.exe',\s*exclusive: false,/.test(engines) && /if \(!spec\.exclusive\) \{/.test(engines));
    }

    fs.rmSync(SANDBOX, { recursive: true, force: true });

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exitCode = bad ? 1 : 0;
        setTimeout(() => process.exit(bad ? 1 : 0), 50).unref();
    }
})().catch((e) => { console.error(e); process.exit(1); });
