// «هماهنگی پنل‌ها بین گوشی و ویندوز» — panel-registry.js and cloud-panels.js › resolveExisting.
//
// The user's rule (2026-09-30): one install per panel per Cloudflare account, shared by both apps;
// never a new Worker / KV / D1 when the account already has one. These are the decisions that
// rule rests on, checked without the network: the shared record format (the SAME JSON Android's
// PanelRegistry.kt reads and writes), and the order resolveExisting takes — registry, our own
// record, a panel already on the account (adopted), and only then a new one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway home, so ~/.mlmvpn/cloud-panels.json is never the user's.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-reg-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const ROOT = path.resolve(__dirname, '../..');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// ── 1. the shared format ─────────────────────────────────────────────────────────
const reg = require(path.join(ROOT, 'panel-registry.js'));
const samples = {
    NTR: { script: 'a-ntr', url: 'https://a-ntr.s.workers.dev', kvId: 'k1', uuid: 'u', trPass: 'tp', subPath: 'sp' },
    GZG: { script: 'a-gzg', url: 'https://a-gzg.s.workers.dev', d1Id: 'd1', panelPath: 'gp', subPath: 'gs', password: 'pw' },
    NVA: { script: 'a-nva', url: 'https://a-nva.s.workers.dev', d1Id: 'd2', kvId: 'k2', password: 'pw2' },
    SPD: { script: 'a-spd', url: 'https://a-spd.s.workers.dev', kvId: 'k3', token: 'tok' },
    NHN: { script: 'a-nhn', url: 'https://a-nhn.s.workers.dev', d1Id: 'd3', masterKey: 'mk', apiRoute: 'rt' },
    MLM: { script: 'a-mlm', url: 'https://a-mlm.s.workers.dev', d1Id: 'd4', password: 'pw3' },
    BPB: { script: 'bpb', url: 'https://bpb.s.workers.dev', kvId: 'k4', uuid: 'u2', trPass: 't2', subPath: 's2' },
    EDG: { script: 'edg', url: 'https://edg.s.workers.dev', kvId: 'k5', uuid: 'u3' },
};
for (const [code, rec] of Object.entries(samples)) {
    const g = reg.toRegistry(code, rec);
    const back = reg.fromRegistry(code, Object.assign({ v: 1, code, by: 'android', at: 1 }, g));
    const keys = Object.keys(rec);
    t(`${code}: a record survives the round trip through the shared format`,
        keys.every((k) => back[k] === rec[k]), JSON.stringify({ g, back }));
}
t('the record carries the Android field names for credentials (Kotlin reads s.uuid / s.trPass / s.subPath …)',
    JSON.stringify(reg.toRegistry('NTR', samples.NTR).s) === JSON.stringify({ uuid: 'u', trPass: 'tp', subPath: 'sp' })
    && JSON.stringify(reg.toRegistry('GZG', samples.GZG).s) === JSON.stringify({ panelPath: 'gp', subPath: 'gs', password: 'pw' })
    && JSON.stringify(reg.toRegistry('NHN', samples.NHN).s) === JSON.stringify({ masterKey: 'mk', apiRoute: 'rt' }));
t('storage goes as kv / d1 ids, null when the panel has none',
    reg.toRegistry('SPD', samples.SPD).d1 === null && reg.toRegistry('SPD', samples.SPD).kv === 'k3' && reg.toRegistry('GZG', samples.GZG).d1 === 'd1');
t('a Nahan the old phone app published with «admin» is marked to be secured by the next deploy',
    reg.fromRegistry('NHN', { script: 'x', url: 'u', s: { masterKey: 'admin', apiRoute: 'sync' } }).fresh === true
    && !reg.fromRegistry('NHN', { script: 'x', url: 'u', s: { masterKey: 'k', apiRoute: 'r' } }).fresh);
t('…and so is a Gozargah still on its public password',
    reg.fromRegistry('GZG', { script: 'x', url: 'u', s: { password: 'admin' } }).fresh === true);
