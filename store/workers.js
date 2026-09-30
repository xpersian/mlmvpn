// --- «ام‌ال‌ام استور» — updating the panels the user deployed to THEIR OWN Cloudflare account ---
//
// A worker is not a file on this machine. It is code the user (or the Android app) put on their own
// Cloudflare account, and the store touches it only over the Cloudflare API, which — unlike the
// panels' own workers.dev hosts — is NOT filtered in Iran, so this needs no tunnel.
//
// Two rules run through everything here:
//
//   RECOGNISE, DON'T GUESS. Worker script names are randomised at deploy time, so a name proves
//   nothing. Every worker is identified by a fingerprint IN ITS CODE (store/catalog.js › detect).
//   An account also holds the user's own unrelated workers, and for the maintainer the project's
//   whole backend; none of them match any fingerprint, so none of them is ever offered an update or
//   counted as out of date. What is not positively recognised is left completely alone.
//
//   UPDATE THE CODE, NOTHING ELSE. Cloudflare's script-content endpoint (PUT .../content) replaces
//   the module and keeps every binding, secret, migration, route and compatibility flag as it was.
//   BPB's install values are compiled into a prefix of its own script; that prefix is carried across
//   verbatim, so the panel's settings, UUID and paths survive. The KV data and the D1 database are
//   never read, moved or rewritten.
//
// The store manages only the Windows-deployed workers. The ones the Android app deploys are shown
// so the account's picture is whole, but their «managedBy: 'android'» marks them read-only here:
// the phone tracks their build numbers, D1 migrations and bootstrap secrets, and going backwards on
// them would corrupt user data (Config Studio refuses a downgrade on purpose).

'use strict';

const fs = require('fs');
const path = require('path');

const axios = require('axios');
const { WORKERS, BY_ID, appFile } = require('./catalog');
const versions = require('./versions');
const trust = require('./trust');

const API = 'https://api.cloudflare.com/client/v4';

function headersFor(acc) {
    const token = String((acc && acc.token) || '').trim();
    const email = String((acc && acc.email) || '').trim();
    if (!token) throw new Error('توکن این حساب ذخیره نشده است.');
    // Global API Key + email OR a bearer token. The prefix is not a reliable signal on this project's
    // own keys (one in use starts cfk_), so email presence decides, exactly as cf-resources.js does.
    if (token.startsWith('cfat_') || !email) return { Authorization: 'Bearer ' + token };
    return { 'X-Auth-Email': email, 'X-Auth-Key': token };
}

function cfError(e) {
    const d = e && e.response && e.response.data;
    const m = d && d.errors && d.errors[0];
    return (m && m.message) || (e && e.message) || 'خطای ناشناخته';
}

async function accountId(acc) {
    if (acc && acc._accountId) return acc._accountId;
    const r = await axios.get(API + '/accounts', { headers: headersFor(acc), timeout: 15000 });
    const a = r.data && r.data.result && r.data.result[0];
    if (!a) throw new Error('اکانتی روی این حساب یافت نشد.');
    return a.id;
}

// ── reading deployed code ──────────────────────────────────────────────────────

/**
 * The module body of a worker script. `/content/v2` answers multipart; the module we uploaded is
 * the part whose name is the main module. Returns { name, body } or null.
 */
async function fetchScript(acc, id, name) {
    const res = await axios.get(API + '/accounts/' + id + '/workers/scripts/' + encodeURIComponent(name) + '/content/v2', {
        headers: headersFor(acc), timeout: 30000, responseType: 'arraybuffer',
        transformResponse: [(d) => d], validateStatus: () => true,
    });
    if (res.status !== 200) throw new Error('کد ورکر خوانده نشد (وضعیت ' + res.status + ')');
    const ct = String(res.headers['content-type'] || '');
    const buf = Buffer.from(res.data);
    const boundary = (ct.match(/boundary=([^;]+)/) || [])[1];
    if (!boundary) return { name: 'worker.js', body: buf.toString('utf8') };
    const raw = buf.toString('latin1');
    let main = null, first = null;
    for (const seg of raw.split('--' + boundary)) {
        const i = seg.indexOf('\r\n\r\n');
        if (i < 0) continue;
        const head = seg.slice(0, i);
        const nm = (head.match(/name="([^"]+)"/) || [])[1];
        if (!nm) continue;
        let body = seg.slice(i + 4);
        if (body.endsWith('\r\n')) body = body.slice(0, -2);
        const part = { name: nm, body: Buffer.from(body, 'latin1').toString('utf8') };
        if (!first) first = part;
        if (/\.(js|mjs)$/i.test(nm)) { main = part; break; }
    }
    return main || first;
}

