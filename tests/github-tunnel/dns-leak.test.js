// The DNS-leak block — gt-guard.js › THE DNS LEAK.
//
// «تونل گیت هاب نشتی داره — وارد یکسری سایت ها میشن میزنه ایران». The tunnel carried the
// traffic, but Windows asked the ROUTER as well as the tunnel for every name, and the router
// (on-link, one hop away) always answered first. On an Iranian line that answer comes from the
// filter. The block keeps lookups to on-link resolvers from leaving while the tunnel is up.
//
// Like kill-switch.test.js, PowerShell is replaced by a recorder: these scripts rewrite the
// machine's firewall and must never actually run here.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const SANDBOX = path.join(__dirname, 'home-dns');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

// What the next block script "prints". The real script prints OK + the refused servers, or
// ROLLED_BACK when resolution through the tunnel stopped working with the rules in place.
let blockAnswer = 'OK fe80::7885:d3ff:fe37:13dc,192.168.8.1';
let failNext = false;
const scripts = [];
cp.execFile = (exe, args, opts, cb) => {
    const script = args[args.length - 1];
    scripts.push({ sync: false, script });
    // The firewall reading (gt-guard › ensureEnforcing): every profile on — the enforced case.
    if (/Get-NetConnectionProfile/.test(script)) return setImmediate(() => cb(null, JSON.stringify({ profiles: ['Domain', 'Private', 'Public'].map((Name) => ({ Name, Enabled: 'True', Inbound: 'Block' })), categories: ['Public'] }), ''));
    if (failNext) { failNext = false; return setImmediate(() => cb(new Error('Access is denied.'), '', 'Access is denied.')); }
    const out = /New-NetFirewallRule[^\n]*-dns-/.test(script) ? blockAnswer : '';
    setImmediate(() => cb(null, out, ''));
};
cp.execFileSync = (exe, args) => { scripts.push({ sync: true, script: args[args.length - 1] }); return ''; };

const guard = require(ROOT + '/github-tunnel/gt-guard');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const last = (re) => [...scripts].reverse().find(s => re.test(s.script));

