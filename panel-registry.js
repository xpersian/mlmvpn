// --- panel-registry.js — one install per panel per Cloudflare account, shared by the phone and Windows ---
//
// The user's rule (2026-09-30): «تک‌تک پنل‌های روی گوشی و ویندوز باید با هم هماهنگ بشن؛ برای هر
// کدام ورکر یا KV یا D1 جدا ساخته نشه و اطلاعات هردو مشترک باشه. هر پنل فقط یک KV یا D1 بسازه؛
// با هر نصب یکی جدید نسازه؛ اگر قدیمی داره از همون استفاده کنه.»
//
// Until 1.2.5 each app kept its install records on the device (Android: SharedPreferences, Windows:
// ~/.mlmvpn/cloud-panels.json and cf_accounts), so the other device knew nothing, made its own Worker
// and its own KV/D1 — and one account ran out of its ten free D1 databases (2026-09-29).
//
// THE REGISTRY lives on the account itself: a KV namespace titled `mlmvpn-panels`, one key per panel
// code, value = the install record, the same JSON on both platforms (docs/PANEL-REGISTRY.md):
//   { "v": 1, "code": "NTR", "script": "…", "url": "https://….workers.dev", "kv": "<id>", "d1": "<id>",
//     "s": { …the panel's own credentials… }, "by": "windows"|"android", "at": <ms> }
// It is never bound to any Worker (no panel code can read it); only the account's own API credential
// can, the one both apps already hold.
//
// ADOPTION — a panel already on the account that the registry does not know yet (made by an older app,
// or by the other device before it spoke the registry) is found by its CODE (store/workers.classify)
// and taken over as it is: the same Worker, the same KV/D1. Its credentials come from where the panel
// itself keeps them when they can be read (Nahan's sys_config and Gozargah's paths in D1, Nova's
// admin_pass, Spider's token and BPB's settings in the code, Zeus's password hash in D1); when they
// cannot (Netra's, Edge's and MLM's secrets live in the Worker's env), a new value is set on the SAME
// Worker — its users and data stay — and the registry carries it to the other device.

'use strict';

const axios = require('axios');
const crypto = require('crypto');

const API = 'https://api.cloudflare.com/client/v4';
const NS_TITLE = 'mlmvpn-panels';
const CODES = ['BPB', 'EDG', 'ZEU', 'NHN', 'MLM', 'SPD', 'NTR', 'GZG', 'NVA'];
/** The store catalogue's id for each code (store/catalog.js › WORKERS). */
const CATALOG_ID = { BPB: 'bpb', EDG: 'edge', ZEU: 'zeus', NHN: 'nahan', MLM: 'mlm', SPD: 'spider', NTR: 'netra', GZG: 'gozargah', NVA: 'nova' };

function cf() { return require('./cloud-panels')._cf; }
const H = (acc) => cf().headers(acc);

// ── the registry namespace ───────────────────────────────────────────────────────

const nsCache = new Map();   // accountId → namespace id (or null for «none yet»)

async function namespace(acc, { create = false } = {}) {
    const id = await cf().accountId(acc);
    if (nsCache.has(id) && (nsCache.get(id) || !create)) return nsCache.get(id);
    let found = null;
    for (let page = 1; page < 20 && !found; page++) {
        const r = await axios.get(`${API}/accounts/${id}/storage/kv/namespaces`, { headers: H(acc), params: { page, per_page: 100 }, timeout: 20000, validateStatus: () => true });
        const list = (r.data && r.data.result) || [];
        found = list.find((n) => n.title === NS_TITLE) || null;
        if (list.length < 100) break;
    }
    if (!found && create) {
        const r = await axios.post(`${API}/accounts/${id}/storage/kv/namespaces`, { title: NS_TITLE }, { headers: H(acc), timeout: 20000, validateStatus: () => true });
        found = (r.data && r.data.result) || null;
        if (!found) {   // made by the other device a moment ago
            const again = await axios.get(`${API}/accounts/${id}/storage/kv/namespaces`, { headers: H(acc), params: { per_page: 100 }, timeout: 20000, validateStatus: () => true });
            found = ((again.data && again.data.result) || []).find((n) => n.title === NS_TITLE) || null;
        }
        if (!found) throw new Error('فضای ثبت پنل‌ها روی حساب ساخته نشد: ' + (((r.data || {}).errors || [])[0] || {}).message);
    }
    nsCache.set(id, found ? found.id : null);
    return found ? found.id : null;
}