/** Classify one deployed script against the catalogue. Returns the matching item + version, or null. */
function classify(body) {
    for (const item of WORKERS) {
        let ok = false;
        try { ok = item.detect(body); } catch (e) { ok = false; }
        if (!ok) continue;
        let version = null;
        try { version = item.versionOf ? item.versionOf(body) : null; } catch (e) { version = null; }
        // A worker whose code lacks a version line but whose bytes match a build we shipped.
        if (version == null && item.knownHashes) {
            const h = require('crypto').createHash('sha256').update(body, 'utf8').digest('hex');
            if (item.knownHashes[h] !== undefined) version = item.knownHashes[h];
        }
        if (version == null && item.legacyVersion !== undefined) version = item.legacyVersion;
        return { item, version };
    }
    return null;
}

// ── the shipped/target version of a worker ──────────────────────────────────────

const bundledCache = new Map();

/** The worker source this build ships, read once. */
function bundledSource(item) {
    if (!item.bundled) return null;
    if (bundledCache.has(item.id)) return bundledCache.get(item.id);
    let text = null;
    try { text = fs.readFileSync(appFile(item.bundled.file), 'utf8'); } catch (e) { text = null; }
    bundledCache.set(item.id, text);
    return text;
}

/**
 * version + how to get the code the store would deploy for `item`: the developer's NEWEST published
 * code when it has been read (store/worker-live.js) and is newer, else the pinned channel, else the
 * bundle. Users asked for exactly this (2026-09-29): every panel always the developer's latest.
 */
function target(item) {
    let base = null;
    if (item.pin && item.pin.version) {
        base = { version: item.pin.version, notes: item.pin.notes || '', from: 'pin', artifact: item.pin.artifacts && item.pin.artifacts[0] };
    } else if (item.bundled) base = { version: item.bundled.version, notes: '', from: 'bundle' };
    let live = null;
    try { live = require('./worker-live').peek(item.id); } catch (e) { live = null; }
    if (live && live.code && live.version) {
        const c = base ? versions.compare(live.version, base.version) : 1;
        // At the SAME number the developer's copy wins too: an update installs what their GitHub
        // publishes, not the copy this build happens to carry (2026-10-01).
        if (!base || c === null || c >= 0) {
            return { version: live.version, notes: 'آخرین نسخهٔ منتشرشدهٔ سازنده (' + live.repo + ' @ ' + live.ref + ')', from: 'live' };
        }
    }
    return base;
}

// ── panels compared BY BYTES (catalog › compareBy: 'bytes') ─────────────────────

const SPIDER_NAMES = ['PANEL_TOKEN', 'PANEL_DOMAIN', 'WORKER_DOMAIN'];
/** The raw JS literals a deployed Spider carries for its three injected constants, or null. */
function spiderValues(text) {
    const out = {};
    for (const n of SPIDER_NAMES) {
        const m = new RegExp('const\\s+' + n + '\\s*=\\s*([^;\\n]+);').exec(text);
        if (!m || m[1].trim().startsWith('"__')) return null;
        out[n] = m[1].trim();
    }
    return out;
}
/** The code as the developer published it: BOM off, Spider's injected values back as placeholders. */
function normalizeFor(item, text) {
    let t = String(text || '');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    if (item.transform === 'spider-injected') {
        const v = spiderValues(t);
        if (v) for (const n of SPIDER_NAMES) t = t.split(v[n]).join(`__${n}__`);
    }
    return t.replace(/\s+$/, '');
}
const sha = (t) => require('crypto').createHash('sha256').update(t, 'utf8').digest('hex');
/** For a bytes-compared panel: { same, live } against the developer's newest code, or null. */
function bytesState(item, deployedBody) {
    let live = null;
    try { live = require('./worker-live').peek(item.id); } catch (e) { live = null; }
    if (!live || !live.code) return null;
    return { same: sha(normalizeFor(item, deployedBody)) === sha(normalizeFor(item, live.code)), live };
}

