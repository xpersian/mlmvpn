// «گیت‌وی MLM» installs its own engine — gateway-manager.js › ensureClient / provisionClient.
//
// Reported 2026-09-22: on a new computer the gateway said the engine was not installed, and the
// user was expected to go and find SoftEther. The client now ships in core/softether and the
// first connect installs it as the machine's client service. The dangerous half of that is the
// one command that does it, `/setup_install`, which REPLACES any service of the same name — so
// the most important rows below are the ones where it must NOT run.
//
// Nothing here installs anything. child_process, net and the bundle's location are replaced
// before the manager is loaded; ProgramData and Program Files point into a sandbox, so the real
// SoftEther on a developer machine is neither found nor touched.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const cp = require('child_process');
const { EventEmitter } = require('events');

const SANDBOX = path.join(__dirname, 'home-provision');
fs.rmSync(SANDBOX, { recursive: true, force: true });
const BUNDLE = path.join(SANDBOX, 'bundle');
const PROGRAMDATA = path.join(SANDBOX, 'ProgramData');
fs.mkdirSync(BUNDLE, { recursive: true });
fs.mkdirSync(PROGRAMDATA, { recursive: true });
for (const f of ['vpnclient_x64.exe', 'vpncmd_x64.exe', 'vpnclient.exe', 'vpncmd.exe', 'hamcore.se2', 'lang.config', 'LICENSE.txt']) {
    fs.writeFileSync(path.join(BUNDLE, f), 'fake ' + f);
}
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
process.env.ProgramData = PROGRAMDATA;
process.env.ProgramFiles = path.join(SANDBOX, 'ProgramFiles');
process.env['ProgramFiles(x86)'] = path.join(SANDBOX, 'ProgramFiles86');

// ── the bundle lives in the sandbox, and the store can "activate" a newer copy ──
const STORE_COPY = path.join(SANDBOX, 'store-4.45.9900');
let storeActive = null;          // null, or the version the store has activated from STORE_COPY
const realPaths = require(ROOT + '/core-paths');
require.cache[require.resolve(ROOT + '/core-paths')].exports = Object.assign({}, realPaths, {
    bundled: (...seg) => (seg[0] === 'core' && seg[1] === 'softether')
        ? path.join(BUNDLE, ...seg.slice(2)) : realPaths.bundled(...seg),
    dir: (id, fallback) => (id === 'softether' && storeActive ? STORE_COPY : realPaths.dir(id, fallback)),
    activeVersion: (id) => (id === 'softether' ? storeActive : realPaths.activeVersion(id)),
});

// ── a pretend Windows ───────────────────────────────────────────────────────────
const LOCKED = 'O:BAG:SYD:PAI(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)';
const OPEN = 'O:BAG:SYD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIID;0x1301bf;;;BU)';
let world;
const reset = (w) => {
    world = Object.assign({ service: null, disabled: false, locked: true, installWorks: true,
        serviceAppearsOnRecheck: false, regQueries: 0, calls: [] }, w || {});
};