async function get(acc, code) {
    const ns = await namespace(acc);
    if (!ns) return null;
    const id = await cf().accountId(acc);
    const r = await axios.get(`${API}/accounts/${id}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(code)}`,
        { headers: H(acc), timeout: 20000, validateStatus: () => true, responseType: 'text', transformResponse: [(d) => d] });
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error('خواندن ثبت پنل‌ها نشد (HTTP ' + r.status + ')');
    try { const o = JSON.parse(r.data); return o && o.script ? o : null; } catch (e) { return null; }
}

async function put(acc, code, rec) {
    const ns = await namespace(acc, { create: true });
    const id = await cf().accountId(acc);
    const body = JSON.stringify(Object.assign({ v: 1, code }, rec, { by: 'windows', at: Date.now() }));
    const r = await axios.put(`${API}/accounts/${id}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(code)}`, body,
        { headers: Object.assign(H(acc), { 'Content-Type': 'text/plain' }), timeout: 20000, validateStatus: () => true });
    if (r.status >= 300) throw new Error('نوشتن ثبت پنل‌ها نشد (HTTP ' + r.status + ')');
    return true;
}

async function remove(acc, code) {
    const ns = await namespace(acc);
    if (!ns) return false;
    const id = await cf().accountId(acc);
    await axios.delete(`${API}/accounts/${id}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(code)}`, { headers: H(acc), timeout: 20000, validateStatus: () => true });
    return true;
}

async function all(acc) {
    const out = {};
    await Promise.all(CODES.map(async (c) => { try { const r = await get(acc, c); if (r) out[c] = r; } catch (e) { /* one unreadable key is not all */ } }));
    return out;
}

// ── reading the account ───────────────────────────────────────────────────────────

const surveyCache = new Map();   // accountId → { at, rows }
const SURVEY_TTL = 5 * 60 * 1000;

/** Every recognised Worker on the account, as the store sees it: [{ script, id (catalogue), modifiedOn }]. */
async function survey(acc, { force = false } = {}) {
    const id = await cf().accountId(acc);
    const hit = surveyCache.get(id);
    if (!force && hit && Date.now() - hit.at < SURVEY_TTL) return hit.rows;
    const W = require('./store/workers');
    const s = await W.survey(Object.assign({}, acc, { _accountId: id }));
    const rows = (Array.isArray(s) ? s : (s.workers || s.rows || [])).map((w) => ({
        script: w.script || w.name, id: w.id || (w.item && w.item.id) || null, modifiedOn: w.modifiedOn || w.modified_on || '',
    })).filter((r) => r.script && r.id);
    surveyCache.set(id, { at: Date.now(), rows });
    return rows;
}
function forgetSurvey(acc) { try { surveyCache.delete(acc._accountId); } catch (e) { /* none */ } }

async function scriptExists(acc, script) {
    if (!script) return false;
    const id = await cf().accountId(acc);
    const r = await axios.get(`${API}/accounts/${id}/workers/scripts/${encodeURIComponent(script)}/settings`, { headers: H(acc), timeout: 20000, validateStatus: () => true });
    return r.status === 200;
}

/**
 * The script's bindings: [{ type, name, namespace_id | id | text }] (secret values are never returned).
 * Cloudflare rate-limits a burst of these (measured: 41 at once came back half empty), so a 429 or a
 * 5xx waits and asks again, and callers read many through `pool()` a few at a time.
 */
