// --- warp-id-relay.js — WARP registration through the user's own Worker ---
//
// Android 1.2.36 › ۵ («وارپ مستقل»). A WARP identity is a device registered with
// api.cloudflareclient.com, and Iran filters that host — even a fragmented ClientHello, because the
// filter reassembles it. So registration goes: DIRECT first, then THROUGH THE USER'S OWN WORKER
// (cloudflare-worker/warp-id/worker.js: only /v0aNNNN/reg[/id], only under a random KEY; anyone
// else gets 404). The disguised front used to go first on the phone and wasted ~50 s in timeouts.
// A 429 / error 1015 from the Worker route is Cloudflare rate-limiting registrations that come
// from Workers (about 3 minutes); it is retried once after a pause and named as what it is.
//
// The Worker is deployed on the first Cloudflare account in the Cloud window, once, and remembered.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATE = path.join(os.homedir(), '.mlmvpn', 'warp-id-relay.json');
const read = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return null; } };
const write = (v) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(v)); };

function firstAccount() {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        const list = typeof d.cf_accounts === 'string' ? JSON.parse(d.cf_accounts) : (d.cf_accounts || []);
        return list[0] || null;
    } catch (e) { return null; }
}

/** The relay's base address (`https://x.y.workers.dev/<KEY>`), deploying it when there is none. */
async function ensure(log = () => {}) {
    const have = read();
    if (have && have.base) return have.base;
    const acc = firstAccount();
    if (!acc) throw new Error('برای ثبت از راه ورکر، اول در بخش ابری یک حساب کلادفلر اضافه کنید.');
    const cf = require('./cloud-panels')._cf;
    const a = cf.account(acc.id);
    const sub = await cf.subdomain(a);
    const name = cf.workerName('-wid');
    const key = crypto.randomBytes(12).toString('hex');
    log('نصب ورکر رلهٔ ثبت وارپ روی حساب کلادفلر شما…');
    const code = fs.readFileSync(path.join(__dirname, 'cloudflare-worker', 'warp-id', 'worker.js'), 'utf8');
    await cf.upload(a, name, code, { bindings: [{ type: 'secret_text', name: 'KEY', text: key }] });
    await cf.enableWorkersDev(a, name);
    const base = `https://${name}.${sub}.workers.dev/${key}`;
    write({ base, name, accId: acc.id, at: Date.now() });
    return base;
}

/** fetch() through the Worker route: `apiUrl` is the api.cloudflareclient.com address it replaces. */
async function relayFetch(apiUrl, opts, log) {
    const base = await ensure(log);
    const u = new URL(apiUrl);
    const target = base + u.pathname + u.search;
    const gt = require('./github-tunnel/gt-net').gtFetch;
    // A new workers.dev name answers after a few seconds.
    let last = null;
    for (let i = 0; i < 4; i++) {
        try {
            const r = await gt(target, Object.assign({}, opts, { signal: undefined, timeoutMs: 20000 }));
            if (r.status === 404 && i < 3) { await new Promise((z) => setTimeout(z, 3000)); continue; }
            return r;
        } catch (e) { last = e; await new Promise((z) => setTimeout(z, 3000)); }
    }
    throw last || new Error('ورکر رله جواب نداد');
}

module.exports = { ensure, relayFetch, read };
