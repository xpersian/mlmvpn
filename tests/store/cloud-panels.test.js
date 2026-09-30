// «ام‌ال‌ام استور» — the Cloud window's nine panels as products of their own (2026-10-01).
//
// The user asked: every worker in the Cloud panel must be updatable from the store straight from its
// developer's GitHub, and every one of them must be IN the store — with a description and a
// developer section — whether or not it is deployed yet. Until then a panel appeared only as a copy
// found by an account survey, so a user who had not deployed Nova, or never pressed «بررسی حساب‌ها»,
// saw no Nova in the store at all.
//
// And a survey is a snapshot: when the developer publishes again, a copy the survey called «بروز»
// is not any more. store-manager.js › reassess judges the cached row again against the developer's
// code as known now — only ever towards «update», because the update itself re-reads the Worker.

const fs = require('fs');
const path = require('path');

const catalog = require('../../store/catalog');
const live = require('../../store/worker-live');
const store = require('../../store-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── the nine, and where each one's code comes from ───────────────────────────────────────────
const CODES = ['BPB', 'EDG', 'ZEU', 'SPD', 'NTR', 'GZG', 'NVA', 'NHN', 'MLM'];
t('the store knows all nine panels of the Cloud window, in its order',
    catalog.CLOUD_PANELS.map((x) => x && x.panel).join(',') === CODES.join(','),
    catalog.CLOUD_PANELS.map((x) => x && x.panel).join(','));
for (const item of catalog.CLOUD_PANELS) {
    const src = live.SOURCES[item.id];
    t(item.id + ': updated by this app, not left to the phone', item.managedBy === 'windows');
    t(item.id + ': its code is read from the developer\'s GitHub', !!src && !!src.repo);
    t(item.id + ': …the same repository the store names as its developer', !!src && src.repo === item.upstream.repo,
        (src && src.repo) + ' vs ' + item.upstream.repo);
}

// ── every one has a page: description, developer, picture ──────────────────────────────────
const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'components', 'store.js'), 'utf8');
for (const item of catalog.CLOUD_PANELS) {
    const at = ui.search(new RegExp('\\n        ' + item.id + ": \\{ img: '"));
    // The entry runs to the next entry at the same depth, or to the end of the table.
    const rest = at < 0 ? '' : ui.slice(at + 1);
    const end = rest.search(/\n {8}[a-z'-]+: \{|\n {4}\}\);/);
    const block = end < 0 ? rest : rest.slice(0, end);
    t(item.id + ': has a store page of its own', at >= 0);
    t(item.id + ': …with the developer\'s account of it or ours', /about: \[/.test(block) && /inApp: \[/.test(block));
    t(item.id + ': …and a developer section with links', /devBox: \{/.test(block) && /links: \[/.test(block));
    const logo = (block.match(/logo: '([^']+)'/) || [])[1];
    t(item.id + ': …whose picture ships with the app', !!logo && fs.existsSync(path.join(__dirname, '..', '..', 'public', logo)), logo);
}
t('a panel\'s update is not counted twice (the panel AND its copy)',
    /const pending = \(\) => data\.rows\.filter\(r => r\.kind !== 'panel'/.test(ui));

// ── the product row ─────────────────────────────────────────────────────────────────────────
const realMeta = live.meta;
const realPeek = live.peek;
live.meta = (id) => ({ version: id === 'zeus' ? '2.2.5' : 'v9', ref: 'abc123', repo: live.SOURCES[id].repo, sha256: 'NEW', at: 1, from: 'upstream' });
live.peek = (id) => (id === 'zeus' ? { code: 'x', version: '2.2.5', repo: 'panel-zeus/Z-E-U-S', ref: 'abc123', sha256: 'NEW' } : null);

const row = (id, extra) => Object.assign({ id, kind: 'worker', managedBy: 'windows', state: 'current', updatable: false, script: 's-' + id }, extra);
const byId = (rows, id) => rows.find((r) => r.id === id);

let rows = store.panelRows([], 0, {});
t('nine product rows', rows.length === 9 && rows.every((r) => r.kind === 'panel' && r.group === 'panels'));
t('never surveyed: «not checked», not «not installed»', byId(rows, 'nova').state === 'unchecked');
t('each row says what the developer has published', byId(rows, 'zeus').latest.version === '2.2.5');
t('…and where exactly it is read from', byId(rows, 'bpb').source.type === 'release' && byId(rows, 'bpb').source.asset === 'worker.js'
    && byId(rows, 'edge').source.type === 'file' && byId(rows, 'edge').source.path === '_worker.js');
t('Nova\'s own SHA-256 check is visible on its page', byId(rows, 'nova').source.signed === true);

rows = store.panelRows([row('bpb'), row('bpb', { state: 'update', updatable: true }), row('edge')], Date.now(), {});
t('surveyed and absent: «not installed»', byId(rows, 'nova').state === 'absent' && byId(rows, 'nova').copies === 0);
t('one copy behind: the panel has an update', byId(rows, 'bpb').state === 'update' && byId(rows, 'bpb').copies === 2 && byId(rows, 'bpb').behind === 1);
t('every copy current: the panel is current', byId(rows, 'edge').state === 'current');

// The Cloud window installed Nova after the last survey: the store must not call it «not installed».
const installs = { NVA: [{ accId: 'a1', script: 'auto-scale-nva' }], EDG: [{ accId: 'a1', script: 's-edge' }] };
rows = store.panelRows([row('edge', { accountId: 'a1' })], Date.now(), installs);
t('installed by the Cloud window after the survey: «installed, not checked», never «not installed»',
    byId(rows, 'nova').state === 'unchecked' && byId(rows, 'nova').unsurveyed.join() === 'auto-scale-nva');
t('…and a copy the survey did read is not counted twice', byId(rows, 'edge').state === 'current' && byId(rows, 'edge').unsurveyed.length === 0);

// ── a survey row judged again against what the developer published since ─────────────────────
let r = store.reassess(row('netra', { compareBy: 'bytes', liveSha: 'OLD', notes: '' }));
t('the developer published since the survey: the copy is behind now', r.state === 'update' && r.updatable === true && r.targetVersion === 'v9');
r = store.reassess(row('netra', { liveSha: 'NEW' }));
t('compared against this very code: still current', r.state === 'current' && !r.updatable);
r = store.reassess(row('netra', { state: 'unknown', liveSha: null }));
t('never compared: stays «unknown» — no evidence either way', r.state === 'unknown');
r = store.reassess(row('zeus', { deployedVersion: '2.2.0' }));
t('a versioned panel behind the developer\'s newest: update', r.state === 'update' && r.updatable && String(r.targetVersion) === '2.2.5');
r = store.reassess(row('zeus', { deployedVersion: '2.2.5' }));
t('a versioned panel on the developer\'s newest: current', r.state === 'current');
r = store.reassess(row('mlm-panel', { managedBy: 'android', state: 'external' }));
t('the phone\'s own panels are left alone', r.state === 'external');
r = store.reassess(row('bpb', { deployedVersion: '4.1.3', state: 'current' }));
t('a BPB too old to update in place is not offered an update', r.state === 'current' && !r.updatable);

// GitHub asked, and what it gave did not pass the check (MLM's path now holds a Config Studio build):
// no version appears out of nothing, and nothing turns into an update.
live.meta = (id) => ({ version: null, ref: '', repo: '', sha256: '', at: 0, from: '', triedAt: 5, error: 'کد دریافتی شبیه «پنل MLM» نیست — نصب نشد' });
rows = store.panelRows([], Date.now(), {});
t('a failed read shows no version, and says why', byId(rows, 'mlm').latest === null && byId(rows, 'mlm').target === null
    && /شبیه/.test(byId(rows, 'mlm').asked.error));
r = store.reassess(row('mlm', { compareBy: 'bytes', liveSha: 'OLD' }));
t('…and does not mark a current copy as behind', r.state === 'current' && !r.updatable);

live.meta = realMeta;
live.peek = realPeek;

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