(async () => {
    const logs = [];
    let r = await guard.blockLanDns({ onLog: (m) => logs.push(m) });
    const script = last(/-dns-lan-/).script;

    // ── what is blocked ─────────────────────────────────────────────────────────
    t('it blocks DNS to on-link resolvers (LocalSubnet)', /-RemoteAddress LocalSubnet -Action Block/.test(script));
    t('…and to link-local, where the router\'s IPv6 DNS lives', /'fe80::\/10'/.test(script) && /'169\.254\.0\.0\/16'/.test(script));
    t('…UDP 53, and TCP 53 + 853 (DNS over TLS)', /@\('UDP', 'TCP'\)/.test(script) && /@\('53', '853'\)/.test(script));
    t('outbound only — nothing inbound is touched', /-Direction Outbound/.test(script) && !/-Direction Inbound/.test(script));
    t('the tunnel\'s own resolvers are never named in a block',
        !/100\.100\.100\.100|fd7a:115c:a1e0/.test(script), 'a block naming them would take all DNS with it');
    t('rules live in their OWN group, apart from the kill switch',
        script.includes(`-Group '${guard.DNS_GROUP}'`) && guard.DNS_GROUP !== 'MLMVPN GitHub Tunnel');

    // ── the safety net ──────────────────────────────────────────────────────────
    t('it proves resolution still works before keeping the rules',
        /Resolve-DnsName -Name \$probe/.test(script) && /ROLLED_BACK/.test(script));
    t('…with a never-seen name, so no cache can answer for it', /\[guid\]::NewGuid\(\)/.test(script));
    t('…and NXDOMAIN counts as reached (a server answered)', /9003/.test(script));
    t('a successful block reports what it refused', r.ok === true && r.blocked.includes('fe80::7885:d3ff:fe37:13dc'), JSON.stringify(r));
    t('…and says so in the log', logs.some(l => /fe80::7885/.test(l)), JSON.stringify(logs));
    t('the crash record exists while blocked', fs.existsSync(guard.DNS_STATE_FILE));
    t('isDnsBlocked() is true', guard.isDnsBlocked() === true);

    // ── independence from the kill switch ───────────────────────────────────────
    scripts.length = 0;
    await guard.disengage();
    t('turning the kill switch off does not lift the DNS block',
        !scripts.some(s => s.script.includes(guard.DNS_GROUP)) && guard.isDnsBlocked() === true);

    // ── unblock ─────────────────────────────────────────────────────────────────
    scripts.length = 0;
    await guard.unblockLanDns();
    t('unblock removes exactly the DNS group',
        scripts.some(s => s.script.includes(`Remove-NetFirewallRule -Group '${guard.DNS_GROUP}'`))
        && !scripts.some(s => /DefaultOutboundAction/.test(s.script)));
    t('…and clears the crash record', !fs.existsSync(guard.DNS_STATE_FILE) && guard.isDnsBlocked() === false);

    // ── a rollback ──────────────────────────────────────────────────────────────
    blockAnswer = 'ROLLED_BACK';
    r = await guard.blockLanDns();
    t('a block that broke resolution is reported as rolled back', r.ok === false && r.rolledBack === true, JSON.stringify(r));
    t('…and leaves no record behind (the script already removed the rules)',
        !fs.existsSync(guard.DNS_STATE_FILE) && guard.isDnsBlocked() === false);

    // ── no admin rights ─────────────────────────────────────────────────────────
    blockAnswer = 'OK ';
    failNext = true;
    scripts.length = 0;
    r = await guard.blockLanDns();
    t('a refused firewall change fails softly', r.ok === false && /denied/i.test(r.error || ''), JSON.stringify(r));
    t('…and cleans up after itself', scripts.some(s => s.script.includes(`Remove-NetFirewallRule -Group '${guard.DNS_GROUP}'`))
        && !fs.existsSync(guard.DNS_STATE_FILE));

    // ── the crash ───────────────────────────────────────────────────────────────
    r = await guard.blockLanDns();
    t('blocked again for the crash case', r.ok === true && fs.existsSync(guard.DNS_STATE_FILE));
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    const fresh = require(ROOT + '/github-tunnel/gt-guard');
    t('after a hard kill the record survives', fs.existsSync(fresh.DNS_STATE_FILE) && fresh.isDnsBlocked() === false);
    scripts.length = 0;
    const restored = await fresh.restoreIfStale(() => {});
    t('startup self-heal removes a DNS block the last run left behind',
        scripts.some(s => s.script.includes(`Remove-NetFirewallRule -Group '${fresh.DNS_GROUP}'`)) && !fs.existsSync(fresh.DNS_STATE_FILE),
        JSON.stringify(restored));
    t('…without inventing a kill-switch restore that was never needed',
        !scripts.some(s => /Set-NetFirewallProfile/.test(s.script)));

    // ── process exit ────────────────────────────────────────────────────────────
    await fresh.blockLanDns();
    scripts.length = 0;
    fresh.unblockLanDnsSync();
    t('the exit path removes it synchronously', scripts.some(s => s.sync && s.script.includes(fresh.DNS_GROUP))
        && !fs.existsSync(fresh.DNS_STATE_FILE));

    // ── the lifecycle in routes.js ──────────────────────────────────────────────
    const routes = fs.readFileSync(ROOT + '/github-tunnel/routes.js', 'utf8');
    const bringUp = routes.slice(routes.indexOf('async function bringUp('), routes.indexOf('function engageGuard('));
    // Both engines are disconnected now (v2 then v1); the lock must lift before the FIRST.
    const firstDisconnect = (src) => Math.min(...['dataplane.v2.disconnect(', 'dataplane.v1.disconnect(', 'engine.disconnect(']
        .map((k) => src.indexOf(k)).filter((i) => i >= 0));
    const teardown = routes.slice(routes.indexOf('async function teardownAll('), routes.indexOf('e.setWatchdogLogger('));
    const armGuards = routes.slice(routes.indexOf('async function armGuards('), routes.indexOf('async function stopOurTunnel('));
    const v2Up = routes.slice(routes.indexOf('async function bringUpV2('), routes.indexOf('async function buildFullTunnel('));
    t('bringUp blocks DNS only in tun mode, after the connect is verified',
        /if \(mode === 'tun'\) await armGuards\(\);/.test(bringUp)
        && bringUp.indexOf('await armGuards()') > bringUp.indexOf('engine.connect(')
        && /if \(!guard\.isDnsBlocked\(\)\)/.test(armGuards) && armGuards.includes('guard.blockLanDns('));
    t('v2 blocks it for the full tunnel only, after the tunnel is proven to carry data',
        /if \(full\) \{/.test(v2Up) && v2Up.indexOf('await armGuards()') > v2Up.indexOf('await buildFullTunnel()'));
    t('…and lifts it before a reconnect that is not guarded', /if \(!keepGuard\) await guard\.unblockLanDns\(/.test(bringUp)
        && bringUp.indexOf('guard.unblockLanDns(') < bringUp.indexOf('await engine.disconnect(emitLog)'));
    t('teardownAll lifts it before the engine goes',
        teardown.indexOf('guard.unblockLanDns(') >= 0 && teardown.indexOf('guard.unblockLanDns(') < firstDisconnect(teardown));

    fs.rmSync(SANDBOX, { recursive: true, force: true });

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
