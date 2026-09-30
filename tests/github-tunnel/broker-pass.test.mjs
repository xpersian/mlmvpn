// The broker Worker's v2 passthrough (/p/), driven through its REAL default export, with the
// pass signed by the desktop app's REAL signer (gt-secret.js › signPass).
//
// Why it exists: *.trycloudflare.com is blocked from Iranian lines by DNS and SNI (measured
// 2026-09-23), so v2 clients reach their session's quick tunnel through this Worker. It sits on
// a public hostname, so the properties that matter are the ones pinned here: it is not an open
// relay, it reaches exactly the one tunnel the pass names, a pass dies with its expiry, and a
// prober cannot tell the route exists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

// Sandbox the install secret before gt-secret.js reads the home directory.
const SANDBOX = path.join(HERE, 'home-pass');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
const require = createRequire(import.meta.url);
const secretMod = require(path.join(ROOT, 'github-tunnel', 'gt-secret.js'));
const SECRET = secretMod.getInstallSecret();

// Same copy-to-.mjs trick as broker-auth.test.mjs: the package is CommonJS.
const COPY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-worker-')), 'worker.mjs');
fs.copyFileSync(path.join(ROOT, 'cloudflare-worker', 'gt-broker', 'worker.js'), COPY);
const { default: worker } = await import(pathToFileURL(COPY).href);

const upstream = [];
globalThis.fetch = async (url, init = {}) => {
    upstream.push({ url: String(url), method: init.method, host: init.headers && init.headers.get && init.headers.get('host') });
    return new Response('from-origin', { status: 200 });
};
const env = { GT_SIGNING_SECRET: SECRET };
const call = (p, method = 'GET', headers = {}) => worker.fetch(new Request(`https://relay.test${p}`, { method, headers }), env);

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
const HOUR = 60 * 60 * 1000;
const good = secretMod.signPass('prot-homeland-disabilities-ada', 'GT-2026-a1b2c3d4', Date.now() + HOUR);

// 1. an authentic pass reaches exactly its tunnel, path and query intact, as a passthrough
{
    upstream.length = 0;
    const res = await call(`/p/${good}/AbCdEf123456?ed=2560`, 'GET', { Upgrade: 'websocket', Connection: 'Upgrade', Host: 'relay.test' });
    check('an authentic pass is forwarded', res.status === 200 && (await res.text()) === 'from-origin', String(res.status));
    check('…to exactly the tunnel it names, with path and query intact',
        upstream.length === 1 && upstream[0].url === 'https://prot-homeland-disabilities-ada.trycloudflare.com/AbCdEf123456?ed=2560', JSON.stringify(upstream));
    check('…without our Host header leaking into the upstream request', upstream[0] && !upstream[0].host, JSON.stringify(upstream));
}

// 2. a POST (the realm's control API) is forwarded too — only the pass decides
{
    upstream.length = 0;
    const res = await call(`/p/${good}/v1/realm`, 'POST');
    check('a non-upgrade request under a valid pass is forwarded', res.status === 200 && upstream.length === 1 && upstream[0].method === 'POST');
}

// 3. not an open relay
{
    upstream.length = 0;
    const forged = secretMod.signPass('x', 'y', 1).split('.')[0] + '.' + 'A'.repeat(43);
    const r1 = await call(`/p/${forged}/x`);
    const other = (() => {
        const payload = Buffer.from(JSON.stringify({ h: 'evil-tunnel', s: 's', e: Date.now() + HOUR })).toString('base64url');
        return `${payload}.${good.split('.')[1]}`;   // someone else's payload, our signature
    })();
    const r2 = await call(`/p/${other}/x`);
    const r3 = await call('/p/not-a-pass/x');
    check('a forged signature is a plain 404', r1.status === 404);
    check('a signature cannot be moved onto another payload', r2.status === 404);
    check('garbage under /p/ is a plain 404', r3.status === 404);
    check('none of them reached anything upstream', upstream.length === 0, JSON.stringify(upstream));
}

// 4. the pass cannot point anywhere but a quick tunnel label
{
    upstream.length = 0;
    const sneaky = [
        secretMod.signPass('evil.com#', 's', Date.now() + HOUR),
        secretMod.signPass('Evil-Upper', 's', Date.now() + HOUR),
        secretMod.signPass('a/b', 's', Date.now() + HOUR),
        secretMod.signPass('x.trycloudflare.com.evil', 's', Date.now() + HOUR),
    ];
    const codes = [];
    for (const p of sneaky) codes.push((await call(`/p/${p}/x`)).status);
    check('a label that is not a bare quick-tunnel label is refused, even when signed',
        codes.every((c) => c === 404) && upstream.length === 0, JSON.stringify(codes));
}

// 5. a pass dies with its expiry — and only an authentic one learns that
{
    upstream.length = 0;
    const expired = secretMod.signPass('prot-homeland-disabilities-ada', 'GT-2026-a1b2c3d4', Date.now() - 1000);
    const res = await call(`/p/${expired}/x`);
    const body = await res.json();
    check('an authentic but expired pass says EXPIRED so the app renews', res.status === 401 && body.code === 'EXPIRED', JSON.stringify(body));
    check('…and reaches nothing', upstream.length === 0);
}