async function bindings(acc, script) {
    const id = await cf().accountId(acc);
    let r = null;
    for (let i = 0; i < 4; i++) {
        r = await axios.get(`${API}/accounts/${id}/workers/scripts/${encodeURIComponent(script)}/settings`, { headers: H(acc), timeout: 20000, validateStatus: () => true });
        if (r.status !== 429 && r.status < 500) break;
        await new Promise((z) => setTimeout(z, 1500 * (i + 1)));
    }
    if (r.status !== 200) throw new Error('تنظیمات ورکر ' + script + ' خوانده نشد (HTTP ' + r.status + ')');
    return (r.data && r.data.result && r.data.result.bindings) || [];
}

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
}
const kvOf = (b, name) => ((b.find((x) => x.type === 'kv_namespace' && (!name || x.name === name)) || {}).namespace_id) || null;
const d1Of = (b, name) => { const x = b.find((y) => y.type === 'd1' && (!name || y.name === name)); return x ? (x.id || x.database_id || null) : null; };

async function content(acc, script) {
    const id = await cf().accountId(acc);
    const W = require('./store/workers');
    const r = await W.fetchScript(Object.assign({}, acc, { _accountId: id }), id, script);
    return r ? r.body : '';
}

async function d1Query(acc, db, sql, params = []) {
    const id = await cf().accountId(acc);
    const r = await axios.post(`${API}/accounts/${id}/d1/database/${db}/query`, { sql, params }, { headers: H(acc), timeout: 30000, validateStatus: () => true });
    if (r.status >= 300 || !(r.data && r.data.success)) throw new Error('پرسش از D1 نشد: ' + ((((r.data || {}).errors || [])[0] || {}).message || 'HTTP ' + r.status));
    return (r.data.result && r.data.result[0] && r.data.result[0].results) || [];
}