t('the registry namespace has one fixed title, the same on Android', reg.NS_TITLE === 'mlmvpn-panels'
    && /const val NS_TITLE = "mlmvpn-panels"/.test(fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/mlmvpn/scanner/engines/cloud/PanelRegistry.kt'), 'utf8')));
t('scriptOf reads the Worker name from its workers.dev address', reg.scriptOf('https://abc-ntr.sub.workers.dev/x') === 'abc-ntr' && reg.scriptOf('') === null);
t('BPB settings compiled into its code are found by balanced braces (no space, no newline — the panel\'s own redeploy)',
    JSON.parse(reg.balancedJson('Object.assign(globalThis,{"EMBEDED_SETTINGS":{"vlUUID":"a{b}","x":{"y":1}}});import x', 25)).EMBEDED_SETTINGS.vlUUID === 'a{b}');

// ── 2. resolveExisting: the order ────────────────────────────────────────────────
// A fake registry module in require's cache: no network.
const fake = { store: {}, exists: new Set(), found: [], adopted: null, calls: [] };
const regPath = require.resolve(path.join(ROOT, 'panel-registry.js'));
const real = require(regPath);
require.cache[regPath].exports = Object.assign({}, real, {
    get: async (acc, code) => { fake.calls.push('get:' + code); return fake.store[code] || null; },
    put: async (acc, code, rec) => { fake.calls.push('put:' + code); fake.store[code] = Object.assign({ by: 'windows' }, rec); return true; },
    remove: async () => true,
    scriptExists: async (acc, s) => fake.exists.has(s),
    find: async () => fake.found,
    adopt: async (acc, code, script) => { fake.calls.push('adopt:' + script); return fake.adopted; },
    forgetSurvey: () => {},
});
const cp = require(path.join(ROOT, 'cloud-panels.js'));
const acc = { id: 'acc1', token: 't', email: 'e' };
const steps = [];
const step = (m) => steps.push(m);

(async () => {
    // registry has it and its Worker is there → used as it is, saved locally, nothing adopted
    fake.store = { GZG: { script: 'phone-gzg', url: 'https://phone-gzg.s.workers.dev', d1: 'dd', s: { panelPath: 'p', subPath: 's', password: 'pw' }, by: 'android' } };
    fake.exists = new Set(['phone-gzg']);
    let r = await cp.resolveExisting('GZG', acc, step);
    const saved = cp.install('GZG', 'acc1');
    t('1. the account\'s registry wins: its Worker is used as it is', r.from === 'registry' && saved && saved.script === 'phone-gzg' && saved.password === 'pw' && saved.d1Id === 'dd',
        JSON.stringify({ r, saved }));
    t('…and the user is told it is the phone\'s install, with no new Worker or D1', steps.some((m) => /نصب گوشی/.test(m) && /تازه‌ای ساخته نمی‌شود/.test(m)));

    // registry points at a Worker that is gone, our own record's Worker is there → ours
    fake.store = { NTR: { script: 'gone', url: 'u', s: {} } };
    fake.exists = new Set(['mine-ntr']);
    const store = path.join(HOME, '.mlmvpn', 'cloud-panels.json');
    const s0 = JSON.parse(fs.readFileSync(store, 'utf8'));
    s0['NTR:acc1'] = { script: 'mine-ntr', url: 'https://mine-ntr.s.workers.dev', uuid: 'u', trPass: 't', subPath: 's', kvId: 'k' };
    fs.writeFileSync(store, JSON.stringify(s0));
    r = await cp.resolveExisting('NTR', acc, step);
    t('2. a registry record whose Worker is gone is not used; our own live install stays', r.from === 'local', JSON.stringify(r));

    // nothing in the registry, nothing local, a panel already on the account → adopted
    fake.store = {}; fake.exists = new Set();
    fake.found = [{ script: 'phone-nva', modifiedOn: '2026-09-28' }, { script: 'older-nva', modifiedOn: '2026-09-01' }];
    fake.adopted = { rec: { script: 'phone-nva', url: 'https://phone-nva.s.workers.dev', password: 'read-from-kv', d1Id: 'd', kvId: 'k' }, reset: [] };
    fake.calls = [];
    r = await cp.resolveExisting('NVA', acc, step);
    const nva = cp.install('NVA', 'acc1');
    t('3. a panel of this kind already on the account is ADOPTED (the newest), not installed again',
        r.from === 'adopted' && r.script === 'phone-nva' && fake.calls.includes('adopt:phone-nva') && nva && nva.password === 'read-from-kv', JSON.stringify({ r, nva, calls: fake.calls }));
    t('…and the others of its kind are reported, for the duplicates list', JSON.stringify(r.others) === JSON.stringify(['older-nva']));

    // nothing anywhere → a new install
    fake.found = [];
    r = await cp.resolveExisting('SPD', acc, step);
    t('4. only when the account has none of it anywhere is a new one made', r.from === 'new', JSON.stringify(r));

    // the deploy path publishes what it installed (source check: publish after DEPLOY)
    const src = fs.readFileSync(path.join(ROOT, 'cloud-panels.js'), 'utf8');
    t('deploy() resolves the existing install BEFORE any Worker/KV/D1 is made, and publishes after',
        /await resolveExisting\(p\.code, acc, step\);\s*\n\s*const inst = await DEPLOY\[p\.code\]\(acc, step\);[\s\S]{0,80}await publish\(p\.code, acc, inst, step\);/.test(src));
    t('removing a panel removes its registry record only when it still points at that Worker',
        /if \(g && g\.script === inst\.script\) await registry\(\)\.remove\(acc, p\.code\)/.test(src));
    t('a duplicate\'s storage is deleted only when no other Worker binds it, and only when every binding could be read',
        /const complete = bs\.every\(Boolean\);/.test(src) && /complete \? d\.kv\.filter\(\(k\) => !usedBy\('kv', k\)\.length\) : \[\]/.test(src));
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    t('BPB\'s deploy reuses the account\'s BPB (registry → the account\'s own → the newest found) instead of a new Worker',
        /registry\.get\(regAcc, 'BPB'\)/.test(server) && /registry\.find\(regAcc, 'BPB', \{ prefer: registry\.scriptOf\(req\.body\.existingUrl\)/.test(server)
        && /scriptName = bpbReuse\.script;/.test(server));
    t('Edge\'s deploy reuses the account\'s Edge and keeps the UUID the account already holds for it',
        /registry\.find\(regAcc, 'EDG'/.test(server) && /req\.body\.existingUuid/.test(server) && /workerName = edgeReuse\.script;/.test(server));
    // Zeus's password block, cut out of the deploy route and run against a fake database.
    const zStart = server.indexOf('const zeusSha = (p) =>');
    const zEnd = server.indexOf("if (!zeusPwStored) zeusPassword = zeusKnown");
    const zeusPw = async ({ stored, registryPw = null, requestPw = null, dbCreated = false, d1Fails = false }) => {
        const crypto = require('crypto');
        const rows = { panel_password: stored };
        const registry = {
            get: async () => (registryPw ? { script: 'z1', s: { password: registryPw } } : null),
            d1Query: async (acc, db, sql, params) => {
                if (d1Fails) throw new Error('no D1');
                if (/^SELECT/.test(sql)) return rows.panel_password ? [{ value: rows.panel_password }] : [];
                if (/^INSERT OR REPLACE/.test(sql)) rows.panel_password = params[0];
                return [];
            },
        };
        const body = server.slice(zStart, server.indexOf('\n', zEnd));
        const fn = new Function('crypto', 'registry', 'regAcc', 'zeusScriptName', 'req', 'dbUuid', 'dbCreated', 'console',
            `return (async () => { ${body}\n return { zeusPassword, zeusPwStored }; })();`);
        const out = await fn(crypto, registry, {}, 'z1', { body: { zeusPassword: requestPw } }, 'db', dbCreated, { log() {} });
        return Object.assign(out, { hash: rows.panel_password });
    };
    const sha = (p) => require('crypto').createHash('sha256').update(String(p)).digest('hex');
    let z = await zeusPw({ stored: null });
    t('a Zeus panel with no password gets a random one written straight into its database (never left open)',
        z.zeusPwStored && z.zeusPassword && z.zeusPassword !== 'Admin123!' && z.hash === sha(z.zeusPassword), JSON.stringify(z));
    z = await zeusPw({ stored: sha('Admin123!') });
    t('…and one still on the old default gets its own',
        z.zeusPwStored && z.zeusPassword !== 'Admin123!' && z.hash === sha(z.zeusPassword), JSON.stringify(z));
    z = await zeusPw({ stored: sha('p-registry'), registryPw: 'p-registry' });
    t('…a redeploy keeps the password the registry holds for that panel',
        z.zeusPassword === 'p-registry' && z.hash === sha('p-registry'), JSON.stringify(z));
    z = await zeusPw({ stored: sha('p-account'), requestPw: 'p-account' });
    t('…or the one the account record holds', z.zeusPassword === 'p-account' && z.hash === sha('p-account'), JSON.stringify(z));
    z = await zeusPw({ stored: sha('the-users-own') });
    t('…and a password the user set inside the panel is left alone (not claimed as known)',
        !z.zeusPwStored && z.zeusPassword === null && z.hash === sha('the-users-own'), JSON.stringify(z));
    z = await zeusPw({ stored: null, d1Fails: true, dbCreated: true });
    t('…with no database access, a database made just now gets a random one through the panel\'s first-run setup',
        !z.zeusPwStored && z.zeusPassword && z.zeusPassword !== 'Admin123!'
        && /if \(!zeusPwStored\) setTimeout\(async \(\) => \{/.test(server) && /JSON\.stringify\(\{ password: zeusPassword \|\| 'Admin123!' \}\)/.test(server), JSON.stringify(z));
    t('the password goes to the registry and back to the window',
        /s: zeusPassword \? \{ password: zeusPassword \} : \{\}/.test(server) && /zeusPassword: zeusPassword \|\| undefined \}\);/.test(server));
    t('a panel still on the old default can be given its own from the Zeus settings window (database first), and the registry records it',
        /app\.post\('\/api\/cloudflare\/zeus\/rotate-password'/.test(server) && /registry\.d1Of\(await registry\.bindings\(regAcc, script\), 'DB'\)/.test(server)
        && /\/api\/change-password/.test(server) && /s: \{ password: next \}/.test(server));
    const arenaSrc = fs.readFileSync(path.join(ROOT, 'arena.js'), 'utf8');
    t('the arena tries the account\'s Zeus password, then the registry\'s, then the old default',
        /const known = \[acc\.zeusPassword\];/.test(arenaSrc) && /known\.push\(g\.s\.password\)/.test(arenaSrc) && /known\.push\('Admin123!'\);/.test(arenaSrc));
    const kt = (rel) => fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/mlmvpn/scanner', rel), 'utf8');
    t('Android: Netra, Gozargah, Nova and Spider read the registry before installing and publish after',
        ['engines/netra/NetraPanel.kt', 'engines/gozargah/GozargahPanel.kt', 'engines/nova/NovaPanel.kt', 'engines/spider/SpiderPanel.kt']
            .every((f) => /PanelRegistry\.live\(account, CODE\)/.test(kt(f)) && /publish\(account, (it|inst)\)/.test(kt(f))));
    t('Android: BPB, Edge, Nahan and legacy MLM do the same on the account record',
        /PanelRegistry\.live\(account, "BPB"\)/.test(kt('data/CloudManager.kt')) && /PanelRegistry\.live\(account, "EDG"\)/.test(kt('data/CloudManager.kt'))
        && /PanelRegistry\.live\(account, "NHN"\)/.test(kt('engines/nahan/NahanDeployer.kt')) && /PanelRegistry\.live\(account, "MLM"\)/.test(kt('engines/mlm/MlmDeployer.kt')));
    t('Android: a redeploy of the same BPB keeps its UUID (configs keep working) instead of a new one each time',
        /val workerUuid = account\.uuid\?\.takeIf \{ keep && it\.isNotBlank\(\) \}/.test(kt('data/CloudManager.kt')));
    t('Android: the Cloud tab syncs every account with the registry once per session',
        /PanelSync\.syncOnce\(context, acc\)/.test(kt('ui/CloudTab.kt')));

    let failed = 0;
    for (const r2 of results) {
        console.log(`${r2.pass ? 'PASS' : 'FAIL'}  ${r2.name}`);
        if (!r2.pass) { failed++; if (r2.detail) console.log('      ' + r2.detail); }
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* temp */ }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
