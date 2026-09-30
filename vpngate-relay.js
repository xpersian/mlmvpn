// --- vpngate-relay.js — the VPN Gate list through the user's own Worker ---
//
// On many Iranian lines www.vpngate.net cannot be reached at all: the name resolves to the block
// page, and even by its real address a handshake naming it is reset (measured here 2026-09-29, the
// direct refresh failed in under a second). The Android app solved it with a tiny Worker on the
// user's own Cloudflare account that fetches the list from outside and caches it at the edge
// (cloudflare-worker/vpngate-relay/worker.js, the same file as Android's vpngate_relay_worker.js).
//
// Here: a relay already on the account is ADOPTED (the phone's, or one this app made), found by
// asking each «-rly» Worker for the list; only when there is none is one deployed — on the first
// account in the Cloud window, once, and remembered.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE = path.join(os.homedir(), '.mlmvpn', 'vpngate-relay.json');
const read = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return null; } };
const write = (v) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(v)); };

function firstAccount() {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        const list = typeof d.cf_accounts === 'string' ? JSON.parse(d.cf_accounts) : (d.cf_accounts || []);
        return list[0] || null;
    } catch (e) { return null; }
}

const gt = (url, opts) => require('./github-tunnel/gt-net').gtFetch(url, Object.assign({ timeoutMs: 45000 }, opts || {}));
const looksLikeList = (t) => typeof t === 'string' && t.includes('#HostName') && t.length > 10000;

/** The list from one relay address, or null. A new workers.dev name needs a few seconds. */
async function tryRelay(url, tries = 1, timeoutMs = 45000) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await gt(url, { timeoutMs });
            const t = await r.text();
            if (r.ok && looksLikeList(t)) return t;
        } catch (e) { /* next */ }
        if (i < tries - 1) await new Promise((z) => setTimeout(z, 4000));
    }
    return null;
}

/** A relay already on the account (any «-rly» Worker that serves the list), or null. */
async function adopt(cf, a, sub, log) {
    const id = await cf.accountId(a);
    const axios = require('axios');
    const list = (await axios.get(`https://api.cloudflare.com/client/v4/accounts/${id}/workers/scripts`, { headers: cf.headers(a), timeout: 20000 })).data;
    const names = ((list && list.result) || []).map((s) => s.id).filter((n) => /-rly$/.test(n));
    for (const n of names) {
        const url = `https://${n}.${sub}.workers.dev/vpngate`;
        log(`امتحان رلهٔ موجود ${n}…`);
        // 20 s each while searching: a relay that does not answer should not hold the refresh.
        const t = await tryRelay(url, 1, 20000);
        if (t) return { url, name: n, text: t };
    }
    return null;
}

/**
 * The VPN Gate CSV through the user's relay: the remembered one, else an adopted one, else a new one.
 * Throws with a readable reason when there is no Cloudflare account or nothing answers.
 */
async function fetchList(log = () => {}) {
    const have = read();
    if (have && have.url) {
        const t = await tryRelay(have.url, 2);
        if (t) return t;
        log('رلهٔ ذخیره‌شده جواب نداد؛ دوباره پیدا می‌شود…');
    }
    const acc = firstAccount();
    if (!acc) throw new Error('برای گرفتن فهرست از راه ورکر خودتان، اول در بخش ابری یک حساب کلادفلر اضافه کنید.');
    const cf = require('./cloud-panels')._cf;
    const a = cf.account(acc.id);
    const sub = await cf.subdomain(a);
    const found = await adopt(cf, a, sub, log).catch(() => null);
    if (found) { write({ url: found.url, name: found.name, accId: acc.id, adopted: true, at: Date.now() }); return found.text; }
    const name = cf.workerName('-rly');
    log('نصب ورکر رلهٔ فهرست VPN Gate روی حساب کلادفلر شما…');
    const code = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'vpngate-relay', 'worker.js'), 'utf8');
    await cf.upload(a, name, code, { compat: '2024-03-03' });
    await cf.enableWorkersDev(a, name);
    const url = `https://${name}.${sub}.workers.dev/vpngate`;
    write({ url, name, accId: acc.id, at: Date.now() });
    const t = await tryRelay(url, 5);
    if (!t) throw new Error('ورکر رله نصب شد ولی هنوز فهرست را نداد — چند دقیقهٔ دیگر دوباره «به‌روزرسانی» را بزنید.');
    return t;
}

/** Can a refresh go through a relay at all? (a Cloudflare account exists, or a relay is known) */
function available() { const h = read(); return !!((h && h.url) || firstAccount()); }

module.exports = { fetchList, read, looksLikeList, available };
