// --- cloud-panels.js — Spider, Netra, Gozargah and Nova on the user's own Cloudflare account ---
//
// Android 1.2.36's four new Cloud panels (docs/ANDROID-1.2.36-TO-WINDOWS.fa.md › ۲), ported from
// engines/{spider,netra,gozargah,nova}/*Panel.kt and engines/cloud/CfWorkers.kt. Every one is
// deployed from its DEVELOPER'S newest published code (store/worker-live.js — fingerprint-checked,
// Nova also against the SHA-256 in its own version.json) and none is bundled in this app:
//
//   Spider   amirh00sain/SpiderPanel (no licence)   worker/worker.js on main; three constants the
//            developer's own panel injects (__PANEL_TOKEN__, __PANEL_DOMAIN__, __WORKER_DOMAIN__) are
//            filled in; KV bound as SPIDER_KV; this app is its panel (Bearer-token admin API).
//   Netra    netrair/netra-panel (MIT, a BPB fork)  release worker.js; KV bound as `kv`, secrets UUID,
//            TR_PASS, SUB_PATH (random — never the repo's public defaults), nodejs_compat. Configs at
//            /<SUB_PATH>/sub/raw?app=xray.
//   Gozargah panelgozargah/gozargah (MIT)            release gozargah-worker.js; D1 as GZ_DB, compat
//            2025-01-15. It starts on PUBLIC defaults (panel «gozargah», password «admin»), so the very
//            first thing done is login + settings to random values kept here. The arena user
//            `mlmvpn-arena` is made once; its subToken → /{subPath}/{token}?app=v2ray.
//   Nova     IRNova/Nova-Proxy (PolyForm NC, obfuscated) — NEVER bundled; D1 `DB`, KV `KV`,
//            nodejs_compat, compat 2026-07-30. A fresh Nova has no password and /install is public —
//            whoever sets one first owns it — so `POST /install/set` runs IMMEDIATELY after upload
//            (8 tries, 3 s apart). Configs: /admin/config.json → token = md5(md5(HOST+UUID)[7..27]) →
//            /sub?token=…&b64 (never /admin/sub-content: a Worker cannot fetch itself, error 1042).
//
// Requests to the panels' own *.workers.dev go through gtFetch (direct → the user's proxy → the
// app's own engine) and, underneath, the self-healing Worker route (worker-route.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const API = 'https://api.cloudflare.com/client/v4';
const STORE = path.join(os.homedir(), '.mlmvpn', 'cloud-panels.json');
const ARENA_USER = 'mlmvpn-arena';

const PANELS = {
    SPD: { id: 'spider', code: 'SPD', title: 'Spider', color: '#FF375F', letter: 'S', suffix: '-spd' },
    NTR: { id: 'netra', code: 'NTR', title: 'Netra', color: '#9B59F6', letter: 'Nt', suffix: '-ntr' },
    GZG: { id: 'gozargah', code: 'GZG', title: 'Gozargah', color: '#40C8E0', letter: 'G', suffix: '-gzg' },
    NVA: { id: 'nova', code: 'NVA', title: 'Nova', color: '#5E5CE6', letter: 'Nv', suffix: '-nva' },
    NHN: { id: 'nahan', code: 'NHN', title: 'Nahan', color: '#BF5AF2', letter: 'N', suffix: '-nhn' },
    MLM: { id: 'mlm', code: 'MLM', title: 'MLM', color: '#FF9F0A', letter: 'M', suffix: '-mlm' },
};

// ── accounts and the install records ─────────────────────────────────────────────

/** The Cloud window's account by id (cf_accounts in the app's stored state), or the one passed. */
function account(accId, fallback) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        const list = typeof d.cf_accounts === 'string' ? JSON.parse(d.cf_accounts) : (d.cf_accounts || []);
        const a = list.find((x) => x.id === accId);
        if (a) return a;
    } catch (e) { /* none stored */ }
    if (fallback && fallback.token) return Object.assign({ id: accId || 'ad-hoc' }, fallback);
    throw new Error('این حساب کلادفلر پیدا نشد.');
}

function headers(acc) {
    const token = String(acc.token || '').trim();
    const email = String(acc.email || '').trim();
    if (token.startsWith('cfat_') || !email) return { Authorization: 'Bearer ' + token };
    return { 'X-Auth-Email': email, 'X-Auth-Key': token };
}

function readStore() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return {}; } }
function writeStore(s) {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE + '.tmp', JSON.stringify(s, null, 1));
    fs.renameSync(STORE + '.tmp', STORE);
}
function install(code, accId) { return readStore()[code + ':' + accId] || null; }
function saveInstall(code, accId, rec) { const s = readStore(); s[code + ':' + accId] = Object.assign({}, rec, { at: Date.now() }); writeStore(s); return s[code + ':' + accId]; }
function forget(code, accId) { const s = readStore(); delete s[code + ':' + accId]; writeStore(s); }

/** What is installed on this account, for the Cloud window — never tokens or passwords. */
function status(accId) {
    const out = {};
    for (const p of Object.values(PANELS)) {
        const i = install(p.code, accId);
        out[p.code] = i ? { installed: true, url: i.url, script: i.script, at: i.at, fetchedAt: i.fetchedAt || null, configs: i.configCount || 0 } : { installed: false };
    }
    return out;
}

// ── Cloudflare (Android CfWorkers.kt) ────────────────────────────────────────────

function cfMsg(e) {
    const d = e && e.response && e.response.data;
    const m = d && d.errors && d.errors[0];
    return (m && (m.code ? `(${m.code}) ` : '') + m.message) || (e && e.message) || 'خطای ناشناخته';
}

async function accountId(acc) {
    if (acc._accountId) return acc._accountId;
    const r = await axios.get(API + '/accounts', { headers: headers(acc), timeout: 15000 });
    const a = r.data && r.data.result && r.data.result[0];
    if (!a) throw new Error('اکانتی روی این حساب کلادفلر یافت نشد.');
    acc._accountId = a.id;
    return a.id;
}

async function subdomain(acc) {
    const id = await accountId(acc);
    const r = await axios.get(`${API}/accounts/${id}/workers/subdomain`, { headers: headers(acc), timeout: 15000, validateStatus: () => true });
    const sub = r.data && r.data.result && (r.data.result.subdomain || r.data.result.name);
    if (!sub) throw new Error('این حساب هنوز زیردامنهٔ workers.dev ندارد — یک‌بار BPB یا Edge را مستقر کنید تا ساخته شود.');
    return sub;
}

