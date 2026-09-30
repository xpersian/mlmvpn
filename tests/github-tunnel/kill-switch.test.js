// The kill-switch crash-recovery path, exercised for real — but with PowerShell replaced
// by a recorder, because the thing under test literally blocks all outbound traffic on the
// machine and this must never actually run it.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const SANDBOX = path.join(__dirname, 'home-guard');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

// Patch BEFORE gt-guard is required — it destructures these at module load.
const scripts = [];
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;
// The machine the stub describes. Public is OFF, but the live network is on Private, so the
// rules ARE enforced where it matters — the ordinary case of a partly configured firewall.
const fw = {
    profiles: [
        { Name: 'Domain', Outbound: 'NotConfigured', Enabled: 'True', Inbound: 'NotConfigured' },
        { Name: 'Private', Outbound: 'Allow', Enabled: 'True', Inbound: 'Block' },
        { Name: 'Public', Outbound: 'Block', Enabled: 'False', Inbound: 'NotConfigured' },
    ],
    categories: ['Private'],
    failEngage: false,
};
cp.execFile = (exe, args, opts, cb) => {
    const script = args[args.length - 1];
    scripts.push({ sync: false, script });
    if (fw.failEngage && /DefaultOutboundAction Block/.test(script)) return setImmediate(() => cb(new Error('New-NetFirewallRule : boom')));
    // Two reads: the enforcement check (profiles + the networks' categories) and the capture;
    // everything else is a write.
    const out = /Get-NetConnectionProfile/.test(script)
        ? JSON.stringify({ profiles: fw.profiles.map(({ Name, Enabled, Inbound }) => ({ Name, Enabled, Inbound })), categories: fw.categories })
        : /Get-NetFirewallProfile/.test(script)
            ? JSON.stringify(fw.profiles.map(({ Name, Outbound, Enabled }) => ({ Name, Outbound, Enabled })))
            : '';
    setImmediate(() => cb(null, out, ''));
};
cp.execFileSync = (exe, args) => { scripts.push({ sync: true, script: args[args.length - 1] }); return ''; };

const guard = require(ROOT + '/github-tunnel/gt-guard');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

