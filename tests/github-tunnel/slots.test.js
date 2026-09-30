// P3 — THE STABLE TUNNEL (github-tunnel/gt-slots.js): three named Cloudflare tunnels on the user's
// account, reached ONLY through the user's Worker as Workers VPC networks — no domain needed.
//
//   1. setup: three tunnels (neutral names), tokens kept DPAPI-protected, the Worker redeployed WITH
//      all three vpc_network bindings, the tokens on every GitHub account's repo as Actions secrets —
//      sealed so that only GitHub can open them (checked by opening them with the repo's key)
//   2. setup again: live tunnels reused, nothing rewritten
//   3. which slot a session gets: never one a live runner holds, nor one freed less than
//      SLOT_RELEASE_MS ago; round the ring from the last one used; none if the Worker lacks a binding
//   4. a GitHub account added later gets the secrets before its first session
//   5. the wrong Cloudflare account is refused; removal refused while a session is on a slot, and
//      otherwise takes EVERYTHING down (Worker without bindings, tunnels, secrets)
//
// Cloudflare and GitHub are fakes at global.fetch. Nothing leaves the machine.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SANDBOX = path.join(__dirname, 'home-slots');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);
const HOME = path.join(SANDBOX, '.mlmvpn');

const GT = ROOT + '/github-tunnel';
const accounts = require(`${GT}/gt-accounts`);
const slots = require(`${GT}/gt-slots`);
const brokerDeploy = require(`${GT}/gt-broker-deploy`);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const BROKER_FILE = path.join(HOME, 'github-tunnel-broker-deploy.json');

