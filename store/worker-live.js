// --- «ام‌ال‌ام استور» — every panel's code, fresh from its DEVELOPER'S GitHub ---
//
// Users asked that a panel installed from the app always be the newest one its developer has
// published (2026-09-29, alongside a report that worker installs were failing). Until now a fresh
// deploy uploaded the copy bundled in this build — Edge from 2026-08-11 and Zeus 1.11.8 while the
// developers were on 2026-09-22 and 2.x — and the store's «update» went to a hand-pinned version.
//
// Here, for each panel, the newest published code is read straight from the developer's repository
// (their newest release asset, or the file on their main branch at its newest commit), checked
// against the catalogue's fingerprint for that panel (store/catalog.js › detect) so a wrong or
// truncated download is never deployed, and cached per commit/tag. Every caller falls back in order:
// fresh → last good cache → the pinned copy → the copy this build ships. A panel therefore installs
// even with GitHub unreachable, and never installs something that is not that panel.
//
// Reads go through store/net.fetchText (direct, then the user's proxy, then the app's own engines),
// and use github.com pages, not api.github.com: the API's 60 requests an hour per IP are shared by
// everyone behind an Iranian mobile NAT (store/github.js).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.homedir(), '.mlmvpn', 'store', 'worker-live');
const TTL_MS = 30 * 60 * 1000;

/**
 * Where each panel's code lives upstream.
 *   release: the newest release's asset `asset`
 *   file:    `path` on `branch`, pinned to the branch's newest commit for the download
 */
const SOURCES = {
    bpb: { type: 'release', repo: 'bia-pain-bache/BPB-Worker-Panel', asset: 'worker.js' },
    edge: { type: 'file', repo: 'cmliu/edgetunnel', branch: 'main', path: '_worker.js' },
    zeus: { type: 'file', repo: 'panel-zeus/Z-E-U-S', branch: 'main', path: 'Source.js' },
    netra: { type: 'release', repo: 'netrair/netra-panel', asset: 'worker.js' },
    gozargah: { type: 'release', repo: 'panelgozargah/gozargah', asset: 'gozargah-worker.js' },
    spider: { type: 'file', repo: 'amirh00sain/SpiderPanel', branch: 'main', path: 'worker/worker.js' },
    nova: { type: 'file', repo: 'IRNova/Nova-Proxy', branch: 'main', path: 'worker.js', sha256From: 'version.json' },
    nahan: { type: 'file', repo: 'itsyebekhe/nahan', branch: 'main', path: '_worker.js' },
    // The project's own panel, as published in the Android repository (the legacy MLM panel —
    // Config Studio is Android-only). A Studio build landing there fails the catalogue fingerprint
    // and the copy this build ships (cloudflare-worker/mlm/worker.js) is used instead.
    mlm: { type: 'file', repo: 'mlmvpn/mlmvpn_android', branch: 'main', path: 'app/src/main/assets/mlm_worker.js' },
};

const mem = new Map();   // id → { at, result }
const inflight = new Map();
// id → { at, error } of the last time GitHub was ASKED, whatever the answer. `mem.at` is when good
// code was last READ; the two differ exactly when the developer's file stopped passing the check
// (MLM's path now carries a Config Studio build), and the store must say so rather than «2 days ago».
const tries = new Map();

function net() { return require('./net'); }
function sha256(t) { return crypto.createHash('sha256').update(t, 'utf8').digest('hex'); }

function cachePaths(id) {
    return { code: path.join(CACHE_DIR, id + '.js'), meta: path.join(CACHE_DIR, id + '.json') };
}
function readCache(id) {
    try {
        const p = cachePaths(id);
        const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
        const code = fs.readFileSync(p.code, 'utf8');
        if (sha256(code) !== meta.sha256) return null;
        return Object.assign({ code, from: 'cache' }, meta);
    } catch (e) { return null; }
}
function writeCache(id, r) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const p = cachePaths(id);
        fs.writeFileSync(p.code + '.tmp', r.code, 'utf8');
        fs.renameSync(p.code + '.tmp', p.code);
        fs.writeFileSync(p.meta, JSON.stringify({ version: r.version, ref: r.ref, repo: r.repo, sha256: sha256(r.code), at: Date.now() }, null, 1));
    } catch (e) { /* a cache, never a failure */ }
}

/** Newest commit id of a branch, from the public commits feed (no API). */
async function headCommit(repo, branch) {
    const r = await net().fetchText(`https://github.com/${repo}/commits/${encodeURIComponent(branch)}.atom`, { timeoutMs: 30000 });
    const m = r.text.match(/Commit\/([0-9a-f]{40})/) || r.text.match(/\/commit\/([0-9a-f]{40})/);
    if (!m) throw new Error('آخرین commit مخزن ' + repo + ' خوانده نشد');
    return m[1];
}

function catalogItem(id) {
    try { return require('./catalog').BY_ID[id] || null; } catch (e) { return null; }
}

/** Is this really the panel? The catalogue fingerprint, plus the source's own extra check. */
function validate(id, code) {
    const item = catalogItem(id);
    if (!code || code.length < 2000) throw new Error('فایل دریافتی خیلی کوچک بود');
    if (/^\s*<(!doctype|html)/i.test(code)) throw new Error('به‌جای کد، یک صفحهٔ HTML برگشت');
    if (item && typeof item.detect === 'function' && !item.detect(code)) {
        throw new Error('کد دریافتی شبیه «' + (item.title || id) + '» نیست — نصب نشد');
    }
    let version = null;
    try { version = item && item.versionOf ? item.versionOf(code) : null; } catch (e) { version = null; }
    return version;
}