async function kvValue(acc, ns, key) {
    const id = await cf().accountId(acc);
    const r = await axios.get(`${API}/accounts/${id}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
        { headers: H(acc), timeout: 20000, validateStatus: () => true, responseType: 'text', transformResponse: [(d) => d] });
    return r.status === 200 ? String(r.data) : null;
}

/** A secret on a deployed Worker, without touching its code or its other bindings. */
async function putSecret(acc, script, name, text) {
    const id = await cf().accountId(acc);
    const r = await axios.put(`${API}/accounts/${id}/workers/scripts/${encodeURIComponent(script)}/secrets`, { name, text, type: 'secret_text' },
        { headers: H(acc), timeout: 30000, validateStatus: () => true });
    if (r.status >= 300) throw new Error('سکرت ' + name + ' روی ورکر نشست (HTTP ' + r.status + ')');
}

/**
 * The Workers on the account that ARE panel `code`, newest first. `prefer` (a script name the caller
 * already believes in) goes first when it is among them.
 */
async function find(acc, code, { prefer = null, force = false } = {}) {
    const want = CATALOG_ID[code];
    const rows = (await survey(acc, { force })).filter((r) => r.id === want)
        .sort((a, b) => String(b.modifiedOn).localeCompare(String(a.modifiedOn)));
    if (prefer) rows.sort((a, b) => (b.script === prefer) - (a.script === prefer));
    return rows;
}

// ── adoption: what each panel's install record is, read from the account ──────────

/** The JSON object that starts at `i` in `text` (string-aware brace matching). */
function balancedJson(text, i) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
    }
    throw new Error('unbalanced');
}

const rnd = (n, abc = 'abcdefghijklmnopqrstuvwxyz0123456789') => { let s = ''; for (let i = 0; i < n; i++) s += abc[crypto.randomInt(0, abc.length)]; return s; };
const PW_ABC = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Take over panel `code` living in `script` as it is. Returns the Windows install record
 * (cloud-panels.js shape) and `reset: [names]` for credentials that had to be set anew.
 */
async function adopt(acc, code, script, step = () => {}) {
    const sub = await cf().subdomain(acc);
    const url = `https://${script}.${sub}.workers.dev`;
    const b = await bindings(acc, script);
    const reset = [];
    switch (code) {
        case 'NTR': {
            // UUID / TR_PASS / SUB_PATH are env secrets — unreadable. New ones on the same Worker.
            const rec = { script, url, kvId: kvOf(b, 'kv'), uuid: crypto.randomUUID(), trPass: rnd(16), subPath: rnd(12) };
            step('نترای موجود حساب: کلیدهای تازه روی همان ورکر (KV و داده سر جایش)…');
            await putSecret(acc, script, 'UUID', rec.uuid);
            await putSecret(acc, script, 'TR_PASS', rec.trPass);
            await putSecret(acc, script, 'SUB_PATH', rec.subPath);
            reset.push('UUID', 'TR_PASS', 'SUB_PATH');
            return { rec, reset };
        }
        case 'GZG': {
            const d1 = d1Of(b, 'GZ_DB');
            const rows = d1 ? await d1Query(acc, d1, 'SELECT value, rev FROM kv_store WHERE key = ?1', ['settings']) : [];
            const cur = rows[0] ? JSON.parse(rows[0].value) : null;
            const password = 'g' + rnd(19, PW_ABC);
            const panelPath = (cur && cur.panelPath) || 'gozargah';
            const subPath = (cur && cur.subPath) || 'sub';
            if (cur) {
                // The password is stored as PBKDF2-SHA256 (salt hex, `pwIterations`, 256 bits) — the
                // panel's own pbkdf2Hex — so a new one is written in the same form, same row, next rev.
                step('گذرگاه موجود حساب: رمز تازه روی همان دیتابیس (کاربران سر جایشان)…');
                const salt = crypto.randomBytes(16).toString('hex');
                const iters = +cur.pwIterations || 2048;
                const next = Object.assign({}, cur, {
                    passwordSalt: salt, passwordHash: crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), iters, 32, 'sha256').toString('hex'),
                    pwIterations: iters, isDefaultPassword: false,
                });
                await d1Query(acc, d1, 'UPDATE kv_store SET value = ?1, rev = rev + 1, updated_at = ?2 WHERE key = ?3', [JSON.stringify(next), Date.now(), 'settings']);
                reset.push('password');
                return { rec: { script, url, panelPath, subPath, password, d1Id: d1 }, reset };
            }
            // Never opened: still on its public defaults, which deploy() replaces as on a fresh install.
            return { rec: { script, url, panelPath: 'gozargah', subPath: 'sub', password: 'admin', d1Id: d1, fresh: true }, reset };
        }
        case 'NVA': {
            const d1 = d1Of(b, 'DB'), kv = kvOf(b, 'KV');
            // Nova keeps it in plain text: KV «admin_pass», or on D1 the same key in its own
            // `kvstore` table, whose columns are k / v / updated (read from a live panel, 2026-09-30).
            let password = kv ? await kvValue(acc, kv, 'admin_pass') : null;
            if (!password && d1) {
                const rows = await d1Query(acc, d1, 'SELECT v FROM kvstore WHERE k = ?1', ['admin_pass']).catch(() => []);
                password = rows[0] && rows[0].v != null ? String(rows[0].v) : null;
            }
            if (password && password.startsWith('"')) { try { password = JSON.parse(password); } catch (e) { /* as stored */ } }
            if (!password) throw new Error('رمز پنل نوای موجود حساب خوانده نشد (admin_pass).');
            return { rec: { script, url, password, d1Id: d1, kvId: kv }, reset };
        }
        case 'SPD': {
            const code2 = await content(acc, script);
            const m = /const\s+PANEL_TOKEN\s*=\s*"([^"]+)"/.exec(code2);
            if (!m || m[1].startsWith('__')) throw new Error('توکن ورکر اسپایدر موجود حساب خوانده نشد.');
            return { rec: { script, url, token: m[1], kvId: kvOf(b, 'SPIDER_KV') }, reset };
        }
        case 'NHN': {
            const d1 = d1Of(b, 'IOT_DB');
            const rows = d1 ? await d1Query(acc, d1, 'SELECT value FROM kv_store WHERE key = ?1', ['sys_config']).catch(() => []) : [];
            const cfg = rows[0] ? JSON.parse(rows[0].value) : {};
            return { rec: { script, url, d1Id: d1, masterKey: cfg.masterKey || 'admin', apiRoute: cfg.apiRoute || 'sync', fresh: !cfg.masterKey || cfg.masterKey === 'admin' }, reset };
        }
        case 'MLM': {
            // The phone deploys it as a plain_text binding, which the API does return; this app as a
            // secret, which it does not — then a new one is set on the same Worker.
            const plain = b.find((x) => x.type === 'plain_text' && x.name === 'ADMIN_PASSWORD' && x.text);
            if (plain) return { rec: { script, url, d1Id: d1Of(b, 'DB'), password: plain.text }, reset };
            const password = rnd(24, PW_ABC);
            step('پنل MLM موجود حساب: رمز مدیریت تازه روی همان ورکر (کاربران سر جایشان)…');
            await putSecret(acc, script, 'ADMIN_PASSWORD', password);
            reset.push('ADMIN_PASSWORD');
            return { rec: { script, url, d1Id: d1Of(b, 'DB'), password }, reset };
        }
        case 'BPB': {
            // The settings BPB compiles into its own script — written by this app with a space and a
            // newline, by the panel's self-redeploy without either — so parsed by balanced braces.
            const code2 = await content(acc, script);
            const at = code2.indexOf('{"EMBEDED_SETTINGS"');
            let e = null; try { e = at >= 0 ? JSON.parse(balancedJson(code2, at)).EMBEDED_SETTINGS : null; } catch (x) { e = null; }
            if (!e || !e.vlUUID) throw new Error('تنظیمات پنل BPB موجود حساب خوانده نشد.');
            return { rec: { script, url, uuid: e.vlUUID, trPass: e.trPass, subPath: e.securePath, kvId: kvOf(b, 'kv') }, reset };
        }
        case 'EDG': {
            // The phone's Edge carries its UUID as plain_text (readable); this app's as a secret.
            const plain = b.find((x) => x.type === 'plain_text' && x.name === 'UUID' && x.text);
            if (plain) return { rec: { script, url, uuid: plain.text, kvId: kvOf(b, 'KV') }, reset };
            const uuid = crypto.randomUUID();
            step('Edge موجود حساب: شناسهٔ تازه روی همان ورکر…');
            await putSecret(acc, script, 'UUID', uuid);
            reset.push('UUID');
            return { rec: { script, url, uuid, kvId: kvOf(b, 'KV') }, reset };
        }
        case 'ZEU': {
            const d1 = d1Of(b, 'DB');
            return { rec: { script, url, d1Id: d1 }, reset };
        }
        default: throw new Error('پنل ناشناخته: ' + code);
    }
}

