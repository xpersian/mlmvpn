// The v2 session hand-off, driven through the REAL createSession({ dataPlane: 'v2' }):
// the client's key goes out as a dispatch input, a fake runner seals its credentials to it with
// the REAL runner/seal.mjs, and the deployer opens, validates and stores them. GitHub is a fake
// at global.fetch; nothing leaves the machine and no runner is dispatched.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { pathToFileURL } = require('url');

const SANDBOX = path.join(__dirname, 'home-deployer-v2');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);
const HOME = path.join(SANDBOX, '.mlmvpn');

const GT = ROOT + '/github-tunnel';
const accounts = require(`${GT}/gt-accounts`);
const allocator = require(`${GT}/gt-allocator`);
const store = require(`${GT}/gt-config`);
const deployer = require(`${GT}/gt-deployer`);
const core = require(`${GT}/gt-core`);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const BROKER_FILE = path.join(HOME, 'github-tunnel-broker-deploy.json');
const setBroker = (o) => fs.writeFileSync(BROKER_FILE, JSON.stringify(o));

const UUID = crypto.randomUUID();
const HOSTS = [{ host: 'prot-homeland-disabilities-ada.trycloudflare.com' }, { host: 'abc-def-ghi.trycloudflare.com' }];

let REPO_PUB = '';   // the fake repo's Actions public key (set once libsodium is ready)
function world({ phase = 'ready', rev = 1, existing = null, slotReady = true } = {}) {
    const seen = { calls: [], pushed: [], dispatch: null, cancelled: 0, deletedSession: 0, broker: 0, secrets: 0, secretPuts: [] };
    // `existing`: a sealed file already in the repo (deleteSessionFile reads its sha first).
    let seal = existing;
    const runs = new Map();
    let nextRun = 9000;
    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = opts.method || 'GET';
        seen.calls.push(`${method} ${u}`);
        const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
        if (/workers\.dev|relay\.test/.test(u)) { seen.broker++; return json({}); }
        if (u.includes('/actions/secrets')) {
            seen.secrets++;
            if (u.endsWith('/public-key')) return json({ key: REPO_PUB, key_id: 'k1' });
            if (method === 'PUT') { seen.secretPuts.push(u.split('/actions/secrets/')[1]); return json({}, 201); }
            return json({ message: 'no' }, 404);
        }
        if (u.endsWith('/user')) return json({ login: 'acct1', name: 'acct1', type: 'User' });
        if (/\/repos\/[^/]+\/mlmvpn-cloud-tunnel$/.test(u)) return json({ full_name: 'acct1/mlmvpn-cloud-tunnel', name: 'mlmvpn-cloud-tunnel', default_branch: 'main' });
        if (u.includes('/contents/sessions/')) {
            if (method === 'DELETE') { seen.deletedSession++; return json({}); }
            if (!seal) return json({ message: 'Not Found' }, 404);
            if (method === 'GET' && u.includes('/contents/sessions/') && !opts.body) {
                return json({ content: Buffer.from(JSON.stringify(seal())).toString('base64'), sha: 's1' });
            }
        }
        if (u.includes('/contents/')) {
            if (method === 'PUT') { seen.pushed.push(decodeURIComponent(u.split('/contents/')[1])); return json({ content: {} }, 201); }
            return json({ message: 'Not Found' }, 404);
        }
        if (u.includes('/dispatches')) {
            seen.dispatch = { url: u, body: JSON.parse(opts.body) };
            runs.set(++nextRun, true);
            // The runner, sealing to the key it was handed.
            const inputs = seen.dispatch.body.inputs;
            const runnerSeal = await import(pathToFileURL(`${GT}/runner/seal.mjs`).href);
            seal = () => runnerSeal.seal(inputs.client_pub, inputs.session_id, {
                v: 2, rev, phase, hosts: HOSTS, wsPath: '/AbCdEf123456', uuids: { direct: UUID },
                xrayVersion: inputs.xray_version, runner: { ip: '52.1.2.3', country: 'MX', city: 'Querétaro', org: 'Microsoft' },
                errors: phase === 'failed' ? ['no quick tunnel came up'] : [],
                // The runner's word on the stable tunnel it was dispatched with (gt-agent.mjs).
                ...(inputs.slot ? { slot: { name: inputs.slot, ready: slotReady } } : {}),
            });
            return new Response(null, { status: 204, headers: { Date: new Date().toUTCString() } });
        }
        if (u.includes('/runs?')) {
            return json({ total_count: runs.size, workflow_runs: [...runs.keys()].map((id) => ({ id, status: 'queued', created_at: new Date().toISOString() })) });
        }
        if (/\/actions\/runs\/\d+\/cancel$/.test(u)) { seen.cancelled++; return json({}, 202); }
        if (/\/actions\/runs\/\d+$/.test(u)) {
            const id = Number(u.match(/\/runs\/(\d+)$/)[1]);
            return json({ id, status: 'in_progress', conclusion: null, run_started_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        }
        return json({ message: 'Not Found' }, 404);
    };
    return seen;
}

function reset() {
    fs.rmSync(accounts.STORE_FILE, { force: true });
    fs.rmSync(store.STORE_FILE, { force: true });
    accounts._tokenCache.clear();
    allocator._leases.clear();
}
function addAccount(login) {
    const { account } = accounts.upsert({ login, name: login, scopes: 'repo,workflow', token: `tok_${login}` });
    return accounts.get(account.id);
}

(async () => {
    // Poll faster than a real runner would need, so the suite stays quick.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 50), ...a);

    // ── the happy path ──────────────────────────────────────────────────────────
    reset();
    setBroker({ deployed: true, url: 'https://gt-relay-svc.test.workers.dev', authVersion: 3 });
    const a = addAccount('acct1');
    let seen = world();
    const logs = [];
    const session = await deployer.createSession({ dataPlane: 'v2', onLog: (m) => logs.push(m) });

    t('a v2 session is created READY and marked v2', session && session.status === 'READY' && session.dataPlane === 'v2', JSON.stringify(session && { status: session.status, dp: session.dataPlane }));
    t('no repository secret is ever touched', seen.secrets === 0);
    t('the broker is not called to mint anything', seen.broker === 0);
    t('the v2 workflow and every agent file are pushed',
        seen.pushed.includes('.github/workflows/mlmvpn-tunnel-v2.yml') && seen.pushed.includes('agent/gt-agent.mjs') && seen.pushed.includes('agent/seal.mjs')
        && seen.pushed.includes('agent/xray-config.mjs') && seen.pushed.includes('agent/exits.mjs'), JSON.stringify(seen.pushed));
    t('it dispatches the v2 workflow, not v1', /\/workflows\/mlmvpn-tunnel-v2\.yml\/dispatches$/.test(seen.dispatch.url));
    const inputs = seen.dispatch.body.inputs;
    t('the dispatch carries the session id, a raw X25519 public key and the client\'s core version',
        inputs.session_id === session.id && /^[A-Za-z0-9_-]{43}$/.test(inputs.client_pub) && inputs.xray_version === core.xrayVersion());
    t('the private half never leaves in the dispatch', !JSON.stringify(seen.dispatch.body).includes('"d"'));
    t('no exit country chosen: the runner is asked to start none', inputs.exits === '');

    const rec = store.getSession(session.id);
    t('the key is stored protected, not as a raw JWK', typeof rec.v2.sealKey === 'string' && !rec.v2.sealKey.includes('"d"'));
    t('what is stored from the runner is ciphertext', !JSON.stringify(rec.v2.sealed).includes(UUID) && !JSON.stringify(rec.v2.sealed).includes('trycloudflare'));
    t('…plus only what the panel may show: where the server is', rec.v2.runner.country === 'MX' && !('ip' in rec.v2.runner));
    t('the deadline is set from the run\'s start', rec.expiresAt > Date.now());
    const tr = core.transportFor(rec);
    t('the engine can open it and gets exactly what the runner sealed', tr.uuids.direct === UUID && tr.hosts.length === 2);
    t('the account that ran it stays healthy', accounts.get(a.id).health === accounts.HEALTH.OK || accounts.get(a.id).health === 'OK');
    t('the sealed file is left in the repo for later refreshes', seen.deletedSession === 0);

    // ── a runner that replaced a quick tunnel ───────────────────────────────────
    seen = world({ rev: 2 });
    // Re-point the fake at the same session and key, now publishing rev 2.
    const inputs2 = inputs;
    const runnerSeal = await import(pathToFileURL(`${GT}/runner/seal.mjs`).href);
    const oldFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
        if (String(url).includes('/contents/sessions/') && (opts.method || 'GET') === 'GET') {
            const body = runnerSeal.seal(inputs2.client_pub, inputs2.session_id, { v: 2, rev: 2, phase: 'ready', hosts: [{ host: 'new-tunnel-label.trycloudflare.com' }], wsPath: '/AbCdEf123456', uuids: { direct: UUID } });
            return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(body)).toString('base64'), sha: 's2' }), { status: 200 });
        }
        return oldFetch(url, opts);
    };
    const refreshed = await deployer.refreshTransport(store.getSession(session.id));
    t('refreshTransport picks up a newer revision the runner published', refreshed.v2.rev === 2 && core.transportFor(refreshed).hosts[0].host === 'new-tunnel-label.trycloudflare.com');
    const again = await deployer.refreshTransport(refreshed);
    t('…and ignores one it already has', again.v2.rev === 2);

    // ── the status channel: what the runner answers through the tunnel ─────────
    const statusSealed = runnerSeal.seal(inputs.client_pub, inputs.session_id, { v: 2, rev: 3, phase: 'ready', hosts: [{ host: 'third-host-label.trycloudflare.com' }], wsPath: '/AbCdEf123456', uuids: { direct: UUID }, endsAt: Date.now() + 600000, ending: true });
    const opened = core.openStatus(store.getSession(session.id), JSON.stringify(statusSealed));
    t('status channel: the runner\'s sealed answer opens with this session\'s key',
        opened && opened.payload.rev === 3 && opened.payload.ending === true && opened.payload.hosts[0].host === 'third-host-label.trycloudflare.com');
    const forged = JSON.parse(JSON.stringify(statusSealed));
    forged.ct = forged.ct.slice(0, -4) + (forged.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    let forgedErr = null;
    try { core.openStatus(store.getSession(session.id), JSON.stringify(forged)); } catch (e) { forgedErr = e; }
    t('…a tampered answer is refused, not trusted', !!forgedErr);
    t('…and a non-JSON answer is simply nothing', core.openStatus(store.getSession(session.id), '<html>nope</html>') === null);
    const agentSrc = fs.readFileSync(`${GT}/runner/gt-agent.mjs`, 'utf8');
    t('the runner replaces a tunnel Cloudflare stopped serving, not only a process that exited',
        /async function healthy\(t\)/.test(agentSrc) && /t\.misses >= HEALTH_MISSES/.test(agentSrc) && /t\.proc\.kill\('SIGKILL'\)/.test(agentSrc));
    t('the runner says its end is coming, early enough for the next session',
        /DEADLINE - Date\.now\(\) <= ENDING_LEAD_MS/.test(agentSrc) && /const ENDING_LEAD_MS = 12 \* 60 \* 1000/.test(agentSrc));
    t('the status server is loopback-only and serves the SEALED payload',
        /srv\.listen\(STATUS_PORT, '127\.0\.0\.1'\)/.test(agentSrc) && /seal\(CLIENT_PUB, SESSION_ID, \{ \.\.\.result, \.\.\.\(exitBroker \? exitBroker\.publicState\(\) : \{\}\), now: Date\.now\(\), \.\.\.extra \}\)/.test(agentSrc));
    t('…and answers only GET /s and the exit broker\'s two commands (/x, /x/stop); anything else is a 404',
        /if \(req\.method !== 'GET'\) \{ res\.writeHead\(404\); res\.end\(\); return; \}/.test(agentSrc)
        && /url\.pathname === '\/s'/.test(agentSrc) && /url\.pathname === '\/x' && exitBroker/.test(agentSrc) && /url\.pathname === '\/x\/stop' && exitBroker/.test(agentSrc));

    // ── the next session, made ready before this one ends ───────────────────────
    seen = world();
    const cur = store.getSession(session.id);
    const nextS = await deployer.createSession({ dataPlane: 'v2', standby: true, onLog: () => {} });
    t('a standby session ends in STANDBY, not READY', nextS && nextS.status === 'STANDBY', nextS && nextS.status);
    t('…so the session in use stays the active one until the swap', deployer.activeSession() && deployer.activeSession().id === cur.id);
    t('…and its account counts as busy', deployer.busyAccountIds().includes(nextS.accountId));
    deployer.promoteStandby(nextS, cur);
    t('the swap: the old one leaves the active set FIRST, the new one is active',
        store.getSession(cur.id).status === 'ENDING' && deployer.activeSession().id === nextS.id);
    deployer.demoteStandby(nextS, cur);
    t('a swap that would not carry traffic is undone: back on the old one',
        store.getSession(nextS.id).status === 'FAILED' && deployer.activeSession().id === cur.id && store.getSession(cur.id).status === 'EXPIRING_SOON');
    store.updateSession(cur.id, { status: 'READY' });

    // ── ending it ───────────────────────────────────────────────────────────────
    seen = world({ existing: () => store.getSession(session.id).v2.sealed });
    await deployer.endSession(store.getSession(session.id), () => {});
    t('ending a v2 session cancels its run and removes its sealed file, without the broker',
        seen.cancelled === 1 && seen.deletedSession === 1 && seen.broker === 0 && store.getSession(session.id).status === 'EXPIRED');

    // ── the relay must be ready BEFORE a runner is spent ────────────────────────
    reset();
    addAccount('acct1');
    setBroker({ deployed: false });
    seen = world();
    let err = null;
    try { await deployer.createSession({ dataPlane: 'v2' }); } catch (e) { err = e; }
    t('no relay deployed: refused with BROKER_NOT_DEPLOYED and nothing dispatched', err && err.code === 'BROKER_NOT_DEPLOYED' && !seen.dispatch, err && err.message);

    setBroker({ deployed: true, url: 'https://gt-relay-svc.test.workers.dev', authVersion: 2 });
    seen = world();
    err = null;
    try { await deployer.createSession({ dataPlane: 'v2' }); } catch (e) { err = e; }
    t('a relay without the passthrough: BROKER_NEEDS_UPDATE and nothing dispatched', err && err.code === 'BROKER_NEEDS_UPDATE' && !seen.dispatch, err && err.message);
    const acct = accounts.list()[0];
    t('…and the account is not blamed for it', acct.health !== accounts.HEALTH.EXHAUSTED && acct.health !== accounts.HEALTH.DISPATCH_FAILED, acct.health);

    // ── a runner that could not get a quick tunnel ──────────────────────────────
    reset();
    const b = addAccount('acct1');
    setBroker({ deployed: true, url: 'https://gt-relay-svc.test.workers.dev', authVersion: 3 });
    seen = world({ phase: 'failed' });
    err = null;
    try { await deployer.createSession({ dataPlane: 'v2' }); } catch (e) { err = e; }
    t('a runner that reports no tunnel fails with QT_UNAVAILABLE', err && err.code === 'QT_UNAVAILABLE', err && `${err.code} ${err.message}`);
    t('…its run is cancelled so it stops spending the allowance', seen.cancelled >= 1);
    t('…and the account is not marked broken for Cloudflare\'s refusal',
        ![accounts.HEALTH.EXHAUSTED, accounts.HEALTH.DISPATCH_FAILED, accounts.HEALTH.REPO_ERROR].includes(accounts.get(b.id).health), accounts.get(b.id).health);

    // ── THE STABLE TUNNEL (gt-slots.js): a slot per session, its secrets, the runner's word ──
    reset();
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    const repoKey = sodium.crypto_box_keypair();
    REPO_PUB = sodium.to_base64(repoKey.publicKey, sodium.base64_variants.ORIGINAL);
    const { protect } = require(`${GT}/gt-crypto`);
    const slotsMod = require(`${GT}/gt-slots`);
    fs.writeFileSync(slotsMod.STORE_FILE, JSON.stringify({
        enabled: true, cfAccountId: 'acc-1', gen: 'g1', secrets: {},
        slots: { a: { tunnelId: 'tun-a', name: 'gt-edge-000000-a', token: protect('tok-slot-a') }, b: { tunnelId: 'tun-b', name: 'gt-edge-000000-b', token: protect('tok-slot-b') }, c: { tunnelId: 'tun-c', name: 'gt-edge-000000-c', token: protect('tok-slot-c') } },
    }));
    setBroker({ deployed: true, url: 'https://gt-relay-svc.test.workers.dev', authVersion: 3, cfAccountId: 'acc-1', slotsBound: ['GT_SLOT_A', 'GT_SLOT_B', 'GT_SLOT_C'] });
    addAccount('acct1');
    seen = world();
    const sA = await deployer.createSession({ dataPlane: 'v2' });
    const inA = seen.dispatch.body.inputs;
    t('with the stable tunnel on, the session is dispatched with a slot', inA.slot === 'a' || inA.slot === 'b', JSON.stringify(inA));
    t('…after the connector tokens were put on this account\'s repo', ['GT_SLOT_A', 'GT_SLOT_B', 'GT_SLOT_C'].every((n) => seen.secretPuts.includes(n)), JSON.stringify(seen.secretPuts));
    const recA = store.getSession(sA.id);
    t('the session records its slot, and the runner\'s «connector up»', recA.v2.slot === inA.slot && recA.v2.slotReady === true, JSON.stringify({ slot: recA.v2.slot, ready: recA.v2.slotReady }));
    t('…and the engine sees a transport with that slot ready', core.transportFor(recA).slot && core.transportFor(recA).slot.name === inA.slot && core.transportFor(recA).slot.ready === true);

    seen = world();
    const sB = await deployer.createSession({ dataPlane: 'v2', standby: true });
    const inB = seen.dispatch.body.inputs;
    t('the next session (make-before-break) gets the OTHER slot', inB.slot && inB.slot !== inA.slot, `${inA.slot} → ${inB.slot}`);
    t('…and the secrets are not written again for the same account', seen.secretPuts.length === 0, JSON.stringify(seen.secretPuts));
    seen = world();
    const sC = await deployer.createSession({ dataPlane: 'v2', standby: true });
    const inC = seen.dispatch.body.inputs;
    t('a third live session takes the third slot', inC.slot && inC.slot !== inA.slot && inC.slot !== inB.slot && store.getSession(sC.id).v2.slot === inC.slot, JSON.stringify(inC));
    seen = world();
    const sD = await deployer.createSession({ dataPlane: 'v2', standby: true });
    t('all slots held by live sessions: a fourth goes without (quick tunnels only)', seen.dispatch.body.inputs.slot === '' && !(store.getSession(sD.id).v2.slot), JSON.stringify(seen.dispatch.body.inputs));
    await deployer.endSession(store.getSession(sD.id));
    await deployer.endSession(store.getSession(sB.id));
    t('an ended session records when, so its slot is not reused while GitHub is still stopping it', store.getSession(sB.id).endedAt > 0 && slotsMod.pickSlot(store.getSessions()) === '');

    store.setExitPrefs({ country: 'JP', provider: '', rules: [{ country: 'KR', provider: 'psiphon', domains: ['mexc.com'] }] });
    seen = world();
    await deployer.createSession({ dataPlane: 'v2', standby: true });
    t('the chosen countries ride the dispatch — the runner starts them at boot, before the client asks',
        seen.dispatch.body.inputs.exits === 'JP,KR:psiphon', JSON.stringify(seen.dispatch.body.inputs));
    store.setExitPrefs({ country: '', rules: [] });

    reset();
    addAccount('acct1');
    seen = world({ slotReady: false });
    const sE = await deployer.createSession({ dataPlane: 'v2' });
    t('a runner whose connector did not come up: the session still starts, on its quick tunnels', store.getSession(sE.id).status === 'READY' && store.getSession(sE.id).v2.slotReady === false);

    global.setTimeout = realSetTimeout;
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    module.exports = results;
    if (require.main === module) {
        results.forEach((x) => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter((x) => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})().catch((e) => { console.error(e); process.exit(1); });