(async () => {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    const repoKey = sodium.crypto_box_keypair();   // the fake repo's Actions key pair
    const repoPub = sodium.to_base64(repoKey.publicKey, sodium.base64_variants.ORIGINAL);

    const cfState = { tunnels: new Map(), deleted: [], connectionsCleared: [], uploads: [], n: 0, acct: 'acc-1' };
    const gh = { secrets: new Map(), deletedSecrets: [], repoFor: (tok) => `${tok.replace('tok_', '')}/mlmvpn-cloud-tunnel` };
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = opts.method || 'GET';
        calls.push(`${method} ${u.replace('https://api.cloudflare.com/client/v4', 'CF').replace('https://api.github.com', 'GH')}`);
        const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
        const cf = (result) => json({ success: true, errors: [], result });
        // ── Cloudflare ──
        if (u === 'https://api.cloudflare.com/client/v4/accounts') return cf([{ id: cfState.acct, name: 'mine' }]);
        let m = u.match(/\/accounts\/([^/]+)\/cfd_tunnel$/);
        if (m && method === 'POST') {
            const body = JSON.parse(opts.body);
            const id = `tun-${++cfState.n}`;
            cfState.tunnels.set(id, { id, name: body.name, config_src: body.config_src, token: `connector-token-${id}` });
            return cf({ id, name: body.name, token: `connector-token-${id}` });
        }
        m = u.match(/\/cfd_tunnel\/([^/]+)\/connections$/);
        if (m && method === 'DELETE') { cfState.connectionsCleared.push(m[1]); return cf(null); }
        m = u.match(/\/cfd_tunnel\/([^/?]+)$/);
        if (m && method === 'GET') { const x = cfState.tunnels.get(m[1]); return x ? cf({ id: x.id, name: x.name, deleted_at: null }) : json({ success: false, errors: [{ message: 'not found' }] }, 404); }
        if (m && method === 'DELETE') { cfState.tunnels.delete(m[1]); cfState.deleted.push(m[1]); return cf(null); }
        m = u.match(/\/workers\/scripts\/([^/]+)$/);
        if (m && method === 'PUT') {
            const meta = JSON.parse(await opts.body.get('metadata').text());
            cfState.uploads.push({ name: m[1], meta, code: await opts.body.get('worker.js').text() });
            return cf({ id: m[1] });
        }
        if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(u)) return cf({ enabled: true });
        if (/\/workers\/subdomain$/.test(u)) return cf({ subdomain: 'mine22' });
        // ── GitHub ──
        const tok = String((opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '').replace('Bearer ', '');
        if (u === 'https://api.github.com/user') return json({ login: tok.replace('tok_', ''), name: 'x', type: 'User' });
        m = u.match(/\/repos\/([^/]+)\/mlmvpn-cloud-tunnel$/);
        if (m) return json({ full_name: `${m[1]}/mlmvpn-cloud-tunnel`, name: 'mlmvpn-cloud-tunnel', default_branch: 'main' });
        if (u.endsWith('/actions/secrets/public-key')) return json({ key: repoPub, key_id: 'k1' });
        m = u.match(/\/repos\/([^/]+\/[^/]+)\/actions\/secrets\/([A-Z_]+)$/);
        if (m && method === 'PUT') { gh.secrets.set(`${m[1]}:${m[2]}`, JSON.parse(opts.body)); return json({}, 201); }
        if (m && method === 'DELETE') { gh.secrets.delete(`${m[1]}:${m[2]}`); gh.deletedSecrets.push(`${m[1]}:${m[2]}`); return new Response(null, { status: 204 }); }
        return json({ message: 'Not Found' }, 404);
    };
    const opened = (repo, name) => {
        const s = gh.secrets.get(`${repo}:${name}`);
        if (!s) return null;
        return sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(s.encrypted_value, sodium.base64_variants.ORIGINAL), repoKey.publicKey, repoKey.privateKey));
    };

    accounts.upsert({ login: 'acct1', name: 'acct1', scopes: 'repo,workflow', token: 'tok_acct1' });
    accounts.upsert({ login: 'acct2', name: 'acct2', scopes: 'repo,workflow', token: 'tok_acct2' });
    fs.writeFileSync(BROKER_FILE, JSON.stringify({ deployed: true, url: 'https://gt-relay-svc.mine22.workers.dev', authVersion: 3, accountName: 'mine' }));
    const creds = { email: 'me@example.com', token: 'k'.repeat(37) };
    const logs = [];

    // ════ 1. setup ════
    t('nothing is enabled before setup, and no slot is ever picked', !slots.isEnabled() && slots.pickSlot([]) === '');
    const st = await slots.setup({ ...creds, accountName: 'mine', onLog: (m) => logs.push(m) });
    const tunnels = [...cfState.tunnels.values()];
    t('three tunnels are made on the Worker\'s own account, remotely managed', tunnels.length === 3 && tunnels.every((x) => x.config_src === 'cloudflare'), JSON.stringify(tunnels));
    t('…with neutral names (no vpn/proxy/tunnel words, per Cloudflare\'s risk scoring)', tunnels.every((x) => /^gt-edge-[0-9a-f]{6}-[abc]$/.test(x.name) && !/vpn|proxy|tunnel/i.test(x.name)), tunnels.map((x) => x.name).join());
    const onDisk = fs.readFileSync(slots.STORE_FILE, 'utf8');
    t('the connector tokens are not kept readable on disk', !onDisk.includes('connector-token-'), onDisk.slice(0, 200));
    const up = cfState.uploads[cfState.uploads.length - 1];
    const vpc = (up && up.meta.bindings || []).filter((b) => b.type === 'vpc_network');
    t('the Worker is redeployed WITH all three tunnels as Workers VPC networks',
        up && up.name === 'gt-relay-svc' && vpc.length === 3 && ['a', 'b', 'c'].every((k) => vpc.some((b) => b.name === `GT_SLOT_${k.toUpperCase()}` && b.tunnel_id === st.slots[k].tunnelId)), JSON.stringify(up && up.meta.bindings));
    t('…keeping its signing secret beside them', up.meta.bindings.some((b) => b.name === 'GT_SIGNING_SECRET' && b.type === 'secret_text'));
    t('…and the deployed code is the one with the slot route', /const WORKER_VERSION = 4;/.test(up.code) && /GT_SLOT_A/.test(up.code));
    const bs = brokerDeploy.status();
    t('the broker record now says which account and which slots it carries', bs.cfAccountId === 'acc-1' && ['GT_SLOT_A', 'GT_SLOT_B', 'GT_SLOT_C'].every((n) => bs.slotsBound.includes(n)), JSON.stringify(bs));
    t('every GitHub account\'s repo gets all three connector tokens as Actions secrets',
        opened('acct1/mlmvpn-cloud-tunnel', 'GT_SLOT_A') === `connector-token-${st.slots.a.tunnelId}` && opened('acct1/mlmvpn-cloud-tunnel', 'GT_SLOT_B') === `connector-token-${st.slots.b.tunnelId}`
        && opened('acct1/mlmvpn-cloud-tunnel', 'GT_SLOT_C') === `connector-token-${st.slots.c.tunnelId}`
        && opened('acct2/mlmvpn-cloud-tunnel', 'GT_SLOT_A') === `connector-token-${st.slots.a.tunnelId}`, [...gh.secrets.keys()].join());
    t('…sealed to the repo\'s key (nothing readable in transit)', [...gh.secrets.values()].every((s) => !String(s.encrypted_value).includes('connector-token') && s.key_id === 'k1'));
    t('status: enabled, all three slots, both accounts ready — never a token', st.enabled && st.slots.a && st.slots.b && st.slots.c && st.accountsReady === 2 && !JSON.stringify(st).includes('token'), JSON.stringify(st));
    t('…and it is said', logs.some((l) => /تونل پایدار آماده است/.test(l)));

    // ════ 2. again ════
    const postsBefore = calls.filter((c) => /^POST CF\/accounts\/[^/]+\/cfd_tunnel$/.test(c)).length;
    const putsBefore = calls.filter((c) => /^PUT GH.*\/actions\/secrets\//.test(c)).length;
    await slots.setup({ ...creds, accountName: 'mine' });
    t('setup again reuses the live tunnels', calls.filter((c) => /^POST CF\/accounts\/[^/]+\/cfd_tunnel$/.test(c)).length === postsBefore && cfState.tunnels.size === 3);
    t('…and does not rewrite secrets that are already right', calls.filter((c) => /^PUT GH.*\/actions\/secrets\//.test(c)).length === putsBefore);

    // ════ 3. which slot ════
    const now = Date.now();
    const s = (slot, status, extra = {}) => ({ id: `S-${Math.random()}`, status, createdAt: now - 3600e3, v2: { slot }, ...extra });
    slots.noteSlotUsed('a');
    t('all free: the one AFTER the slot used last (a runner being cancelled never shares a tunnel)', slots.pickSlot([], now) === 'b');
    t('a live session holds its slot: the ring skips it', slots.pickSlot([s('b', 'READY')], now) === 'c' && slots.pickSlot([s('b', 'READY'), s('c', 'STANDBY')], now) === 'a');
    t('…all three held: no slot, quick tunnels only', slots.pickSlot([s('a', 'READY'), s('b', 'STANDBY'), s('c', 'READY')], now) === '');
    t('«end, then start again»: the active and the next hold two, the just-ended one is still taken — the THIRD is free',
        slots.pickSlot([s('b', 'EXPIRED', { endedAt: now - 20e3 }), s('c', 'READY')], now) === 'a');
    t('a slot freed less than SLOT_RELEASE_MS ago is still taken (GitHub takes up to ~95 s to stop a run)',
        slots.pickSlot([s('a', 'READY'), s('c', 'STANDBY'), s('b', 'EXPIRED', { endedAt: now - 60e3 })], now) === '');
    t('…and free again after it', slots.pickSlot([s('a', 'READY'), s('c', 'STANDBY'), s('b', 'EXPIRED', { endedAt: now - slots.SLOT_RELEASE_MS - 1000 })], now) === 'b');
    const saved = JSON.parse(fs.readFileSync(BROKER_FILE, 'utf8'));
    fs.writeFileSync(BROKER_FILE, JSON.stringify({ ...saved, slotsBound: ['GT_SLOT_A', 'GT_SLOT_B'] }));
    t('a Worker that does not carry EVERY binding gets no slot sessions', slots.pickSlot([], now) === '');
    fs.writeFileSync(BROKER_FILE, JSON.stringify(saved));

    // ════ 4. an account added later ════
    const { account: late } = accounts.upsert({ login: 'acct3', name: 'acct3', scopes: 'repo,workflow', token: 'tok_acct3' });
    t('a GitHub account added later has no secrets yet', !opened('acct3/mlmvpn-cloud-tunnel', 'GT_SLOT_A'));
    const okLate = await slots.ensureSecrets(late.id);
    t('…it gets them before its first slot session, without the Cloudflare account', okLate && opened('acct3/mlmvpn-cloud-tunnel', 'GT_SLOT_B') === `connector-token-${st.slots.b.tunnelId}`);

    // ════ 5. the wrong account; removal ════
    cfState.acct = 'acc-OTHER';
    let err = null;
    try { await slots.setup({ ...creds }); } catch (e) { err = e; }
    t('setup on another Cloudflare account than the Worker\'s is refused (a VPC binding reaches its own account only)', err && err.code === 'SLOTS_OTHER_ACCOUNT', err && err.message);
    cfState.acct = 'acc-1';

    err = null;
    try { await slots.remove({ ...creds, sessions: [s('a', 'READY')] }); } catch (e) { err = e; }
    t('removal is refused while a session rides a slot', err && err.code === 'SLOTS_IN_USE' && cfState.tunnels.size === 3);
    const ids = [st.slots.a.tunnelId, st.slots.b.tunnelId, st.slots.c.tunnelId];
    const after = await slots.remove({ ...creds, sessions: [s('a', 'EXPIRED', { endedAt: now - 3600e3 })] });
    const last = cfState.uploads[cfState.uploads.length - 1];
    t('removal redeploys the Worker WITHOUT the bindings', last && !last.meta.bindings.some((b) => b.type === 'vpc_network') && last.meta.bindings.some((b) => b.name === 'GT_SIGNING_SECRET'), JSON.stringify(last && last.meta.bindings));
    t('…deletes all three tunnels, their connections first', ids.every((id) => cfState.deleted.includes(id) && cfState.connectionsCleared.includes(id)) && cfState.tunnels.size === 0);
    t('…and every secret on every repo it put them on', ['acct1', 'acct2', 'acct3'].every((a) => ['A', 'B', 'C'].every((k) => !gh.secrets.has(`${a}/mlmvpn-cloud-tunnel:GT_SLOT_${k}`))), [...gh.secrets.keys()].join());
    t('…leaving nothing enabled', !after.enabled && !slots.isEnabled() && slots.pickSlot([]) === '' && brokerDeploy.status().slotsBound.length === 0);

    // ════ 6. the runner half (read from the files that are pushed to the repo) ════
    const wf = require(`${GT}/gt-workflow-template`).buildWorkflowYamlV2();
    t('the workflow takes the slot as an optional input', /\n      slot:\n        description: '[^']*'\n        required: false\n        type: string\n        default: ''/.test(wf));
    t('…and hands the agent the connector tokens as SECRETS (masked), never as inputs',
        /SLOT: \$\{\{ inputs\.slot \}\}/.test(wf) && ['A', 'B', 'C'].every((k) => wf.includes(`GT_SLOT_${k}: \${{ secrets.GT_SLOT_${k} }}`)) && !/inputs\.[a-z_]*token/i.test(wf));
    const agent = fs.readFileSync(`${GT}/runner/gt-agent.mjs`, 'utf8');
    t('the agent takes only its own slot\'s token, and clears all of them from its environment before anything starts',
        /const SLOT_TOKEN = SLOT \? String\(process\.env\[`GT_SLOT_\$\{SLOT\.toUpperCase\(\)\}`\] \|\| ''\) : '';\s*delete process\.env\.GT_SLOT_A;\s*delete process\.env\.GT_SLOT_B;\s*delete process\.env\.GT_SLOT_C;/.test(agent));
    t('…the connector gets it in ITS environment (TUNNEL_TOKEN), never on a command line',
        /spawn\(CF, \['tunnel', '--no-autoupdate', '--metrics', `127\.0\.0\.1:\$\{SLOT_METRICS\}`, 'run'\],\s*\{ stdio: \['ignore', out, out\], env: \{ \.\.\.process\.env, TUNNEL_TOKEN: SLOT_TOKEN \} \}\)/.test(agent));
    t('…ready means cloudflared\'s own /ready, and the session is usable through either path',
        /\/ready`/.test(agent) && /const usable = \(\) => result\.hosts\.length > 0 \|\| !!\(result\.slot && result\.slot\.ready\);/.test(agent));
    t('…and the supervisor restarts a connector that died or stopped answering', /stable tunnel connector died; restarting/.test(agent) && /stable tunnel stopped answering; restarting its connector/.test(agent));

    fs.rmSync(SANDBOX, { recursive: true, force: true });
    module.exports = results;
    if (require.main === module) {
        results.forEach((x) => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter((x) => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exitCode = bad ? 1 : 0;
        setTimeout(() => process.exit(bad ? 1 : 0), 50).unref();
    }
})().catch((e) => { console.error(e); process.exit(1); });