/** Read every Windows-managed panel's newest upstream code once, before a survey compares. */
async function refreshLive() {
    let live;
    try { live = require('./worker-live'); } catch (e) { return; }
    const ids = WORKERS.filter((w) => w.managedBy === 'windows' && live.SOURCES[w.id]).map((w) => w.id);
    await Promise.all(ids.map((id) => live.latest(id).catch(() => null)));
}

/** -1/0/1/null comparing a deployed worker version to the store's target for it. */
function compareToTarget(item, deployed) {
    const t = target(item);
    if (!t) return null;
    if (typeof deployed === 'number' || typeof t.version === 'number') {
        const a = Number(deployed), b = Number(t.version);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        return a < b ? -1 : a > b ? 1 : 0;
    }
    return versions.compare(deployed, t.version);
}

// ── survey ──────────────────────────────────────────────────────────────────────

/**
 * Every recognised MLM worker on one account, with what it is and whether the store can update it.
 * Unrecognised scripts are omitted entirely — they are the user's own, and not the store's business.
 */
async function survey(acc, { onProgress } = {}) {
    await refreshLive();
    const id = await accountId(acc);
    const scoped = Object.assign({}, acc, { _accountId: id });
    const list = (await axios.get(API + '/accounts/' + id + '/workers/scripts', { headers: headersFor(acc), timeout: 20000 })).data;
    const scripts = (list && list.result) || [];
    let sub = '';
    try {
        const s = await axios.get(API + '/accounts/' + id + '/workers/subdomain', { headers: headersFor(acc), timeout: 8000 });
        sub = (s.data && s.data.result && (s.data.result.subdomain || s.data.result.name)) || '';
    } catch (e) { /* no subdomain */ }

    const out = [];
    for (let i = 0; i < scripts.length; i++) {
        const name = scripts[i].id;
        if (onProgress) onProgress(i + 1, scripts.length, name);
        let body;
        try { body = await fetchScript(scoped, id, name); } catch (e) { continue; }
        if (!body) continue;
        const hit = classify(body.body);
        if (!hit) continue;   // the user's own worker — invisible to the store, on purpose
        if (hit.item.compareBy === 'bytes') {
            const b = bytesState(hit.item, body.body);
            out.push({
                id: hit.item.id, title: hit.item.title, script: name, mainModule: body.name,
                managedBy: hit.item.managedBy, modifiedOn: scripts[i].modified_on || '',
                deployedVersion: hit.version, targetVersion: b ? b.live.version : null,
                url: sub ? 'https://' + name + '.' + sub + '.workers.dev' : '',
                state: !b ? 'unknown' : b.same ? 'current' : 'update',
                updatable: !!(b && !b.same),
                notes: b ? 'آخرین کد منتشرشدهٔ سازنده (' + b.live.repo + ' @ ' + b.live.ref + ')' : '',
                // WHICH developer code this comparison was made against. When the developer publishes
                // again, the store sees a different digest and knows «current» is stale without
                // reading every Worker on the account again (store-manager.js › reassess).
                liveSha: b ? (b.live.sha256 || sha(b.live.code)) : null,
            });
            continue;
        }
        const t = target(hit.item);
        const cmp = hit.item.managedBy === 'windows' ? compareToTarget(hit.item, hit.version) : null;
        out.push({
            id: hit.item.id, title: hit.item.title, script: name, mainModule: body.name,
            managedBy: hit.item.managedBy,
            modifiedOn: scripts[i].modified_on || '',
            deployedVersion: hit.version,
            targetVersion: t ? t.version : null,
            url: sub ? 'https://' + name + '.' + sub + '.workers.dev' : '',
            state: hit.item.managedBy !== 'windows' ? 'external'
                : cmp === null ? 'unknown'
                    : cmp < 0 ? 'update'
                        : 'current',
            updatable: hit.item.managedBy === 'windows' && cmp !== null && cmp < 0
                && withinFloor(hit.item, hit.version),
            notes: t ? t.notes : '',
        });
    }
    return { accountId: id, subdomain: sub, workers: out };
}