// ── the two formats ──────────────────────────────────────────────────────────────

/** Windows install record → the shared registry record. */
function toRegistry(code, r) {
    const base = { script: r.script, url: r.url, kv: r.kvId || null, d1: r.d1Id || null };
    const s = {
        NTR: { uuid: r.uuid, trPass: r.trPass, subPath: r.subPath },
        GZG: { panelPath: r.panelPath, subPath: r.subPath, password: r.password },
        NVA: { password: r.password },
        SPD: { token: r.token },
        NHN: { masterKey: r.masterKey, apiRoute: r.apiRoute },
        MLM: { password: r.password },
        BPB: { uuid: r.uuid, trPass: r.trPass, subPath: r.subPath },
        EDG: { uuid: r.uuid },
        ZEU: r.password ? { password: r.password } : {},
    }[code] || {};
    return Object.assign(base, { s });
}

/** The shared registry record → a Windows install record. */
function fromRegistry(code, g) {
    const s = g.s || {};
    const base = { script: g.script, url: g.url, kvId: g.kv || null, d1Id: g.d1 || null, fromRegistry: g.by || true };
    const rec = Object.assign(base, s);
    // A panel still on its PUBLIC defaults (an older phone app published Nahan with «admin», or a
    // Gozargah nobody secured) is secured by the next deploy — and the registry then carries the new
    // values to the other device.
    if (code === 'NHN' && (!rec.masterKey || rec.masterKey === 'admin')) rec.fresh = true;
    if (code === 'GZG' && (!rec.password || rec.password === 'admin')) rec.fresh = true;
    return rec;
}

/** Script name from a workers.dev URL. */
function scriptOf(url) { try { return new URL(url).hostname.split('.')[0]; } catch (e) { return null; } }

module.exports = {
    NS_TITLE, CODES, CATALOG_ID,
    namespace, get, put, remove, all,
    survey, forgetSurvey, scriptExists, bindings, content, d1Query, kvValue, putSecret, find, adopt,
    toRegistry, fromRegistry, scriptOf, kvOf, d1Of, pool, balancedJson,
};
