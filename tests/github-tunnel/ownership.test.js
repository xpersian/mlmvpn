// Two ways this feature used to break things it does not own.
//
// 1. Every teardown — and every proxy-mode connect — stopped WHATEVER full-system tunnel was
//    running. The user's V2Ray or WARP tunnel went down because they pressed a GitHub button,
//    and in proxy mode the alternative (leaving it up) puts our uplink inside someone else's
//    tunnel. Now: a shared tunnel is stopped only when it is chained to our own engine (the
//    game booster builds one on our SOCKS port); anyone else's is refused, never killed.
// 2. The kill-switch would capture the WARP-family guard's Block as the machine's "original"
//    firewall state and restore it permanently — no internet. Now it refuses while that
//    guard has the firewall, the mirror of what aether-guard.js already does.
//
// Every process launch is stubbed and the tunnel manager is a fake: nothing here can touch
// the firewall, a daemon, or a real tunnel.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const Module = require('module');

const SANDBOX = path.join(__dirname, 'home-ownership');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);
const HOME = path.join(SANDBOX, '.mlmvpn');

// ── no real process, ever ─────────────────────────────────────────────────────
const scripts = [];
cp.execFile = (exe, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const script = Array.isArray(args) ? String(args[args.length - 1] || '') : '';
    scripts.push({ exe, script });
    const out = /Get-NetConnectionProfile/.test(script)
        ? JSON.stringify({ profiles: ['Domain', 'Private', 'Public'].map((Name) => ({ Name, Enabled: 'True', Inbound: 'Block' })), categories: ['Public'] })
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

// ── the fake shared tunnel ────────────────────────────────────────────────────
const fakeTun = {
    running: false,
    engineName: null,
    calls: [],
    isRunning() { return this.running; },
    currentEngine() { return this.running ? this.engineName : null; },
    currentOwner() { return null; },
    stopTun() { this.calls.push('stopTun'); this.running = false; },
    async stopTunAsync(onLog, reason, opts) { this.calls.push(`stopTunAsync:${reason}|by=${(opts && opts.by) || '-'}`); this.running = false; },
    async verifyTornDown() { return { ok: true }; },
    readTrafficCounters() { return null; },
};
const tunFile = require.resolve(ROOT + '/tun-manager');
const tunModule = new Module(tunFile);
tunModule.filename = tunFile;
tunModule.loaded = true;
tunModule.exports = fakeTun;
require.cache[tunFile] = tunModule;

const guard = require(ROOT + '/github-tunnel/gt-guard');
const engine = require(ROOT + '/github-tunnel/gt-engine');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const AETHER_FILE = path.join(HOME, 'aether-guard-state.json');

(async () => {
    // ════ 1. the kill-switch refuses while the WARP-family guard owns the firewall ════
    fs.writeFileSync(AETHER_FILE, JSON.stringify({
        at: Date.now(), dnsOwned: false, firewallEngaged: true,
        profiles: [{ name: 'Domain', action: 'NotConfigured', enabled: 'True' }],
    }));
    let logs = [];
    scripts.length = 0;
    let r = await guard.engage({ adapterName: 'mlmvpn-gt', allowPrograms: ['C:\\x\\a.exe'], onLog: (m) => logs.push(m) });
    t('engage refuses while the WARP-family guard has the firewall',
        r && r.ok === false && r.reason === 'aether-guard-engaged', JSON.stringify(r));
    t('…before running a single PowerShell command', scripts.length === 0, JSON.stringify(scripts));
    t('…and without writing a record that would capture ITS Block as ours',
        !fs.existsSync(guard.STATE_FILE) && guard.isEngaged() === false);
    t('…and it says why, naming the engines the user knows (not «Aether»)',
        logs.some(l => /ماسک\/وایرگارد\/وارپ در وارپ/.test(l)) && !logs.some(l => /aether/i.test(l)), JSON.stringify(logs));

    fs.writeFileSync(AETHER_FILE, 'not json {');
    scripts.length = 0;
    r = await guard.engage({ adapterName: 'mlmvpn-gt', allowPrograms: [] });
    t('an unreadable WARP-guard record is treated as engaged (cannot prove it is safe)',
        r && r.ok === false && scripts.length === 0, JSON.stringify(r));

    // A DNS-only record: that guard owns the resolvers but NOT the firewall — nothing to corrupt.
    fs.writeFileSync(AETHER_FILE, JSON.stringify({ at: Date.now(), dnsOwned: true, firewallEngaged: false, profiles: null }));
    scripts.length = 0;
    r = await guard.engage({ adapterName: 'mlmvpn-gt', allowPrograms: [] });
    t('a DNS-only WARP record does not block the kill-switch',
        r && r.ok === true && scripts.some(s => /DefaultOutboundAction Block/.test(s.script)), JSON.stringify(r));
    await guard.disengage();
    fs.rmSync(AETHER_FILE, { force: true });

    scripts.length = 0;
    r = await guard.engage({ adapterName: 'mlmvpn-gt', allowPrograms: [] });
    t('with no WARP record the kill-switch engages as before', r && r.ok === true && guard.isEngaged() === true);
    await guard.disengage();

    // ════ 2. the shared tunnel belongs to whoever started it ════
    const express = require(ROOT + '/node_modules/express');
    const app = express();
    app.use(express.json());
    require(ROOT + '/github-tunnel/routes')(app, {
        broadcastLog: () => {}, broadcast: () => {},
        readSystemProxy: () => ({ enabled: false, server: '' }),
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((res) => server.once('listening', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (p, b) => {
        // Connection: close — a keep-alive socket still open at process.exit trips a libuv
        // assertion on Windows and turns a clean run into a non-zero exit.
        const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(b || {}) });
        let body = null; try { body = await res.json(); } catch (e) {}
        return { status: res.status, body };
    };

    try {
        // Someone else's tunnel — V2Ray's.
        Object.assign(fakeTun, { running: true, engineName: 'xray.exe', calls: [] });
        let res = await post('/api/github-tunnel/disconnect');
        t('disconnect succeeds with another feature\'s tunnel up', res.status === 200, JSON.stringify(res.body));
        t('…and leaves that tunnel exactly as it was', fakeTun.running === true && fakeTun.calls.length === 0,
            JSON.stringify(fakeTun.calls));

        for (const p of ['/api/github-tunnel/tun', '/api/github-tunnel/proxy']) {
            fakeTun.calls = [];
            await post(p, { enabled: false });
            t(`${p.split('/').pop()}-off leaves another feature's tunnel alone`, fakeTun.running === true && fakeTun.calls.length === 0,
                JSON.stringify(fakeTun.calls));
        }

        // A tunnel chained to OUR engine (the game booster's) dies with us — without freezing
        // the window: the async stop, never the synchronous one.
        Object.assign(fakeTun, { running: true, engineName: String(engine.PROCESS_NAME).toUpperCase(), calls: [] });
        res = await post('/api/github-tunnel/disconnect');
        t('a tunnel chained to our own engine is stopped on disconnect (name matched case-insensitively)',
            res.status === 200 && fakeTun.running === false && fakeTun.calls.some((c) => /^stopTunAsync:github-tunnel/.test(c)),
            JSON.stringify(fakeTun.calls));
        t('…as OUR stop (`by`), so tun-manager never runs our own hand-over hook on it',
            fakeTun.calls.some((c) => /^stopTunAsync:github-tunnel.*\|by=github-tunnel$/.test(c)), JSON.stringify(fakeTun.calls));
        t('…with the async stop, never the one that freezes the main thread for up to 13 s',
            !fakeTun.calls.includes('stopTun'));

        // bringUp, driven for real up to its refusal: an active session in the sandbox, and
        // someone else's tunnel up. Proxy mode used to stop that tunnel; it must refuse.
        fs.writeFileSync(path.join(HOME, 'github-tunnel.json'), JSON.stringify({
            repo: null,
            sessions: [{
                id: 'GT-2026-0wner5hp', status: 'READY', createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 60 * 1000, tailscaleIp: '100.64.0.9',
                accountId: 'acct', accountLogin: 'someone', repository: 'someone/mlmvpn-cloud-tunnel',
            }],
        }));
        for (const mode of ['proxy', 'tun']) {
            Object.assign(fakeTun, { running: true, engineName: 'aether.exe', calls: [] });
            scripts.length = 0;
            res = await post(`/api/github-tunnel/${mode}`, { enabled: true });
            t(`${mode}-mode connect refuses while another feature's tunnel is up`,
                res.status >= 400 && /یک تونل دیگر/.test((res.body && res.body.error) || ''), JSON.stringify(res.body));
            t(`…and does not stop that tunnel (${mode})`, fakeTun.running === true && fakeTun.calls.length === 0,
                JSON.stringify(fakeTun.calls));
            t(`…and touches nothing machine-wide before refusing (${mode})`,
                !scripts.some(s => /Set-NetFirewallProfile|New-NetFirewallRule|reg(\.exe)? add/i.test(`${s.exe} ${s.script}`)),
                JSON.stringify(scripts.map(s => s.exe)));
        }
    } finally {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await new Promise((res) => server.close(() => res()));
    }

    // ════ 3. the source, so the rule survives the next refactor ════
    const src = fs.readFileSync(ROOT + '/github-tunnel/routes.js', 'utf8');
    t('routes.js never calls the synchronous tun.stopTun', !/tun\.stopTun\(/.test(src));
    t('the foreign-tunnel refusal is not limited to tun mode (v1 and v2 alike)',
        (src.match(/if \(tun\.isRunning\(\) && !sharedTunnelIsOurs\(\)\) throw foreignTunnel\(\);/g) || []).length >= 2);
    const stopOurs = src.slice(src.indexOf('async function stopOurTunnel('), src.indexOf('async function stopOurTunnel(') + 600);
    t('teardownAll stops only a tunnel that is ours, under the adapter lock',
        /async function teardownAll\([^)]*\) \{[\s\S]*?await stopOurTunnel\(/.test(src)
        && /if \(!sharedTunnelIsOurs\(\)\) return;/.test(stopOurs) && /await tunLock\(/.test(stopOurs));

    fs.rmSync(SANDBOX, { recursive: true, force: true });

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        // Not process.exit() straight away: a handle the routes were still closing trips a
        // libuv assertion on Windows (async.c:94) and turns a clean run into a non-zero exit.
        // The routes' own intervals would keep the loop alive, so exit a beat later.
        process.exitCode = bad ? 1 : 0;
        setTimeout(() => process.exit(process.exitCode), 50).unref();
    }
})().catch((e) => { console.error(e); process.exit(1); });