async function createOrFind(acc, kind, name) {
    const id = await accountId(acc);
    const url = kind === 'kv' ? `${API}/accounts/${id}/storage/kv/namespaces` : `${API}/accounts/${id}/d1/database`;
    const body = kind === 'kv' ? { title: name } : { name };
    const idField = kind === 'kv' ? 'id' : 'uuid';
    const key = kind === 'kv' ? 'title' : 'name';
    const r = await axios.post(url, body, { headers: headers(acc), timeout: 30000, validateStatus: () => true });
    const made = r.data && r.data.result && r.data.result[idField];
    if (r.status < 300 && made) return made;
    // Made by an earlier, interrupted deploy: find it by name rather than fail.
    const l = await axios.get(url + '?per_page=100', { headers: headers(acc), timeout: 30000, validateStatus: () => true });
    const found = ((l.data && l.data.result) || []).find((x) => x[key] === name);
    if (found) return found[idField];
    const m = r.data && r.data.errors && r.data.errors[0];
    if (kind === 'd1' && m && /terms/i.test(m.message)) throw new Error('اول در داشبورد کلادفلر بخش D1 را یک‌بار باز کنید و قوانین را بپذیرید.');
    // The free plan's ten databases, all taken (Nahan, MLM, Gozargah and Nova each need one; a
    // phone that raced on the same account has its own). Say which ones exist, as Android does.
    if (kind === 'd1' && m && /system limit|databases per account|limit reached/i.test(m.message)) {
        const names = ((l.data && l.data.result) || []).map((x) => x.name);
        throw new Error(`سقف ${names.length || 10} دیتابیس D1 این حساب کلادفلر پر است و دیتابیس تازه ساخته نمی‌شود. `
            + `یکی را که لازم ندارید در dash.cloudflare.com › Workers & Pages › D1 پاک کنید و دوباره نصب کنید. دیتابیس‌های موجود: ${names.join('، ')}`);
    }
    throw new Error(`ساخت ${kind === 'kv' ? 'فضای KV' : 'دیتابیس D1'} نشد: ${m ? m.message : 'HTTP ' + r.status}`);
}

async function upload(acc, script, code, { bindings = [], flags = [], compat = '2024-09-23' } = {}) {
    const id = await accountId(acc);
    const meta = { main_module: 'worker.js', compatibility_date: compat, bindings };
    if (flags.length) meta.compatibility_flags = flags;
    const boundary = '----mlmpanel' + crypto.randomBytes(8).toString('hex');
    const body = [
        '--' + boundary, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(meta),
        '--' + boundary, 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"', 'Content-Type: application/javascript+module', '', code,
        '--' + boundary + '--', '',
    ].join('\r\n');
    try {
        await axios.put(`${API}/accounts/${id}/workers/scripts/${script}`, body,
            { headers: Object.assign(headers(acc), { 'Content-Type': 'multipart/form-data; boundary=' + boundary }), timeout: 120000, maxBodyLength: Infinity });
    } catch (e) { throw new Error('بارگذاری ورکر رد شد: ' + cfMsg(e)); }
}

async function enableWorkersDev(acc, script) {
    const id = await accountId(acc);
    try { await axios.post(`${API}/accounts/${id}/workers/scripts/${script}/subdomain`, { enabled: true }, { headers: headers(acc), timeout: 30000 }); }
    catch (e) { throw new Error('فعال کردن آدرس ورکر نشد: ' + cfMsg(e)); }
}

async function removeWorker(acc, script, { kvId, d1Id } = {}) {
    const id = await accountId(acc);
    const r = await axios.delete(`${API}/accounts/${id}/workers/scripts/${script}?force=true`, { headers: headers(acc), timeout: 30000, validateStatus: () => true });
    if (r.status >= 300 && r.status !== 404) throw new Error('حذف ورکر نشد: ' + cfMsg({ response: r }));
    if (kvId) await axios.delete(`${API}/accounts/${id}/storage/kv/namespaces/${kvId}`, { headers: headers(acc), timeout: 30000, validateStatus: () => true }).catch(() => {});
    if (d1Id) await axios.delete(`${API}/accounts/${id}/d1/database/${d1Id}`, { headers: headers(acc), timeout: 30000, validateStatus: () => true }).catch(() => {});
}

// ── helpers ──────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rnd(n, abc = 'abcdefghijklmnopqrstuvwxyz0123456789') { let s = ''; for (let i = 0; i < n; i++) s += abc[crypto.randomInt(0, abc.length)]; return s; }
function workerName(suffix) {
    let base;
    try { base = require('./anti-dpi').generateSafeWorkerName(); } catch (e) { base = 'svc-' + rnd(6); }
    return base + suffix;
}
function wfetch(url, opts = {}) { return require('./github-tunnel/gt-net').gtFetch(url, Object.assign({ timeoutMs: 25000 }, opts)); }
function setCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    return raw.map((c) => String(c).split(';')[0]).filter((c) => c.includes('='));
}
function decodeLinks(body) {
    let t = String(body || '').trim();
    if (!t.includes('://')) { try { t = Buffer.from(t, 'base64').toString('utf8'); } catch (e) { /* as is */ } }
    return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => (l.startsWith('vless://') || l.startsWith('trojan://')) && !/@(127\.0\.0\.1|0\.0\.0\.0):/.test(l));
}
async function retry(times, gapMs, fn) {
    let last;
    for (let i = 0; i < times; i++) {
        try { return await fn(i); } catch (e) { last = e; if (i < times - 1) await sleep(gapMs); }
    }
    throw last;
}
/** The Worker route's own words for a failed call to a Worker (worker-route.js). */
function routeNote(url) { try { return require('./worker-route').report(new URL(url).hostname); } catch (e) { return null; } }
async function withRouteNote(url, fn) {
    try { return await fn(); } catch (e) {
        const n = routeNote(url);
        throw new Error(e.message + (n ? ' — ' + n : ''));
    }
}