// 6. another installation's secret
{
    const res = await worker.fetch(new Request(`https://relay.test/p/${good}/x`), { GT_SIGNING_SECRET: 'b'.repeat(64) });
    check('a pass from another installation is a 404 on this Worker', res.status === 404);
}

// 7. the rest of the Worker is unchanged
{
    const r1 = await call('/mint', 'GET');
    const r2 = await call('/anything-else', 'GET');
    check('non-/p/ GETs are still refused as before', r1.status === 405 && r2.status === 405);
    const r3 = await worker.fetch(new Request(`https://relay.test/p/${good}/x`), {});
    check('a Worker with no signing secret refuses to relay at all', r3.status === 503);
}

// 8. THE STABLE SLOTS: a pass naming slot a/b goes through that slot's Workers VPC binding,
//    to the runner's Xray on its own loopback — never to anything the pass could choose
{
    upstream.length = 0;
    const via = { a: [], b: [], c: [] };
    const bound = (name) => ({ fetch: async (url, init = {}) => { via[name].push({ url: String(url), method: init.method, host: init.headers && init.headers.get && init.headers.get('host') }); return new Response('from-slot-' + name, { status: 200 }); } });
    const slotEnv = { GT_SIGNING_SECRET: SECRET, GT_SLOT_A: bound('a'), GT_SLOT_B: bound('b'), GT_SLOT_C: bound('c') };
    const passA = secretMod.signSlotPass('a', 'GT-2026-a1b2c3d4', Date.now() + HOUR);
    const passB = secretMod.signSlotPass('b', 'GT-2026-a1b2c3d4', Date.now() + HOUR);
    const r1 = await worker.fetch(new Request(`https://relay.test/p/${passA}/AbCdEf123456?ed=2560`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', Host: 'relay.test' } }), slotEnv);
    check('a slot pass reaches ITS slot, on the runner\'s own Xray port, path and query intact',
        r1.status === 200 && (await r1.text()) === 'from-slot-a' && via.a.length === 1 && via.a[0].url === 'http://127.0.0.1:10001/AbCdEf123456?ed=2560' && !via.b.length, JSON.stringify(via));
    check('…without our Host header, and nothing went out to a quick tunnel', via.a[0] && !via.a[0].host && upstream.length === 0);
    const r2 = await worker.fetch(new Request(`https://relay.test/p/${passB}/x`), slotEnv);
    check('slot b is slot b', r2.status === 200 && via.b.length === 1);
    const r2c = await worker.fetch(new Request(`https://relay.test/p/${secretMod.signSlotPass('c', 'GT-2026-a1b2c3d4', Date.now() + HOUR)}/x`), slotEnv);
    check('…and slot c is slot c', r2c.status === 200 && via.c.length === 1 && via.a.length === 1 && via.b.length === 1);

    const both = (() => {
        const payload = Buffer.from(JSON.stringify({ h: 'prot-homeland-disabilities-ada', k: 'a', s: 's', e: Date.now() + HOUR })).toString('base64url');
        const crypto = require('node:crypto');
        return `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
    })();
    const odd = (() => {
        const payload = Buffer.from(JSON.stringify({ k: 'd', s: 's', e: Date.now() + HOUR })).toString('base64url');
        const crypto = require('node:crypto');
        return `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
    })();
    const codes = [(await worker.fetch(new Request(`https://relay.test/p/${both}/x`), slotEnv)).status, (await worker.fetch(new Request(`https://relay.test/p/${odd}/x`), slotEnv)).status];
    check('a pass naming both a quick tunnel and a slot, or a slot that does not exist, names nothing', codes.every((c) => c === 404) && via.a.length === 1 && via.b.length === 1 && upstream.length === 0, JSON.stringify(codes));

    const expired = secretMod.signSlotPass('a', 's', Date.now() - 1000);
    const r3 = await worker.fetch(new Request(`https://relay.test/p/${expired}/x`), slotEnv);
    check('an expired slot pass says EXPIRED and reaches nothing', r3.status === 401 && via.a.length === 1);

    const r4 = await worker.fetch(new Request(`https://relay.test/p/${passA}/x`), { GT_SIGNING_SECRET: SECRET });
    const b4 = await r4.json();
    check('a Worker deployed without the slots asks to be redeployed (503 NO_SLOT)', r4.status === 503 && b4.code === 'NO_SLOT', JSON.stringify(b4));
    const down = { GT_SIGNING_SECRET: SECRET, GT_SLOT_A: { fetch: async () => { throw new Error('ProxyError: destination_unavailable'); } } };
    const r5 = await worker.fetch(new Request(`https://relay.test/p/${passA}/x`), down);
    const b5 = await r5.json();
    check('no runner behind the slot yet is a 502 SLOT_DOWN — the far side, never «your line»', r5.status === 502 && b5.code === 'SLOT_DOWN', JSON.stringify(b5));
    let bad = null;
    try { secretMod.signSlotPass('d', 's', Date.now()); } catch (e) { bad = e; }
    check('the app will not even sign a pass for a slot that does not exist', !!bad);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
results.forEach((x) => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
const bad = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