/** A worker too old to update in place (a different protocol/secret shape) is a fresh deploy, not this. */
function withinFloor(item, deployed) {
    if (!item.minUpdatable) return true;
    const c = versions.compare(deployed, item.minUpdatable);
    return c === null ? true : c >= 0;
}

// ── the code to upload ──────────────────────────────────────────────────────────

function stripBomIf(item, text) {
    return item.stripBom && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const BPB_MARKER = 'Object.assign(globalThis,';

/**
 * Everything BPB's deploy puts in front of the panel source, including the trailing `;`.
 *
 * It is one statement — `Object.assign(globalThis, { … });` — but where it sits and what follows it
 * differ by who wrote it. This app writes it at offset 0 with a newline after; the panel, when it
 * redeploys ITSELF, writes three comment lines, some generated filler, then the statement with the
 * source glued straight on. So the end is found by balancing the braces of the JSON argument rather
 * than by looking for a line break that is not always there.
 *
 * The argument is JSON produced by JSON.stringify, so braces inside strings are the only trap, and
 * the scanner accounts for them. Returns null when the shape is not what v5 produces — and the
 * caller then refuses to touch the panel at all.
 */
function bpbPrefix(text) {
    const at = text.indexOf(BPB_MARKER);
    if (at < 0) return null;
    const open = text.indexOf('{', at + BPB_MARKER.length);
    if (open < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;
    // `});` — whatever whitespace the writer used between them.
    const tail = text.slice(end + 1, end + 8);
    const close = tail.match(/^\s*\)\s*;/);
    if (!close) return null;
    const prefix = text.slice(0, end + 1 + close[0].length);
    // It must really be the panel's settings and not some other assignment.
    try {
        const obj = JSON.parse(text.slice(open, end + 1));
        if (!obj || typeof obj.EMBEDED_SETTINGS !== 'object' || !obj.EMBEDED_SETTINGS) return null;
    } catch (e) { return null; }
    return prefix;
}

/** The bare panel source: what is left when a prefix like the above is taken off the front. */
function stripBpbPrefix(text) {
    const prefix = bpbPrefix(text);
    if (!prefix) return text;
    return text.slice(prefix.length).replace(/^\r?\n/, '');
}

/**
 * The exact bytes to deploy for `item`, verified. Either the pinned artifact (downloaded through
 * store/net and checked against its digest) or the source this build ships. BPB's compiled settings
 * prefix is carried over from `deployedBody` so the panel keeps its own configuration.
 */
async function codeFor(item, deployedBody) {
    const t = target(item);
    if (!t) throw new Error('برای این ورکر نسخه‌ای تعریف نشده است.');
    let code;
    if (t.from === 'live') {
        const live = require('./worker-live').peek(item.id);
        if (!live || !live.code) throw new Error('کد تازهٔ سازنده دیگر در دسترس نیست — دوباره تلاش کنید.');
        code = live.code;
    } else if (t.from === 'pin') {
        const a = t.artifact;
        if (!a || !trust.isSha256(a.sha256)) throw new Error('نسخهٔ پین‌شدهٔ این ورکر هش معتبر ندارد.');
        const netio = require('./net');
        const os = require('os');
        const dest = path.join(os.homedir(), '.mlmvpn', 'store', 'workers', a.sha256);
        const got = await netio.download({ urls: a.urls, sha256: a.sha256, size: a.size || 0, dest });
        code = fs.readFileSync(got.file, 'utf8');
    } else {
        code = bundledSource(item);
        if (code == null) throw new Error('کد همراهِ این ورکر در این نسخهٔ برنامه پیدا نشد.');
    }
    code = stripBomIf(item, code);

    if (item.transform === 'bpb-embedded-settings') {
        // v5 compiles its install values into a statement AHEAD of the worker source. Carry the
        // deployed panel's exact prefix across, or the new copy has no account id, no UUID, no
        // secure path — the v5 panel refuses to start without them, and its users lose the panel.
        const prefix = bpbPrefix(String(deployedBody || ''));
        if (!prefix) throw new Error('تنظیمات جاسازی‌شدهٔ پنل خوانده نشد — این پنل از استور بروزرسانی نمی‌شود.');
        // The shipped file is the bare panel source; the prefix is what the deploy adds to it.
        code = prefix + '\n' + stripBpbPrefix(code);
    }
    return code;
}

/**
 * Upload code to an existing worker WITHOUT touching its bindings, secrets or settings.
 * Cloudflare's content-only endpoint keeps everything else exactly as deployed.
 */
async function putContent(acc, id, name, mainModule, code) {
    const boundary = '----mlmstore' + require('crypto').randomBytes(8).toString('hex');
    const parts = [
        '--' + boundary,
        'Content-Disposition: form-data; name="metadata"',
        'Content-Type: application/json', '',
        JSON.stringify({ main_module: mainModule }),
        '--' + boundary,
        'Content-Disposition: form-data; name="' + mainModule + '"; filename="' + mainModule + '"',
        'Content-Type: application/javascript+module', '',
        code,
        '--' + boundary + '--', '',
    ].join('\r\n');
    const res = await axios.put(
        API + '/accounts/' + id + '/workers/scripts/' + encodeURIComponent(name) + '/content',
        parts,
        { headers: Object.assign(headersFor(acc), { 'Content-Type': 'multipart/form-data; boundary=' + boundary }),
          timeout: 60000, validateStatus: () => true });
    if (res.status < 200 || res.status >= 300 || (res.data && res.data.success === false)) {
        throw new Error('آپلود کد ورکر رد شد: ' + cfError({ response: res }));
    }
    return true;
}

// ── backups ─────────────────────────────────────────────────────────────────────
//
// The code that was live before an update, kept on this machine so going back is a button rather
// than a redeploy. It lives beside the app's own state (~/.mlmvpn), because for BPB it contains the
// panel's compiled settings — the same account token that is already in user_data.json, and no
// further than it.

const os = require('os');
const BACKUP_DIR = path.join(os.homedir(), '.mlmvpn', 'store', 'worker-backups');

function backupDir(accId, script) {
    return path.join(BACKUP_DIR, String(accId).replace(/[^\w.-]/g, '_'), String(script).replace(/[^\w.-]/g, '_'));
}

function saveBackup(accId, script, part, meta) {
    const dir = backupDir(accId, script);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, stamp + '.js'), part.body, 'utf8');
    fs.writeFileSync(path.join(dir, stamp + '.json'), JSON.stringify(Object.assign({ module: part.name, at: Date.now() }, meta), null, 2));
    // Three is enough to undo a bad run; more is just the panel's source code piling up.
    const keep = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().reverse().slice(3);
    for (const old of keep) {
        try { fs.unlinkSync(path.join(dir, old)); fs.unlinkSync(path.join(dir, old.replace(/\.js$/, '.json'))); } catch (e) { }
    }
    return path.join(dir, stamp + '.js');
}

