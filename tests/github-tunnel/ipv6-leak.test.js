// The IPv6 block — gt-guard.js › THE IPv6 LEAK.
//
// Measured on the reporting machine with the tunnel up: a global ISP address
// (2a02:4540:7057:…) and a working native ::/0 route on the Wi-Fi, with no ::/1 pair from
// Tailscale to take it away. Every IPv6-capable site was one AAAA record from seeing the
// user's real address. It was not leaking only because the kill-switch happened to be on —
// so this block is independent of it, and has a switch of its own.
//
// As in the sibling suites, PowerShell is a recorder: these scripts rewrite the machine's
// firewall and must never actually run here.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const SANDBOX = path.join(__dirname, 'home-ipv6');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

// What the block script "prints": OK + the addresses it just took off the wire, or NO_V4
// when the machine has no IPv4 route and blocking v6 would leave it with nothing.
let blockAnswer = 'OK 2a02:4540:7057:7ca7:a2b8:258e:d98d:2';
let failNext = false;
const scripts = [];
cp.execFile = (exe, args, opts, cb) => {
    const script = args[args.length - 1];
    scripts.push({ sync: false, script });
    // The firewall reading (gt-guard › ensureEnforcing): every profile on — the enforced case.
    if (/Get-NetConnectionProfile/.test(script)) return setImmediate(() => cb(null, JSON.stringify({ profiles: ['Domain', 'Private', 'Public'].map((Name) => ({ Name, Enabled: 'True', Inbound: 'Block' })), categories: ['Public'] }), ''));
    if (failNext) { failNext = false; return setImmediate(() => cb(new Error('Access is denied.'), '', 'Access is denied.')); }
    const out = /New-NetFirewallRule[^\n]*-ipv6-out/.test(script) ? blockAnswer : '';
    setImmediate(() => cb(null, out, ''));
};
cp.execFileSync = (exe, args) => { scripts.push({ sync: true, script: args[args.length - 1] }); return ''; };

const guard = require(ROOT + '/github-tunnel/gt-guard');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const last = (re) => [...scripts].reverse().find(s => re.test(s.script));