async function code(id, step) {
    step('دریافت کد از گیت‌هاب سازنده…');
    const live = require('./store/worker-live');
    const r = await live.latest(id, { log: (m) => console.log(m) });
    if (!r || !r.code) throw new Error('کد پنل از گیت‌هاب سازنده گرفته نشد و نسخهٔ ذخیره‌شده‌ای هم نیست — اینترنت را بررسی کنید و دوباره امتحان کنید.');
    step(`کد سازنده: ${r.repo} @ ${r.ref}${r.from === 'cache' ? ' (آخرین نسخهٔ سالم ذخیره‌شده)' : ''}`);
    return r;
}

// ── Netra ────────────────────────────────────────────────────────────────────────

const looksLikeNetra = (c) => c.includes('_project_:"Netra"') && c.includes('SOURCE_CONTENT');

async function deployNetra(acc, step) {
    step('بررسی زیردامنه…');
    const sub = await subdomain(acc);
    const prev = install('NTR', acc.id);
    const script = prev ? prev.script : workerName('-ntr');
    const inst = prev || { script, url: `https://${script}.${sub}.workers.dev`, uuid: crypto.randomUUID(), trPass: rnd(16), subPath: rnd(12), kvId: '' };
    const c = await code('netra', step);
    if (!looksLikeNetra(c.code)) throw new Error('کد دریافتی پنل نترا نیست.');
    if (!inst.kvId) { step('ساخت فضای KV…'); inst.kvId = await createOrFind(acc, 'kv', `${script}-kv`); }
    step('بارگذاری ورکر…');
    await upload(acc, script, c.code, {
        bindings: [
            { type: 'kv_namespace', name: 'kv', namespace_id: inst.kvId },
            { type: 'secret_text', name: 'UUID', text: inst.uuid },
            { type: 'secret_text', name: 'TR_PASS', text: inst.trPass },
            { type: 'secret_text', name: 'SUB_PATH', text: inst.subPath },
        ],
        flags: ['nodejs_compat'], compat: '2024-09-23',
    });
    step('فعال کردن آدرس…');
    await enableWorkersDev(acc, script);
    return saveInstall('NTR', acc.id, Object.assign(inst, { version: c.version }));
}

async function configsNetra(inst) {
    const url = `${inst.url}/${inst.subPath}/sub/raw?app=xray`;
    // Up to ~40 s: right after its secrets change (an adopted Netra gets new ones) the edge serves
    // the old SUB_PATH for a while and the new one answers 404 (measured: fine a minute later).
    return withRouteNote(url, () => retry(8, 5000, async () => {
        const r = await wfetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const links = decodeLinks(await r.text());
        if (!links.length) throw new Error('اشتراک نترا خالی بود.');
        return links;
    }));
}

// ── Gozargah ─────────────────────────────────────────────────────────────────────

const looksLikeGozargah = (c) => c.includes('GZ_DB') && c.includes('gozargah');