cp.spawnSync = (exe, args) => {
    world.calls.push({ exe, args, sync: true });
    if (/^reg$/i.test(exe) && args[0] === 'query') {
        world.regQueries++;
        if (world.serviceAppearsOnRecheck && world.regQueries >= 2 && !world.service) {
            world.service = 'C:\\Program Files\\SoftEther VPN Client\\vpnclient_x64.exe';
        }
        return world.service
            ? { status: 0, stdout: `\r\nHKEY_LOCAL_MACHINE\\...\\SEVPNCLIENT\r\n    ImagePath    REG_EXPAND_SZ    "${world.service}" /service\r\n` }
            : { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' };
    }
    return { status: 0, stdout: 'The command completed successfully.', stderr: '' };
};

cp.spawn = (exe, args) => {
    world.calls.push({ exe, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const script = String(args[args.length - 1] || '');
    let out = '';
    let code = 0;
    if (/icacls/i.test(exe)) out = 'processed file';
    else if (/powershell/i.test(exe) && /Get-Acl/.test(script)) out = world.locked ? LOCKED : OPEN;
    else if (/powershell/i.test(exe) && /Get-Service/.test(script)) {
        out = !world.service ? 'NONE' : world.disabled ? 'DISABLED' : 'Running';
    } else if (/vpnclient(_x64)?\.exe$/i.test(exe) && args[0] === '/setup_install') {
        if (world.installWorks) world.service = exe;
        code = world.installWorks ? 0 : 1;
    }
    setImmediate(() => {
        if (out) child.stdout.emit('data', Buffer.from(out));
        child.emit('close', code);
    });
    return child;
};

// The client's management port answers as soon as the service "runs".
net.connect = () => {
    const s = new EventEmitter();
    s.setTimeout = () => {};
    s.destroy = () => {};
    setImmediate(() => (world.service ? s.emit('connect') : s.emit('error', new Error('ECONNREFUSED'))));
    return s;
};

const gw = require(ROOT + '/gateway-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const ran = (re) => world.calls.filter(c => !c.sync && re.test([c.exe, ...(c.args || [])].join(' ')));
const idx = (re) => world.calls.findIndex(c => !c.sync && re.test([c.exe, ...(c.args || [])].join(' ')));
const dest = path.join(PROGRAMDATA, 'MLM VPN', 'softether');

(async () => {
    // ── 1. a machine that has never had SoftEther ──────────────────────────────
    reset();
    t('status says the engine can be installed', gw.getStatus().installable === true && gw.getStatus().installed === false);
    const logs = [];
    await gw.ensureClient((m) => logs.push(m), () => {});
    t('the shipped client lands in ProgramData\\MLM VPN\\softether', gw.provisionDir() === dest
        && ['vpnclient_x64.exe', 'vpncmd_x64.exe', 'hamcore.se2'].every(f => fs.existsSync(path.join(dest, f))));
    t('…with lang.config (vpncmd output is parsed in English) and the licence',
        fs.existsSync(path.join(dest, 'lang.config')) && fs.existsSync(path.join(dest, 'LICENSE.txt')));
    t('the folder is locked BEFORE anything is copied or registered',
        idx(/icacls.*inheritance:r/) >= 0 && idx(/icacls.*inheritance:r/) < idx(/setup_install/));
    t('…SYSTEM and Administrators write, Users and Authenticated Users read only',
        ran(/icacls/).some(c => c.args.includes('*S-1-5-18:(OI)(CI)F') && c.args.includes('*S-1-5-32-545:(OI)(CI)RX')
            && c.args.includes('*S-1-5-11:(OI)(CI)RX')));
    const install = ran(/setup_install/);
    t('exactly one silent install, of the COPY — never of the bundle in the app folder',
        install.length === 1 && install[0].exe === path.join(dest, 'vpnclient_x64.exe'), JSON.stringify(install.map(c => c.exe)));
    t('the service is set to start on demand, not at every boot',
        ran(/sc\.exe config SEVPNCLIENT start= demand/).length === 1);
    t('the install is marked as ours', fs.existsSync(path.join(dest, 'installed-by-mlmvpn.json')));
    t('…and started before the connect goes on', ran(/Get-Service/).length >= 1 && gw.isInstalled());
    t('the user is told it is a one-time step', logs.some(l => /فقط بار اول/.test(l)), JSON.stringify(logs));
    t('no dialogs: nothing but /setup_install is ever passed to the client',
        world.calls.filter(c => /vpnclient/i.test(c.exe)).every(c => c.args.length === 1 && c.args[0] === '/setup_install'));

    // ── 2. the user's own SoftEther ─────────────────────────────────────────────
    reset({ service: 'D:\\Tools\\SoftEther VPN Client\\vpnclient_x64.exe' });
    await gw.ensureClient(() => {}, () => {});
    t("a SoftEther the user installed is used as it is — no install, no copy, no ACL change",
        ran(/setup_install|icacls/).length === 0);
    t('…found wherever it lives, from the service\'s registered path', ran(/Get-Service/).length === 1);

    // ── 3. one appears while ours is being copied ───────────────────────────────
    fs.rmSync(dest, { recursive: true, force: true });
    reset({ serviceAppearsOnRecheck: true });
    await gw.ensureClient(() => {}, () => {});
    t('the check is repeated right before /setup_install, which would replace it',
        ran(/setup_install/).length === 0 && world.regQueries >= 2);

    // ── 4. a folder that would not lock ─────────────────────────────────────────
    fs.rmSync(dest, { recursive: true, force: true });
    reset({ locked: false });
    let err = null;
    try { await gw.ensureClient(() => {}, () => {}); } catch (e) { err = e; }
    t('an unlockable folder refuses the install (the service runs as SYSTEM)',
        !!err && /قفل نشد/.test(err.message) && ran(/setup_install/).length === 0, err && err.message);
    t('…and nothing is copied into it', !fs.existsSync(path.join(dest, 'vpnclient_x64.exe')));

    // ── 5. an install that did not take ─────────────────────────────────────────
    reset({ installWorks: false });
    err = null;
    try { await gw.ensureClient(() => {}, () => {}); } catch (e) { err = e; }
    t('a failed /setup_install is an error that says so', !!err && /نصب موتور گیت‌وی انجام نشد/.test(err.message), err && err.message);

    // ── 6. the user disabled the service ────────────────────────────────────────
    reset({ service: 'C:\\Program Files\\SoftEther VPN Client\\vpnclient_x64.exe', disabled: true });
    err = null;
    try { await gw.ensureClient(() => {}, () => {}); } catch (e) { err = e; }
    t('a disabled service is left alone, with the fix named', !!err && /services\.msc/.test(err.message)
        && ran(/sc\.exe config/).length === 0, err && err.message);

    // ── 7. the store activates a newer engine ───────────────────────────────────
    // Ours is installed (from case 1's run, re-made here for a clean record) at the shipped 4.44.9807.
    fs.rmSync(dest, { recursive: true, force: true });
    reset();
    await gw.ensureClient(() => {}, () => {});
    const marker = () => JSON.parse(fs.readFileSync(path.join(dest, 'installed-by-mlmvpn.json'), 'utf8'));
    t('our install records the version it was made from', marker().version === '4.44.9807', JSON.stringify(marker()));

    fs.mkdirSync(STORE_COPY, { recursive: true });
    for (const f of ['vpnclient_x64.exe', 'vpncmd_x64.exe', 'vpnclient.exe', 'vpncmd.exe', 'hamcore.se2', 'lang.config', 'LICENSE.txt']) {
        fs.writeFileSync(path.join(STORE_COPY, f), 'store 4.45 ' + f);
    }
    storeActive = '4.45.9900';
    const service = world.service;
    reset({ service });
    const upLogs = [];
    await gw.ensureClient((m) => upLogs.push(m), () => {});
    t('the next connect moves OUR service to the store\'s newer version',
        fs.readFileSync(path.join(dest, 'vpnclient_x64.exe'), 'utf8') === 'store 4.45 vpnclient_x64.exe'
        && marker().version === '4.45.9900', JSON.stringify(marker()));
    t('…stopping it first, and starting it again after', idx(/Stop-Service/) >= 0 && idx(/Stop-Service/) < idx(/Get-Service -Name 'SEVPNCLIENT' -ErrorAction SilentlyContinue/));
    t('…in place: the service is not registered again', ran(/setup_install/).length === 0);
    t('…and says so', upLogs.some(l => /4\.44\.9807/.test(l) && /4\.45\.9900/.test(l)), JSON.stringify(upLogs));

    reset({ service });
    await gw.ensureClient(() => {}, () => {});
    t('already on the store\'s version: nothing is stopped or copied', ran(/Stop-Service/).length === 0);

    reset({ service: 'C:\\Program Files\\SoftEther VPN Client\\vpnclient_x64.exe' });
    await gw.ensureClient(() => {}, () => {});
    t("a SoftEther the user installed is never upgraded from the store — theirs to update",
        ran(/Stop-Service|setup_install|icacls/).length === 0);
    storeActive = null;

    // ── 8. a build that lost its bundle ─────────────────────────────────────────
    fs.rmSync(path.join(BUNDLE, 'hamcore.se2'));
    reset();
    t('status says it cannot be installed', gw.getStatus().installable === false);
    err = null;
    try { await gw.ensureClient(() => {}, () => {}); } catch (e) { err = e; }
    t('…and the error names a broken build, not a program to go and find',
        !!err && /ناقص/.test(err.message) && !/پیدا کنید|دانلود/.test(err.message) && ran(/icacls/).length === 0, err && err.message);

    // ── 9. the route and the panel ──────────────────────────────────────────────
    const server = fs.readFileSync(ROOT + '/server.js', 'utf8');
    const route = server.slice(server.indexOf("app.post('/api/gateway/connect'"), server.indexOf("app.post('/api/gateway/disconnect'"));
    t('the connect route no longer refuses a machine without SoftEther',
        /!gateway\.isInstalled\(\) && !gateway\.canProvision\(\)/.test(route));
    const panel = fs.readFileSync(ROOT + '/public/components/gateway.js', 'utf8');
    t('the panel never tells the user to install SoftEther',
        !/یک بار نصبش کنید|موتور سافت‌اتر نصب نیست|موتور سافت‌اتر روی این سیستم نیست/.test(panel));
    t('…and shows the one-time setup while it runs', /s\.stage === 'installing'/.test(panel));

    fs.rmSync(SANDBOX, { recursive: true, force: true });

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