function backups(accId, script) {
    let files = [];
    try { files = fs.readdirSync(backupDir(accId, script)).filter((f) => f.endsWith('.js')).sort().reverse(); } catch (e) { return []; }
    return files.map((f) => {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(backupDir(accId, script), f.replace(/\.js$/, '.json')), 'utf8')); } catch (e) { }
        return { file: path.join(backupDir(accId, script), f), at: meta.at || 0, version: meta.version || null, module: meta.module || 'worker.js' };
    });
}

/** Put the most recent backup of this worker's code back on Cloudflare. */
async function rollback(acc, scriptName) {
    const list = backups(acc.id, scriptName);
    if (!list.length) throw new Error('نسخهٔ پشتیبانی از کد این ورکر ذخیره نشده است.');
    const id = await accountId(acc);
    const code = fs.readFileSync(list[0].file, 'utf8');
    await putContent(Object.assign({}, acc, { _accountId: id }), id, scriptName, list[0].module, code);
    return { script: scriptName, restored: list[0].version, at: list[0].at };
}

/**
 * Update one recognised worker in place. Reads it, refuses anything not recognised or not the store's
 * to manage, verifies the target version really is newer, and replaces only the code.
 */
async function update(acc, scriptName, { expectId } = {}) {
    await refreshLive();
    const id = await accountId(acc);
    const scoped = Object.assign({}, acc, { _accountId: id });
    const body = await fetchScript(scoped, id, scriptName);
    if (!body) throw new Error('کد این ورکر خوانده نشد.');
    const hit = classify(body.body);
    if (!hit) throw new Error('این ورکر شناخته نشد؛ برای امنیت، ورکری که استور نشناسد را دست نمی‌زند.');
    if (expectId && hit.item.id !== expectId) {
        throw new Error('این ورکر «' + hit.item.title + '» است، نه چیزی که انتظار می‌رفت — بروزرسانی نشد.');
    }
    if (hit.item.managedBy !== 'windows') {
        throw new Error('«' + hit.item.title + '» را برنامهٔ اندروید مستقر کرده و از همان‌جا بروزرسانی می‌شود.');
    }
    if (hit.item.compareBy === 'bytes') {
        const b = bytesState(hit.item, body.body);
        if (!b) throw new Error('کد تازهٔ سازنده خوانده نشد — اینترنت را بررسی کنید و دوباره امتحان کنید.');
        if (b.same) throw new Error('همین حالا آخرین کد سازنده روی آن است.');
        let code = b.live.code.charCodeAt(0) === 0xfeff ? b.live.code.slice(1) : b.live.code;
        if (hit.item.transform === 'spider-injected') {
            const v = spiderValues(body.body);
            if (!v) throw new Error('توکن و دامنه‌های نصب‌شدهٔ اسپایدر خوانده نشد — بروزرسانی نشد.');
            for (const n of SPIDER_NAMES) {
                if (!code.includes(`__${n}__`)) throw new Error(`کد تازهٔ اسپایدر دیگر جای «${n}» را ندارد — بروزرسانی نشد.`);
                code = code.split(`__${n}__`).join(v[n]);
            }
        }
        const backup = saveBackup(acc.id, scriptName, body, { version: hit.version, item: hit.item.id, to: b.live.version });
        await putContent(scoped, id, scriptName, body.name, code);
        return { id: hit.item.id, title: hit.item.title, from: hit.version, to: b.live.version, confirmed: null, script: scriptName, backup };
    }
    const cmp = compareToTarget(hit.item, hit.version);
    if (cmp === null) throw new Error('نسخهٔ این ورکر خوانده نشد.');
    if (cmp >= 0) throw new Error('همین حالا بروز است (نسخهٔ ' + hit.version + ').');
    if (!withinFloor(hit.item, hit.version)) {
        throw new Error('این نسخهٔ ورکر آن‌قدر قدیمی است که باید دوباره مستقر شود، نه بروزرسانی.');
    }
    const code = await codeFor(hit.item, body.body);
    const t = target(hit.item);
    // The live code goes to disk BEFORE anything is uploaded. Whatever happens next, the exact
    // bytes that were working a second ago can be put back.
    const backup = saveBackup(acc.id, scriptName, body, { version: hit.version, item: hit.item.id, to: t.version });
    await putContent(scoped, id, scriptName, body.name, code);

    // Read it back: an upload that returned 200 but landed as something else is the failure that
    // would otherwise be discovered by a user whose panel stopped working.
    let confirmed = null;
    try {
        const after = await fetchScript(scoped, id, scriptName);
        const check = after && classify(after.body);
        confirmed = check ? check.version : null;
        if (!check || compareToTarget(hit.item, check.version) !== 0) {
            await putContent(scoped, id, scriptName, body.name, body.body);
            throw new Error('کد تازه روی ورکر ننشست؛ همان نسخهٔ قبلی برگردانده شد.');
        }
    } catch (e) {
        if (/ننشست/.test(e.message)) throw e;
        // Reading it back failed (a timeout, a rate limit) — the upload itself was accepted, so the
        // update stands and the next survey will confirm it.
    }
    return { id: hit.item.id, title: hit.item.title, from: hit.version, to: t.version, confirmed, script: scriptName, backup };
}

module.exports = {
    bpbPrefix, stripBpbPrefix, backups, rollback, saveBackup, spiderValues, normalizeFor, bytesState,
    survey, update, classify, target, compareToTarget, withinFloor, fetchScript, codeFor,
    headersFor, accountId, bundledSource,
};