async function gzLogin(url, panel, password) {
    const r = await wfetch(`${url}/${panel}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!r.ok) throw new Error('ورود به پنل گذرگاه نشد (HTTP ' + r.status + ')');
    const ck = setCookies(r);
    if (!ck.length) throw new Error('پنل گذرگاه کوکی نشست نداد.');
    return ck.join('; ');
}
async function gzCall(url, cookie, method, body) {
    const r = await wfetch(url, { method, headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let o = {}; try { o = JSON.parse(t); } catch (e) { o = {}; }
    if (!r.ok) throw new Error(o.error || 'HTTP ' + r.status);
    return o;
}

async function deployGozargah(acc, step) {
    step('بررسی زیردامنه…');
    const sub = await subdomain(acc);
    const prev = install('GZG', acc.id);
    const script = prev ? prev.script : workerName('-gzg');
    const url = prev ? prev.url : `https://${script}.${sub}.workers.dev`;
    const c = await code('gozargah', step);
    if (!looksLikeGozargah(c.code)) throw new Error('کد دریافتی پنل گذرگاه نیست.');
    let d1 = prev && prev.d1Id;
    if (!d1) { step('ساخت دیتابیس D1…'); d1 = await createOrFind(acc, 'd1', `${script}-db`); }
    step('بارگذاری ورکر…');
    await upload(acc, script, c.code, { bindings: [{ type: 'd1', name: 'GZ_DB', id: d1 }], compat: '2025-01-15' });
    step('فعال کردن آدرس…');
    await enableWorkersDev(acc, script);
    if (prev && !prev.fresh) return saveInstall('GZG', acc.id, Object.assign(prev, { d1Id: d1, version: c.version }));

    // First run (or an adopted panel never opened): it sits on its public defaults until this
    // replaces them.
    step('امن کردن پنل (رمز و مسیرهای تصادفی)…');
    const panelPath = 'g' + rnd(11), subPath = 'g' + rnd(9), password = 'g' + rnd(19);
    let cookie = null;
    for (let i = 0; i < 6 && !cookie; i++) {
        cookie = await gzLogin(url, 'gozargah', 'admin').catch(() => null);
        if (!cookie) await sleep(3000);
    }
    if (!cookie) throw new Error('پنل گذرگاه پس از نصب جواب نداد.' + (routeNote(url) ? ' — ' + routeNote(url) : ''));
    await gzCall(`${url}/gozargah/api/settings`, cookie, 'POST', { newPassword: password, panelPath, subPath });
    return saveInstall('GZG', acc.id, { script, url, panelPath, subPath, password, d1Id: d1, version: c.version });
}

async function configsGozargah(inst) {
    return withRouteNote(inst.url, () => retry(4, 3000, async () => {
        const cookie = await gzLogin(inst.url, inst.panelPath, inst.password);
        const find = async () => ((await gzCall(`${inst.url}/${inst.panelPath}/api/users`, cookie, 'GET')).users || []).find((u) => u.name === ARENA_USER);
        let user = await find();
        if (!user) { await gzCall(`${inst.url}/${inst.panelPath}/api/users`, cookie, 'POST', { name: ARENA_USER }); user = await find(); }
        if (!user || !user.subToken) throw new Error('کاربر «' + ARENA_USER + '» در گذرگاه ساخته نشد.');
        const r = await wfetch(`${inst.url}/${inst.subPath}/${user.subToken}?app=v2ray`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const links = decodeLinks(await r.text());
        if (!links.length) throw new Error('اشتراک گذرگاه خالی بود.');
        return links;
    }));
}

// ── Nova ─────────────────────────────────────────────────────────────────────────

const looksLikeNova = (c) => c.includes('IRNova') && c.includes('/install/set') && c.includes('admin/sub-content');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
/** Nova's subscription token (its own function `He`): md5 of chars 7..27 of md5(host + uuid). */
const novaToken = (host, uuid) => md5(md5(host + uuid).substring(7, 27)).toLowerCase();

async function novaLogin(url, password) {
    const r = await wfetch(`${url}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(password) });
    const t = await r.text();
    let ok = false; try { ok = !!JSON.parse(t).success; } catch (e) { ok = false; }
    const ck = setCookies(r);
    if (!ok || !ck.length) throw new Error('ورود به پنل نوا نشد (HTTP ' + r.status + ')');
    return ck.join('; ');
}

async function deployNova(acc, step) {
    step('بررسی زیردامنه…');
    const sub = await subdomain(acc);
    const prev = install('NVA', acc.id);
    const script = prev ? prev.script : workerName('-nva');
    const url = prev ? prev.url : `https://${script}.${sub}.workers.dev`;
    const c = await code('nova', step);   // worker-live checked it against version.json's SHA-256
    if (!looksLikeNova(c.code)) throw new Error('کد دریافتی پنل نوا نیست.');
    let d1 = prev && prev.d1Id, kv = prev && prev.kvId;
    if (!d1) { step('ساخت دیتابیس D1…'); d1 = await createOrFind(acc, 'd1', `${script}-db`); }
    if (!kv) { step('ساخت فضای KV…'); kv = await createOrFind(acc, 'kv', `${script}-kv`); }
    step('بارگذاری ورکر…');
    await upload(acc, script, c.code, { bindings: [{ type: 'd1', name: 'DB', id: d1 }, { type: 'kv_namespace', name: 'KV', namespace_id: kv }], flags: ['nodejs_compat'], compat: '2026-07-30' });
    step('فعال کردن آدرس…');
    await enableWorkersDev(acc, script);
    if (prev) return saveInstall('NVA', acc.id, Object.assign(prev, { d1Id: d1, kvId: kv, version: c.version }));

    // /install is PUBLIC until a password is set — whoever sets one first owns the panel.
    step('امن کردن پنل (رمز ۲۴ حرفی، بلافاصله)…');
    const password = rnd(24, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    let claimed = false, lastErr = '';
    for (let i = 0; i < 8 && !claimed; i++) {
        try {
            const r = await wfetch(`${url}/install/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
            let o = {}; try { o = JSON.parse(await r.text()); } catch (e) { o = {}; }
            if (r.ok && o.success) claimed = true;
            else lastErr = o.error || 'HTTP ' + r.status;
        } catch (e) { lastErr = e.message; }
        if (claimed || lastErr === 'already_configured') break;
        await sleep(3000);
    }
    if (!claimed) throw new Error('پنل نوا پس از نصب رمز نگرفت (' + lastErr + ')' + (lastErr === 'already_configured' ? ' — کس دیگری زودتر رمز گذاشته؛ این ورکر را حذف و دوباره نصب کنید.' : ''));
    return saveInstall('NVA', acc.id, { script, url, password, d1Id: d1, kvId: kv, version: c.version });
}

async function configsNova(inst) {
    return withRouteNote(inst.url, () => retry(4, 3000, async () => {
        const cookie = await novaLogin(inst.url, inst.password);
        const r = await wfetch(`${inst.url}/admin/config.json`, { headers: { Cookie: cookie } });
        if (!r.ok) throw new Error('config.json HTTP ' + r.status);
        const cfg = JSON.parse(await r.text());
        const host = cfg.HOST || new URL(inst.url).host;
        if (cfg.UUID) {
            const s = await wfetch(`${inst.url}/sub?token=${novaToken(host, cfg.UUID)}&b64`);
            if (s.ok) {
                const links = decodeLinks(await s.text());
                if (links.length) return links;
            }
        }
        const fallback = decodeLinks(cfg.LINK || '');
        if (!fallback.length) throw new Error('اشتراک نوا خالی بود.');
        return fallback;
    }));
}

// ── Spider ───────────────────────────────────────────────────────────────────────

const SPIDER_INJECTED = ['PANEL_TOKEN', 'PANEL_DOMAIN', 'WORKER_DOMAIN'];
const looksLikeSpider = (c) => c.includes('SpiderPanel') && c.includes('SPIDER_KV') && c.includes('/panel/config');
function spiderInject(template, values) {
    let out = template;
    for (const n of SPIDER_INJECTED) {
        if (!out.includes(`__${n}__`)) throw new Error(`کد تازهٔ اسپایدر دیگر جای «${n}» را ندارد — نصب نشد.`);
        out = out.split(`__${n}__`).join(values[n]);
    }
    return out;
}

async function deploySpider(acc, step) {
    step('بررسی زیردامنه…');
    const sub = await subdomain(acc);
    const prev = install('SPD', acc.id);
    const script = prev ? prev.script : workerName('-spd');
    const host = `${script}.${sub}.workers.dev`;
    const token = prev ? prev.token : crypto.randomBytes(24).toString('hex');
    const c = await code('spider', step);
    if (!looksLikeSpider(c.code)) throw new Error('کد دریافتی ورکر اسپایدر نیست.');
    // Every occurrence, as the panel's own deployer does (a plain replace): the header comment
    // names the placeholders too.
    const body = spiderInject(c.code, {
        PANEL_TOKEN: JSON.stringify(token),
        PANEL_DOMAIN: JSON.stringify('mlmvpn-app'),   // the panel is this app; shows only in /health
        WORKER_DOMAIN: JSON.stringify(host),
    });
    let kv = prev && prev.kvId;
    if (!kv) { step('ساخت فضای KV…'); kv = await createOrFind(acc, 'kv', `${script}-db`); }
    step('بارگذاری ورکر…');
    await upload(acc, script, body, { bindings: [{ type: 'kv_namespace', name: 'SPIDER_KV', namespace_id: kv }] });
    step('فعال کردن آدرس…');
    await enableWorkersDev(acc, script);
    return saveInstall('SPD', acc.id, Object.assign(prev || {}, { script, url: `https://${host}`, token, kvId: kv, version: c.version }));
}

async function spiderCall(inst, method, p, body) {
    const r = await wfetch(inst.url + p, { method, headers: Object.assign({ Authorization: 'Bearer ' + inst.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let o = {}; try { o = JSON.parse(t); } catch (e) { o = {}; }
    if (!r.ok) throw new Error(o.error || 'HTTP ' + r.status);
    return o;
}

// KV list() is eventually consistent: a user just written can be missing from it for up to a
// minute. This app's own writes are laid over the list for 90 s (Android SpiderPanel.kt).
const pending = { put: new Map(), del: new Map() };
const PENDING_MS = 90000;
function overlay(inst, live) {
    const now = Date.now();
    for (const [k, v] of pending.put) if (now - v.at > PENDING_MS) pending.put.delete(k);
    for (const [k, v] of pending.del) if (now - v > PENDING_MS) pending.del.delete(k);
    const pre = inst.url + '|';
    const put = new Map([...pending.put].filter(([k]) => k.startsWith(pre)).map(([, v]) => [v.user.uuid, v.user]));
    const gone = new Set([...pending.del.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)));
    const merged = live.filter((u) => !gone.has(u.uuid)).map((u) => put.get(u.uuid) || u);
    for (const u of put.values()) if (!gone.has(u.uuid) && !merged.some((m) => m.uuid === u.uuid)) merged.push(u);
    return merged.sort((a, b) => String(a.remark).localeCompare(String(b.remark)));
}
async function spiderUsers(inst) { return overlay(inst, (await spiderCall(inst, 'GET', '/api/users')).users || []); }
async function spiderSaveUser(inst, u) {
    const saved = (await spiderCall(inst, 'POST', '/api/users', u)).user || u;
    pending.del.delete(inst.url + '|' + saved.uuid);
    pending.put.set(inst.url + '|' + saved.uuid, { at: Date.now(), user: saved });
    return saved;
}
async function spiderDeleteUser(inst, uuid) {
    await spiderCall(inst, 'DELETE', '/api/user/' + encodeURIComponent(uuid));
    pending.put.delete(inst.url + '|' + uuid);
    pending.del.set(inst.url + '|' + uuid, Date.now());
}
function spiderLink(inst, u) {
    const host = inst.url.replace(/^https:\/\//, '').replace(/\/$/, '');
    return `vless://${u.uuid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=${encodeURIComponent('/ws/' + u.uuid)}#${encodeURIComponent('Spider-' + (u.remark || 'user'))}`;
}
/** `/panel/config` REPLACES the user set, so the live users are sent back with the exits. */
async function spiderPushExits(inst, exits) {
    const live = await spiderUsers(inst);
    const proxies = {};
    for (const x of exits) {
        const cc = String(x.country || 'XX').toUpperCase();
        (proxies[cc.toLowerCase()] = proxies[cc.toLowerCase()] || { country: cc, country_code: cc, proxies: [] }).proxies.push(x.proxy);
    }
    await spiderCall(inst, 'POST', '/panel/config', { users: live, settings: { proxies } });
}
async function spiderStatus(inst, probe) { return spiderCall(inst, probe ? 'POST' : 'GET', probe ? '/panel/health-check' : '/panel/status'); }

/** «دریافت کانفیگ» for Spider: the arena user (made once), and every usable user's link. */
async function configsSpider(inst) {
    return withRouteNote(inst.url, () => retry(3, 3000, async () => {
        let users = await spiderUsers(inst);
        if (!users.some((u) => u.remark === ARENA_USER)) {
            await spiderSaveUser(inst, { uuid: crypto.randomUUID(), remark: ARENA_USER, limit_bytes: 0, used_bytes: 0, expire: 0, concurrent_connections: 0, proxy_ips: [] });
            users = await spiderUsers(inst);
        }
        const now = Date.now() / 1000;
        const usable = users.filter((u) => !(u.expire > 0 && now >= u.expire) && !(u.limit_bytes > 0 && u.used_bytes >= u.limit_bytes));
        return usable.map((u) => spiderLink(inst, u));
    }));
}

// ── Nahan (itsyebekhe/nahan, MIT) ──────────────────────────────────────────────────
//
// Born with the master key «admin» and its subscription on the public route «/sync» — a panel
// anyone who sweeps workers.dev could open, and configs anyone could read. The first deploy
// replaces both at once through the panel's own settings call (Android keeps «admin»; not here).

const looksLikeNahan = (c) => c.includes('Project Nahan') && c.includes('CURRENT_VERSION');

async function nahanSync(url, route, key, config) {
    const r = await wfetch(`${url}/${route}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, config }) });
    let o = {}; try { o = JSON.parse(await r.text()); } catch (e) { o = {}; }
    if (!r.ok || !o.success) throw new Error('تنظیم پنل نهان نشد: ' + (o.error || o.msg || 'HTTP ' + r.status));
    return o;
}

async function deployNahan(acc, step) {
    step('بررسی زیردامنه…');
    const sub = await subdomain(acc);
    const prev = install('NHN', acc.id);
    const script = prev ? prev.script : workerName('-nhn');
    const url = prev ? prev.url : `https://${script}.${sub}.workers.dev`;
    const c = await code('nahan', step);
    if (!looksLikeNahan(c.code)) throw new Error('کد دریافتی پنل نهان نیست.');
    let d1 = prev && prev.d1Id;
    if (!d1) { step('ساخت دیتابیس D1…'); d1 = await createOrFind(acc, 'd1', `${script}-db`); }
    step('بارگذاری ورکر…');
    await upload(acc, script, c.code, { bindings: [{ type: 'd1', name: 'IOT_DB', id: d1 }], compat: '2024-03-03' });
    step('فعال کردن آدرس…');
    await enableWorkersDev(acc, script);
    if (prev && prev.masterKey && !prev.fresh) return saveInstall('NHN', acc.id, Object.assign(prev, { d1Id: d1, version: c.version }));

    step('امن کردن پنل (کلید و مسیر تصادفی)…');
    const masterKey = 'n' + rnd(23), apiRoute = 'n' + rnd(11);
    const curRoute = (prev && prev.apiRoute) || 'sync', curKey = (prev && prev.masterKey) || 'admin';
    let done = false, last = null;
    for (let i = 0; i < 8 && !done; i++) {
        try { await nahanSync(url, curRoute, curKey, { masterKey, apiRoute }); done = true; }
        catch (e) { last = e; await sleep(3000); }
    }
    if (!done) throw new Error((last ? last.message : 'پنل نهان پس از نصب جواب نداد.') + (routeNote(url) ? ' — ' + routeNote(url) : ''));
    return saveInstall('NHN', acc.id, { script, url, d1Id: d1, masterKey, apiRoute, version: c.version });
}

async function nahanList(url) {
    const r = await wfetch(url, { headers: { 'User-Agent': 'v2rayN/7.0' } });
    if (r.status === 403) return { multi: true };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { links: decodeLinks(await r.text()) };
}

async function configsNahan(inst) {
    const base = `${inst.url}/${inst.apiRoute}`;
    return withRouteNote(base, () => retry(4, 3000, async () => {
        const one = await nahanList(`${base}?flag=a`);
        let links = one.links || [];
        if (one.multi) {
            // Multi-user (made from the panel itself): every active user's list.
            const r = await wfetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: inst.masterKey }) });
            let o = {}; try { o = JSON.parse(await r.text()); } catch (e) { o = {}; }
            const users = ((o.config && o.config.users) || []).filter((u) => !u.isPaused);
            for (const u of users) {
                const l = await nahanList(`${base}?sub=${encodeURIComponent(u.name)}&flag=a`).catch(() => ({}));
                links = links.concat(l.links || []);
            }
        }
        if (!links.length) throw new Error('اشتراک نهان خالی بود.');
        return links;
    }));
}

// ── MLM (the project's own panel; Config Studio stays on Android) ────────────────
//
// Deployed with a random ADMIN_PASSWORD (the Android AdminPassword rule: a panel answering to
// «admin» was taken over by bots within minutes). The panel's session cookie is sha256(password).

const looksLikeMlm = (c) => c.includes('GLOBAL_TRAFFIC_CACHE') && c.includes('panel_session') && c.includes('ADMIN_PASSWORD') && !c.includes('STUDIO_API_VERSION');

async function mlmCode(step) {
    step('دریافت کد از گیت‌هاب سازنده…');
    const r = await require('./store/worker-live').codeToDeploy('mlm', () => {
        try { return fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'mlm', 'worker.js'), 'utf8'); } catch (e) { return null; }
    }, { log: (m) => console.log(m) });
    if (!r || !r.code) throw new Error('کد پنل MLM پیدا نشد.');
    step(r.from === 'bundle' ? 'کد همراه برنامه (گیت‌هاب در دسترس نبود)' : `کد سازنده: ${r.repo} @ ${r.ref}`);
    return r;
}

async function mlmCall(inst, method, p, body) {
    const hash = crypto.createHash('sha256').update(inst.password, 'utf8').digest('hex');
    const r = await wfetch(inst.url + p, { method, headers: Object.assign({ Cookie: 'panel_session=' + hash, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let o = {}; try { o = JSON.parse(t); } catch (e) { o = {}; }
    if (!r.ok) throw new Error((o && o.error) || 'HTTP ' + r.status);
    return o;
}

async function deployMlm(acc, step) {
    step('بررسی زیردامنه…');
    const sub = await subdomain(acc);
    const prev = install('MLM', acc.id);
    const script = prev ? prev.script : workerName('-mlm');
    const url = prev ? prev.url : `https://${script}.${sub}.workers.dev`;
    const password = (prev && prev.password) || rnd(24, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    const c = await mlmCode(step);
    if (!looksLikeMlm(c.code)) throw new Error('کد دریافتی پنل MLM نیست.');
    let d1 = prev && prev.d1Id;
    if (!d1) { step('ساخت دیتابیس D1…'); d1 = await createOrFind(acc, 'd1', `${script}-db`); }
    step('بارگذاری ورکر…');
    await upload(acc, script, c.code, {
        bindings: [{ type: 'd1', name: 'DB', id: d1 }, { type: 'secret_text', name: 'ADMIN_PASSWORD', text: password }],
        compat: '2024-03-03',
    });
    step('فعال کردن آدرس…');
    await enableWorkersDev(acc, script);
    return saveInstall('MLM', acc.id, Object.assign(prev || {}, { script, url, d1Id: d1, password, version: c.version }));
}

/** An MLM XHTTP link as VLESS·WS on the same Worker (ALPN http/1.1 only: h2 kills WS). */
function mlmWsTwin(u) {
    try {
        const url = new URL(u);
        if (url.protocol !== 'vless:' || url.searchParams.get('type') !== 'xhttp') return null;
        const q = url.searchParams;
        for (const k of ['mode', 'extra']) q.delete(k);
        q.set('type', 'ws');
        q.set('path', '/');   // no early data: this Worker reads the VLESS header in-band
        q.set('alpn', 'http/1.1');
        url.hash = encodeURIComponent(decodeURIComponent(url.hash.slice(1) || 'MLM') + ' · WS');
        return url.toString();
    } catch (e) { return null; }
}

async function configsMlm(inst) {
    return withRouteNote(inst.url, () => retry(4, 3000, async () => {
        const users = (await mlmCall(inst, 'GET', '/api/users')).users || [];
        if (!users.some((u) => u.username === ARENA_USER)) {
            await mlmCall(inst, 'POST', '/api/users', { username: ARENA_USER, limit_gb: null, daily_limit_gb: null, expiry_days: null, tls: 'tls', port: '443', fingerprint: 'chrome' });
        }
        const r = await wfetch(`${inst.url}/sub/${encodeURIComponent(ARENA_USER)}?txt=1`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const links = decodeLinks(await r.text());
        if (!links.length) throw new Error('اشتراک MLM خالی بود.');
        // The panel hands out XHTTP only, and packet-up through Cloudflare lands its POSTs on
        // other isolates (measured: -1 on every try, 2026-09-29). The same Worker takes VLESS over
        // WebSocket on «/», so each link gets a WS twin, listed first.
        const ws = links.map(mlmWsTwin).filter(Boolean);
        return [...new Set(ws.concat(links))];
    }));
}

// ── the surface ─────────────────────────────────────────────────────────────────

const DEPLOY = { SPD: deploySpider, NTR: deployNetra, GZG: deployGozargah, NVA: deployNova, NHN: deployNahan, MLM: deployMlm };
const CONFIGS = { SPD: configsSpider, NTR: configsNetra, GZG: configsGozargah, NVA: configsNova, NHN: configsNahan, MLM: configsMlm };

function panelOf(code) {
    const p = PANELS[String(code || '').toUpperCase()];
    if (!p) throw new Error('پنل ناشناخته: ' + code);
    return p;
}

// ── one install per panel per account (panel-registry.js) ──────────────────────────

function registry() { return require('./panel-registry'); }

/**
 * Before any install: the install this ACCOUNT already has wins over making another. In order:
 *   1. the account's registry (written by either app) — used as it is;
 *   2. our own local record, when its Worker is still there;
 *   3. a panel of this kind already on the account (the phone's, an older app's) — adopted: the
 *      same Worker, the same KV/D1, credentials read or, where unreadable, set anew on it.
 * Only when there is none of the three does the deploy make a Worker (and one KV/D1 for it).
 */
async function resolveExisting(code, acc, step) {
    const reg = registry();
    const title = PANELS[code].title;
    const local = install(code, acc.id);
    let g = null;
    try { g = await reg.get(acc, code); } catch (e) { step('ثبت پنل‌های حساب خوانده نشد (' + e.message + ') — از روی خود حساب می‌گردم.'); }
    if (g && await reg.scriptExists(acc, g.script).catch(() => false)) {
        if (!local || local.script !== g.script || JSON.stringify(reg.toRegistry(code, local).s) !== JSON.stringify(g.s || {})) {
            saveInstall(code, acc.id, Object.assign(reg.fromRegistry(code, g), { version: local && local.script === g.script ? local.version : null }));
            step(`همان ${title} این حساب (${g.by === 'android' ? 'نصب گوشی' : 'نصب ویندوز'}) به کار می‌رود — ورکر، KV یا D1 تازه‌ای ساخته نمی‌شود.`);
        }
        return { from: 'registry', script: g.script };
    }
    if (local && await reg.scriptExists(acc, local.script).catch(() => false)) return { from: 'local', script: local.script };
    const found = await reg.find(acc, code, { force: true }).catch(() => []);
    if (!found.length) { if (local) forget(code, acc.id); return { from: 'new' }; }
    const pick = found[0].script;
    step(`${title} از قبل روی این حساب هست (${pick}) — همان به کار می‌رود، بدون ورکر یا دیتابیس تازه.`);
    const { rec, reset } = await reg.adopt(acc, code, pick, step);
    saveInstall(code, acc.id, rec);
    if (reset.length) step('روی همان ورکر تازه شد: ' + reset.join('، ') + ' (کاربران و داده سر جایشان).');
    return { from: 'adopted', script: pick, others: found.slice(1).map((x) => x.script) };
}

/** After an install: the account's registry says which install is THE one, for both apps. */
async function publish(code, acc, inst, step) {
    try { await registry().put(acc, code, registry().toRegistry(code, inst)); step('در حساب ثبت شد — گوشی هم همین نصب را به کار می‌برد.'); }
    catch (e) { step('ثبت در حساب نشد (' + e.message + ') — نصب کار می‌کند، ولی گوشی از آن خبر ندارد.'); }
}

async function deploy(code, accId, { onStep = () => {}, fallbackAcc } = {}) {
    const p = panelOf(code);
    const acc = account(accId, fallbackAcc);
    const step = (m) => { try { onStep(`[${p.title}] ${m}`); } catch (e) {} };
    await resolveExisting(p.code, acc, step);
    const inst = await DEPLOY[p.code](acc, step);
    step('نصب شد: ' + inst.url);
    await publish(p.code, acc, inst, step);
    try { registry().forgetSurvey(acc); } catch (e) { /* cache */ }
    return { url: inst.url, script: inst.script, version: inst.version || null };
}

/**
 * The account's registry → this machine's records, for every panel; our own installs the registry
 * does not know yet are published. Returns per panel what happened, and every OTHER Worker of the
 * same kind on the account (a duplicate from before the registry) for the Cloud window to offer
 * removing. Nothing is removed here.
 */
async function sync(accId, { fallbackAcc, withDuplicates = true } = {}) {
    const acc = account(accId, fallbackAcc);
    const reg = registry();
    const out = { panels: {}, duplicates: [] };
    let regAll = {};
    try { regAll = await reg.all(acc); } catch (e) { out.error = e.message; }
    for (const code of Object.keys(PANELS)) {
        const local = install(code, acc.id);
        const g = regAll[code];
        try {
            if (g && await reg.scriptExists(acc, g.script)) {
                if (!local || local.script !== g.script || JSON.stringify(reg.toRegistry(code, local).s) !== JSON.stringify(g.s || {})) {
                    saveInstall(code, acc.id, Object.assign(reg.fromRegistry(code, g), { version: local && local.script === g.script ? local.version : null }));
                    out.panels[code] = 'from-registry';
                } else out.panels[code] = 'same';
            } else if (local && await reg.scriptExists(acc, local.script)) {
                await reg.put(acc, code, reg.toRegistry(code, local));
                out.panels[code] = 'published';
            } else {
                if (local) forget(code, acc.id);
                out.panels[code] = 'none';
            }
        } catch (e) { out.panels[code] = 'error: ' + e.message; }
    }
    if (withDuplicates) {
        try { out.duplicates = await duplicates(acc); } catch (e) { out.duplicatesError = e.message; }
    }
    return out;
}

/**
 * Workers of a panel kind on the account that are NOT the account's install of it — what the phone
 * and this app each made before they shared a registry — with the KV/D1 each is bound to. Whether a
 * piece of storage is also bound to another Worker (then it is never deleted) is decided at removal
 * time, from every Worker's bindings (`removeDuplicate`).
 */
async function duplicates(acc) {
    const reg = registry();
    const regAll = await reg.all(acc).catch(() => ({}));
    const rows = await reg.survey(acc, { force: true });
    const canon = {};
    for (const code of reg.CODES) canon[code] = (regAll[code] && regAll[code].script) || (install(code, acc.id) || {}).script || null;
    // BPB / Edge / Zeus live in the Cloud window's account record.
    canon.BPB = canon.BPB || reg.scriptOf(acc.url); canon.EDG = canon.EDG || reg.scriptOf(acc.edgeUrl); canon.ZEU = canon.ZEU || reg.scriptOf(acc.zeusUrl);
    const byId = {}; for (const [code, id] of Object.entries(reg.CATALOG_ID)) byId[id] = code;
    const dups = rows.filter((r) => byId[r.id] && canon[byId[r.id]] && r.script !== canon[byId[r.id]]);
    if (!dups.length) return [];
    const bs = await reg.pool(dups, 4, (r) => reg.bindings(acc, r.script).catch(() => null));
    return dups.map((r, i) => {
        const b = bs[i] || [];
        return {
            code: byId[r.id], title: (PANELS[byId[r.id]] || {}).title || { BPB: 'BPB', EDG: 'Edge', ZEU: 'Zeus' }[byId[r.id]] || byId[r.id],
            script: r.script, modifiedOn: r.modifiedOn, canonical: canon[byId[r.id]], unread: !bs[i],
            kv: b.filter((x) => x.type === 'kv_namespace').map((x) => x.namespace_id),
            d1: b.filter((x) => x.type === 'd1').map((x) => x.id || x.database_id),
        };
    });
}

/**
 * Remove ONE duplicate the user chose: its Worker, and each KV/D1 it holds ONLY when no other Worker
 * on the account is bound to it (read from every Worker's bindings now, a few at a time; if any of
 * them cannot be read, storage is kept — a leftover namespace costs nothing, a deleted one loses data).
 */
async function removeDuplicate(accId, script, { fallbackAcc } = {}) {
    const acc = account(accId, fallbackAcc);
    const reg = registry();
    const d = (await duplicates(acc)).find((x) => x.script === script);
    if (!d) throw new Error('این ورکر نسخهٔ تکراری یک پنل نیست — حذف نشد.');
    const id = await accountId(acc);
    const list = (await axios.get(`${API}/accounts/${id}/workers/scripts`, { headers: headers(acc), timeout: 30000 })).data.result || [];
    const others = list.map((w) => w.id).filter((x) => x !== script);
    const bs = await reg.pool(others, 4, (sc) => reg.bindings(acc, sc).catch(() => null));
    const complete = bs.every(Boolean);
    const usedBy = (kind, sid) => others.filter((sc, i) => (bs[i] || []).some((b) => (kind === 'kv' ? b.namespace_id === sid : (b.id || b.database_id) === sid)));
    const freeKv = complete ? d.kv.filter((k) => !usedBy('kv', k).length) : [];
    const freeD1 = complete ? d.d1.filter((k) => !usedBy('d1', k).length) : [];
    await removeWorker(acc, script, {});
    for (const k of freeKv) await axios.delete(`${API}/accounts/${id}/storage/kv/namespaces/${k}`, { headers: headers(acc), timeout: 30000, validateStatus: () => true }).catch(() => {});
    for (const k of freeD1) await axios.delete(`${API}/accounts/${id}/d1/database/${k}`, { headers: headers(acc), timeout: 30000, validateStatus: () => true }).catch(() => {});
    try { reg.forgetSurvey(acc); } catch (e) { /* cache */ }
    return { removed: script, freed: { kv: freeKv, d1: freeD1 }, kept: { kv: d.kv.filter((k) => !freeKv.includes(k)), d1: d.d1.filter((k) => !freeD1.includes(k)) } };
}

async function configs(code, accId) {
    const p = panelOf(code);
    let inst = install(p.code, accId);
    if (!inst) {
        // Installed from the phone (or before this machine knew): the account's registry says where.
        try {
            const acc = account(accId);
            const g = await registry().get(acc, p.code);
            if (g) inst = saveInstall(p.code, accId, registry().fromRegistry(p.code, g));
        } catch (e) { /* not installed anywhere we can see */ }
    }
    if (!inst) throw new Error(`پنل ${p.title} روی این حساب نصب نیست.`);
    const links = await CONFIGS[p.code](inst);
    saveInstall(p.code, accId, Object.assign(inst, { fetchedAt: Date.now(), configCount: links.length }));
    return links;
}

async function remove(code, accId, { fallbackAcc } = {}) {
    const p = panelOf(code);
    const inst = install(p.code, accId);
    if (!inst) return { removed: false };
    const acc = account(accId, fallbackAcc);
    await removeWorker(acc, inst.script, { kvId: inst.kvId, d1Id: inst.d1Id });
    forget(p.code, accId);
    // The account's record goes with it, so the phone does not keep pointing at a Worker that is gone.
    try { const g = await registry().get(acc, p.code); if (g && g.script === inst.script) await registry().remove(acc, p.code); } catch (e) { /* best effort */ }
    try { registry().forgetSurvey(acc); } catch (e) { /* cache */ }
    return { removed: true };
}

/** For «باز کردن پنل وب»: the address and the password to paste (Gozargah, Nova). */
function webPanel(code, accId) {
    const p = panelOf(code);
    const inst = install(p.code, accId);
    if (!inst) throw new Error(`پنل ${p.title} روی این حساب نصب نیست.`);
    if (p.code === 'GZG') return { url: `${inst.url}/${inst.panelPath}`, password: inst.password };
    if (p.code === 'NVA') return { url: `${inst.url}/admin`, password: inst.password };
    if (p.code === 'NTR') return { url: `${inst.url}/${inst.subPath}/panel`, password: null };
    if (p.code === 'NHN') return { url: `${inst.url}/${inst.apiRoute}/dash`, password: inst.masterKey };
    if (p.code === 'MLM') return { url: inst.url, password: inst.password };
    return { url: inst.url, password: null };
}

module.exports = {
    PANELS, ARENA_USER, status, deploy, configs, remove, webPanel, install, sync, duplicates, removeDuplicate, resolveExisting,
    // Spider management
    spider: {
        users: (accId) => spiderUsers(install('SPD', accId) || (() => { throw new Error('اسپایدر نصب نیست.'); })()),
        save: (accId, u) => spiderSaveUser(install('SPD', accId), u),
        remove: (accId, uuid) => spiderDeleteUser(install('SPD', accId), uuid),
        link: (accId, u) => spiderLink(install('SPD', accId), u),
        status: (accId, probe) => spiderStatus(install('SPD', accId), probe),
        pushExits: (accId, exits) => spiderPushExits(install('SPD', accId), exits),
    },
    // the Cloudflare calls, for the other deployers (warp-id-relay.js)
    _cf: { account, accountId, subdomain, upload, enableWorkersDev, removeWorker, workerName, headers },
    // for tests
    novaToken, spiderInject, decodeLinks, looksLikeNetra, looksLikeGozargah, looksLikeNova, looksLikeSpider, looksLikeNahan, looksLikeMlm,
};