(async () => {
    // ── engage ───────────────────────────────────────────────────────────────────
    await guard.engage({ adapterName: 'mlmvpn-gt', allowPrograms: ['C:\\app\\MLM VPN.exe', 'C:\\core\\tailscaled.exe'] });

    t('engage records the PRE-CHANGE profile state on disk', fs.existsSync(guard.STATE_FILE));
    const saved = JSON.parse(fs.readFileSync(guard.STATE_FILE, 'utf8'));
    t('profile actions are preserved EXACTLY, not collapsed (Allow=2/Block=4 enum trap)',
        saved.profiles.find(p => p.name === 'Domain').action === 'NotConfigured'
        && saved.profiles.find(p => p.name === 'Private').action === 'Allow',
        JSON.stringify(saved.profiles));
    t('a profile that was ALREADY blocking is remembered as Block',
        saved.profiles.find(p => p.name === 'Public').action === 'Block');
    t('the record holds outbound actions only — the on/off switch belongs to the firewall lease',
        saved.profiles.every(p => !('enabled' in p)), JSON.stringify(saved.profiles));

    const engageScript = scripts.find(s => /DefaultOutboundAction Block/.test(s.script)).script;
    t('the record is written before the firewall is touched',
        scripts.findIndex(s => /DefaultOutboundAction Block/.test(s.script)) >= 0 && fs.existsSync(guard.STATE_FILE));
    t('allow rules are created BEFORE block-by-default',
        engageScript.indexOf('-tunnel') < engageScript.indexOf('Set-NetFirewallProfile -All -DefaultOutboundAction Block'));
    t('engage never switches a profile on by itself', !/-Enabled True/.test(engageScript));
    t('the tunnel adapter, loopback, LAN and DHCP are allowed',
        ['-tunnel', '-loopback', '-lan', '-dhcp'].every(k => engageScript.includes(k)));
    t('…and there is NO ::1 rule: Windows rejects it, and the whole kill switch died on that line (1.2.3)',
        !/-RemoteAddress ::1/.test(engageScript) && !/-loopback6/.test(engageScript));
    t('both programs are allow-listed so recovery is possible while blocked',
        (engageScript.match(/-prog-/g) || []).length === 2);
    t("a program path containing a quote can't break out of the script",
        !/-Program 'C:\\\\app\\\\MLM VPN\.exe''/.test(engageScript));

    // ── the crash ────────────────────────────────────────────────────────────────
    // Simulate the process dying without running a single line of cleanup: drop the
    // module and re-require it, exactly as a fresh launch would.
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    const fresh = require(ROOT + '/github-tunnel/gt-guard');
    t('after a hard kill the machine is still recorded as firewalled', fs.existsSync(fresh.STATE_FILE));
    t('a fresh process starts with isEngaged()=false (in-memory state is gone)', fresh.isEngaged() === false);

    scripts.length = 0;
    const r = await fresh.restoreIfStale();
    t('startup restore reports it did something', r.restored === true, JSON.stringify(r));

    const restoreScript = scripts.map(s => s.script).join('\n');
    t('restore puts EACH profile back to exactly the action it had — and leaves its on/off alone',
        /Set-NetFirewallProfile -Name 'Domain' -DefaultOutboundAction NotConfigured(\n|$)/m.test(restoreScript)
        && /Set-NetFirewallProfile -Name 'Private' -DefaultOutboundAction Allow(\n|$)/m.test(restoreScript)
        && /Set-NetFirewallProfile -Name 'Public' -DefaultOutboundAction Block(\n|$)/m.test(restoreScript)
        && !/-Enabled/.test(restoreScript),
        restoreScript.replace(/\n+/g, ' | ').slice(0, 300));
    t('restore never sets a profile to Block that was not already Block',
        (restoreScript.match(/-DefaultOutboundAction Block/g) || []).length === 1);
    t('restore also removes the leftover rules', /Remove-NetFirewallRule -Group/.test(restoreScript));
    t('the record is cleared only after the restore ran', !fs.existsSync(fresh.STATE_FILE));

    const again = await fresh.restoreIfStale();
    t('a second startup restore is a no-op', again.restored === false);

    // ── a record from an older build still carries the on/off switch, and is honoured ─────
    fs.writeFileSync(fresh.STATE_FILE, JSON.stringify({ engagedAt: Date.now(), profiles: [
        { name: 'Public', action: 'Allow', enabled: 'False' },
    ] }));
    scripts.length = 0;
    await fresh.restoreIfStale();
    t('an older record (with Enabled) is put back exactly as it was written',
        scripts.some(s => /Set-NetFirewallProfile -Name 'Public' -DefaultOutboundAction Allow -Enabled False/.test(s.script)));

    // ════ WINDOWS FIREWALL SWITCHED OFF ════════════════════════════════════════════
    // Measured on the reporting machine: all three profiles off. A rule nothing enforces is a
    // claim, not a guard — and switching someone's firewall on is not ours to decide.
    const offProfiles = [
        { Name: 'Domain', Outbound: 'Allow', Enabled: 'False', Inbound: 'NotConfigured' },
        { Name: 'Private', Outbound: 'Allow', Enabled: 'False', Inbound: 'NotConfigured' },
        { Name: 'Public', Outbound: 'Allow', Enabled: 'False', Inbound: 'NotConfigured' },
    ];
    fw.profiles = offProfiles;
    fw.categories = ['Public'];
    scripts.length = 0;
    let logs = [];
    let off = await fresh.engage({ adapterName: 'MLMVPN', allowPrograms: [], onLog: (m) => logs.push(m) });
    t('firewall off, not allowed: the kill switch refuses, and says why',
        off.ok === false && off.reason === 'firewall-disabled' && logs.some(l => /دیوارآتش ویندوز روی این سیستم خاموش است/.test(l)), JSON.stringify(off));
    t('…having written nothing and changed nothing',
        !scripts.some(s => /New-NetFirewallRule|Set-NetFirewallProfile/.test(s.script)) && !fs.existsSync(fresh.STATE_FILE) && !fs.existsSync(fresh.FW_STATE_FILE));
    t('…and the status says the rules are not enforced', fresh.firewallStatus().enforcing === false
        && fresh.firewallStatus().off.length === 3 && fresh.firewallStatus().autoEnable === false);
    scripts.length = 0;
    const dnsOff = await fresh.blockLanDns({});
    const v6Off = await fresh.blockIpv6({});
    t('firewall off: the DNS and IPv6 locks refuse too, instead of reading «active»',
        dnsOff.ok === false && v6Off.ok === false && !fresh.isDnsBlocked() && !fresh.isIpv6Blocked()
        && !scripts.some(s => /New-NetFirewallRule/.test(s.script)));

    // The user's explicit choice: on for the tunnel's lifetime, inbound left open, put back exactly.
    fresh.setFirewallPolicy({ enableWhenOff: true });
    scripts.length = 0;
    logs = [];
    const on = await fresh.engage({ adapterName: 'MLMVPN', allowPrograms: [], onLog: (m) => logs.push(m) });
    const leaseScript = scripts.find(s => /-Enabled True -DefaultInboundAction Allow/.test(s.script));
    t('allowed: the kill switch engages', on.ok === true && fresh.isEngaged(), JSON.stringify(on));
    t('…switching the OFF profiles on with inbound left ALLOWED (nothing that reached the machine stops)',
        leaseScript && ['Domain', 'Private', 'Public'].every(n => leaseScript.script.includes(`Set-NetFirewallProfile -Name '${n}' -Enabled True -DefaultInboundAction Allow`)));
    t('…recording them before the change', fs.existsSync(fresh.FW_STATE_FILE)
        && JSON.parse(fs.readFileSync(fresh.FW_STATE_FILE, 'utf8')).profiles.every(p => p.enabled === 'False' && p.inbound === 'NotConfigured'));
    t('…and saying so', logs.some(l => /فقط برای مدت اتصال روشن شد/.test(l)));
    const onDns = await fresh.blockLanDns({});
    t('…the DNS lock then works under the same lease', onDns.ok === true && fresh.isDnsBlocked());

    scripts.length = 0;
    await fresh.disengage();
    t('releasing the kill switch alone keeps the firewall on — the DNS lock still needs it',
        !scripts.some(s => /-Enabled False/.test(s.script)) && fs.existsSync(fresh.FW_STATE_FILE));
    scripts.length = 0;
    await fresh.unblockLanDns();
    const back = scripts.map(s => s.script).join('\n');
    t('the last guard to let go puts every profile back exactly: Enabled AND inbound',
        ['Domain', 'Private', 'Public'].every(n => back.includes(`Set-NetFirewallProfile -Name '${n}' -Enabled False -DefaultInboundAction NotConfigured`))
        && !fs.existsSync(fresh.FW_STATE_FILE), back.slice(0, 300));

    // A crash while holding the lease: the next launch switches the firewall back off, last.
    await fresh.engage({ adapterName: 'MLMVPN', allowPrograms: [] });
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    const g2 = require(ROOT + '/github-tunnel/gt-guard');
    scripts.length = 0;
    await g2.restoreIfStale();
    const rec = scripts.map(s => s.script);
    const iOut = rec.findIndex(s => /-DefaultOutboundAction/.test(s));
    const iLease = rec.findIndex(s => /-Enabled False -DefaultInboundAction NotConfigured/.test(s));
    t('after a crash the lease is undone too — after the kill switch, never before it',
        iOut >= 0 && iLease > iOut && !fs.existsSync(g2.FW_STATE_FILE) && !fs.existsSync(g2.STATE_FILE), JSON.stringify([iOut, iLease]));

    // An engage that dies halfway undoes itself: half an allow-list is the dangerous state.
    fw.profiles = [
        { Name: 'Domain', Outbound: 'Allow', Enabled: 'True', Inbound: 'Block' },
        { Name: 'Private', Outbound: 'Allow', Enabled: 'True', Inbound: 'Block' },
        { Name: 'Public', Outbound: 'Allow', Enabled: 'True', Inbound: 'Block' },
    ];
    fw.failEngage = true;
    scripts.length = 0;
    logs = [];
    const half = await g2.engage({ adapterName: 'MLMVPN', allowPrograms: [], onLog: (m) => logs.push(m) });
    t('an engage that fails halfway reports it and undoes what landed',
        half.ok === false && half.reason === 'script-failed' && !g2.isEngaged()
        && scripts.some(s => /Remove-NetFirewallRule -Group 'MLMVPN GitHub Tunnel'/.test(s.script) && /-DefaultOutboundAction Allow/.test(s.script))
        && !fs.existsSync(g2.STATE_FILE) && logs.some(l => /هر چه ساخته بود برداشته شد/.test(l)), JSON.stringify(half));
    fw.failEngage = false;

    // ── a restore that FAILS must not throw the record away ──────────────────────
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    // Swap the stub BEFORE the require: gt-guard destructures execFile at module load, so
    // patching afterwards leaves it holding the old reference.
    cp.execFile = (exe, args, opts, cb) => setImmediate(() => cb(new Error('Access is denied')));
    const g3 = require(ROOT + '/github-tunnel/gt-guard');
    fs.writeFileSync(g3.STATE_FILE, JSON.stringify({ engagedAt: Date.now(), profiles: [{ name: 'Public', action: 'Allow' }] }));
    const bad = await g3.restoreIfStale();
    t('a failed restore keeps the record for the next launch', bad.restored === false && fs.existsSync(g3.STATE_FILE),
        JSON.stringify(bad));

    cp.execFile = origExecFile;
    cp.execFileSync = origExecFileSync;

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