(async () => {
    const logs = [];
    let r = await guard.blockIpv6({ onLog: (m) => logs.push(m) });
    const script = last(/-ipv6-out/).script;

    // ── what is blocked ─────────────────────────────────────────────────────────
    t('it blocks global unicast IPv6 (2000::/3)', /-RemoteAddress 2000::\/3 -Action Block/.test(script));
    t('…outbound only', /-Direction Outbound/.test(script) && !/-Direction Inbound/.test(script));
    t('link-local and ULA are NOT blocked — the LAN and the overlay live there',
        !/fe80::\/10/.test(script) && !/fc00::\/7/.test(script) && !/fd7a:115c:a1e0/.test(script));
    t('rules live in their OWN group, apart from the kill switch and the DNS block',
        script.includes(`-Group '${guard.IPV6_GROUP}'`)
        && guard.IPV6_GROUP !== 'MLMVPN GitHub Tunnel' && guard.IPV6_GROUP !== guard.DNS_GROUP);

    // ── the safety net ──────────────────────────────────────────────────────────
    t('it refuses to act on a network with no IPv4 route',
        /Get-NetRoute -DestinationPrefix '0\.0\.0\.0\/0'/.test(script) && /NO_V4/.test(script),
        'blocking v6 there is the difference between a leak and no internet at all');
    t('a successful block reports the address it took off the wire',
        r.ok === true && r.addresses.includes('2a02:4540:7057:7ca7:a2b8:258e:d98d:2'), JSON.stringify(r));
    t('…and says so in the log', logs.some(l => /2a02:4540/.test(l)), JSON.stringify(logs));
    t('the crash record exists while blocked', fs.existsSync(guard.IPV6_STATE_FILE));
    t('isIpv6Blocked() is true', guard.isIpv6Blocked() === true);

    // ── independence from the kill switch ───────────────────────────────────────
    scripts.length = 0;
    await guard.disengage();
    t('turning the kill switch off does not lift the IPv6 block',
        !scripts.some(s => s.script.includes(guard.IPV6_GROUP)) && guard.isIpv6Blocked() === true,
        'the whole point: the kill switch is about the tunnel DROPPING, this is about it being UP');

    // ── independence from the DNS block ─────────────────────────────────────────
    scripts.length = 0;
    await guard.unblockLanDns();
    t('lifting the DNS block does not lift the IPv6 one',
        !scripts.some(s => s.script.includes(guard.IPV6_GROUP)) && guard.isIpv6Blocked() === true);

    // ── unblock ─────────────────────────────────────────────────────────────────
    scripts.length = 0;
    await guard.unblockIpv6();
    t('unblock removes exactly the IPv6 group',
        scripts.some(s => s.script.includes(`Remove-NetFirewallRule -Group '${guard.IPV6_GROUP}'`))
        && !scripts.some(s => /DefaultOutboundAction/.test(s.script)));
    t('…and clears the crash record', !fs.existsSync(guard.IPV6_STATE_FILE) && guard.isIpv6Blocked() === false);

    // ── a v6-only network ───────────────────────────────────────────────────────
    blockAnswer = 'NO_V4';
    r = await guard.blockIpv6();
    t('a machine with no IPv4 is left alone', r.ok === false && r.noV4 === true, JSON.stringify(r));
    t('…and no record is left behind', !fs.existsSync(guard.IPV6_STATE_FILE) && guard.isIpv6Blocked() === false);

    // ── no admin rights ─────────────────────────────────────────────────────────
    blockAnswer = 'OK ';
    failNext = true;
    scripts.length = 0;
    r = await guard.blockIpv6();
    t('a refused firewall change fails softly', r.ok === false && /denied/i.test(r.error || ''), JSON.stringify(r));
    t('…and cleans up after itself',
        scripts.some(s => s.script.includes(`Remove-NetFirewallRule -Group '${guard.IPV6_GROUP}'`))
        && !fs.existsSync(guard.IPV6_STATE_FILE));

    // ── the crash ───────────────────────────────────────────────────────────────
    r = await guard.blockIpv6();
    t('blocked again for the crash case', r.ok === true && fs.existsSync(guard.IPV6_STATE_FILE));
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    const fresh = require(ROOT + '/github-tunnel/gt-guard');
    t('after a hard kill the record survives', fs.existsSync(fresh.IPV6_STATE_FILE) && fresh.isIpv6Blocked() === false);
    scripts.length = 0;
    await fresh.restoreIfStale(() => {});
    t('startup self-heal removes an IPv6 block the last run left behind',
        scripts.some(s => s.script.includes(`Remove-NetFirewallRule -Group '${fresh.IPV6_GROUP}'`))
        && !fs.existsSync(fresh.IPV6_STATE_FILE));
    t('…without inventing a kill-switch restore that was never needed',
        !scripts.some(s => /Set-NetFirewallProfile/.test(s.script)));

    // ── process exit ────────────────────────────────────────────────────────────
    await fresh.blockIpv6();
    scripts.length = 0;
    fresh.unblockIpv6Sync();
    t('the exit path removes it synchronously', scripts.some(s => s.sync && s.script.includes(fresh.IPV6_GROUP))
        && !fs.existsSync(fresh.IPV6_STATE_FILE));

    // ── the lifecycle in routes.js ──────────────────────────────────────────────
    const routes = fs.readFileSync(ROOT + '/github-tunnel/routes.js', 'utf8');
    const bringUp = routes.slice(routes.indexOf('async function bringUp('), routes.indexOf('function engageGuard('));
    // Both engines are disconnected now (v2 then v1); the lock must lift before the FIRST.
    const firstDisconnect = (src) => Math.min(...['dataplane.v2.disconnect(', 'dataplane.v1.disconnect(', 'engine.disconnect(']
        .map((k) => src.indexOf(k)).filter((i) => i >= 0));
    const teardown = routes.slice(routes.indexOf('async function teardownAll('), routes.indexOf('e.setWatchdogLogger('));
    const armGuards = routes.slice(routes.indexOf('async function armGuards('), routes.indexOf('async function stopOurTunnel('));
    t('bringUp blocks IPv6 only in tun mode, after the connect is verified',
        /if \(mode === 'tun'\) await armGuards\(\);/.test(bringUp)
        && bringUp.indexOf('await armGuards()') > bringUp.indexOf('engine.connect(')
        && /if \(ipv6GuardEnabled && !guard\.isIpv6Blocked\(\)\)/.test(armGuards) && armGuards.includes('guard.blockIpv6('));
    t('…and lifts it before a reconnect that is not guarded',
        bringUp.indexOf('guard.unblockIpv6(') > 0
        && bringUp.indexOf('guard.unblockIpv6(') < bringUp.indexOf('await engine.disconnect(emitLog)'));
    t('teardownAll lifts it before the engine goes',
        teardown.indexOf('guard.unblockIpv6(') >= 0
        && teardown.indexOf('guard.unblockIpv6(') < firstDisconnect(teardown));
    t('the switch is off-able, and off means the block comes down',
        /ipv6GuardEnabled = !!\(req\.body && req\.body\.enabled\)/.test(routes)
        && /if \(!ipv6GuardEnabled\) await guard\.unblockIpv6\(/.test(routes));
    t('it defaults to ON', /let ipv6GuardEnabled = true;/.test(routes));
    t('the panel is told its state', /ipv6Guard: \{[\s\S]*?enabled: ipv6GuardEnabled/.test(routes));

    fs.rmSync(SANDBOX, { recursive: true, force: true });

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