async function fetchFresh(id) {
    const src = SOURCES[id];
    if (!src) throw new Error('منبع بالادستی برای «' + id + '» تعریف نشده');
    let code, ref;
    if (src.type === 'release') {
        const gh = require('./github');
        const rels = await gh.releases(src.repo);
        // The newest non-draft release (the atom feed never lists drafts); pre-releases are skipped
        // when a stable one exists, since a panel user is not a tester.
        const stable = rels.filter((r) => !/(alpha|beta|rc|pre)/i.test(r.tag + ' ' + r.title));
        const rel = stable[0] || rels[0];
        if (!rel) throw new Error('مخزن ' + src.repo + ' انتشاری ندارد');
        const url = `https://github.com/${src.repo}/releases/download/${encodeURIComponent(rel.tag)}/${encodeURIComponent(src.asset)}`;
        code = (await net().fetchText(url, { timeoutMs: 90000, maxBytes: 16 * 1024 * 1024 })).text;
        ref = rel.tag;
    } else {
        const sha = await headCommit(src.repo, src.branch);
        const url = `https://raw.githubusercontent.com/${src.repo}/${sha}/${src.path}`;
        code = (await net().fetchText(url, { timeoutMs: 90000, maxBytes: 16 * 1024 * 1024 })).text;
        ref = sha.slice(0, 12);
        if (src.sha256From) {
            // Nova publishes the digest of its obfuscated worker beside it, in the SAME commit; a
            // mismatch means a half-updated or tampered file, and nothing is installed.
            const vj = JSON.parse((await net().fetchText(`https://raw.githubusercontent.com/${src.repo}/${sha}/${src.sha256From}`, { timeoutMs: 30000 })).text);
            const want = String(vj.worker_sha256 || '').toLowerCase();
            const got = crypto.createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex');
            if (!want || want !== got) throw new Error('امضای SHA-256 کد با version.json سازنده یکی نیست — نصب نشد');
        }
    }
    if (code.charCodeAt(0) === 0xfeff) code = code.slice(1);
    const version = validate(id, code) || ref;
    // The digest and the time travel with the code (the disk cache already kept them): the store
    // compares a survey's `liveSha` against this one to see that the developer has published since.
    return { id, code, version, ref, repo: src.repo, from: 'upstream', sha256: sha256(code), at: Date.now() };
}

/**
 * The newest code for `id`: { code, version, ref, repo, from: 'upstream' | 'cache' }, or null
 * when neither GitHub nor the cache has a good copy (the caller then uses its bundled copy).
 * Remembered for 30 minutes; `force` asks GitHub again.
 */
async function latest(id, { force = false, log = () => {} } = {}) {
    const hit = mem.get(id);
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.result;
    if (inflight.has(id)) return inflight.get(id);
    const run = (async () => {
        try {
            const r = await fetchFresh(id);
            writeCache(id, r);
            log(`[Store] کد تازهٔ «${id}» از گیت‌هاب سازنده (${r.repo} @ ${r.ref}) — نسخهٔ ${r.version}`);
            mem.set(id, { at: Date.now(), result: r });
            tries.set(id, { at: Date.now(), error: '' });
            return r;
        } catch (e) {
            tries.set(id, { at: Date.now(), error: e.message });
            const c = readCache(id);
            log(`[Store] گرفتن کد تازهٔ «${id}» از گیت‌هاب نشد (${e.message})${c ? ` — آخرین نسخهٔ سالم ذخیره‌شده (${c.version}) استفاده می‌شود` : ' — نسخهٔ همراه برنامه استفاده می‌شود'}`);
            if (c) mem.set(id, { at: Date.now() - TTL_MS + 5 * 60 * 1000, result: c });
            return c;
        } finally { inflight.delete(id); }
    })();
    inflight.set(id, run);
    return run;
}

/**
 * The cached answer without waiting (null when nothing was fetched yet). A copy read from disk is
 * kept in memory under the time it was FETCHED, so the store's catalogue — read every 1.5 s while a
 * job runs — does not re-read and re-hash megabytes of panel code each time, and `latest()` still
 * treats it as exactly as old as it is.
 */
function peek(id) {
    const h = mem.get(id);
    if (h) return h.result;
    const c = readCache(id);
    if (c) mem.set(id, { at: c.at || 0, result: c });
    return c;
}

/** What is known about the newest code, without the code — for the store window. */
function meta(id) {
    const r = peek(id);
    const t = tries.get(id) || { at: 0, error: '' };
    if (!r) return t.at ? { version: null, ref: '', repo: '', sha256: '', at: 0, from: '', triedAt: t.at, error: t.error } : null;
    return { version: r.version, ref: r.ref, repo: r.repo, sha256: r.sha256 || sha256(r.code), at: r.at || 0, from: r.from, triedAt: t.at, error: t.error };
}

/**
 * The code to DEPLOY for `id`: the newest upstream copy, else `fallback()` (the bundled file).
 * @returns {Promise<{code, version, from, ref?}>}
 */
async function codeToDeploy(id, fallback, { log = () => {} } = {}) {
    const r = await latest(id, { log }).catch(() => null);
    if (r && r.code) return r;
    const code = typeof fallback === 'function' ? fallback() : fallback;
    return { code, version: null, from: 'bundle' };
}

module.exports = { SOURCES, latest, peek, meta, codeToDeploy, validate, headCommit, CACHE_DIR };
