// --- GitHub Tunnel v2: the STABLE tunnels («تونل پایدار») ---
//
// A session's server is normally reached through Cloudflare QUICK tunnels (*.trycloudflare.com):
// Cloudflare's testing service — 200 requests in flight per tunnel, no SLA, a new random name
// every session. A NAMED tunnel has none of that, but normally needs a domain, which most users
// do not have. Workers VPC removes the need: the user's own Worker binds a named tunnel as a
// private network (a `vpc_network` binding) and reaches the runner through it — no domain, no
// public hostname, and the Worker is the only way in (cloudflare-worker/gt-broker/worker.js ›
// THE STABLE SLOTS). Measured 2026-09-23 through a real runner, from an Iranian line: 26 Mbit on
// one connection, 35 on four — 90% of the 39 Mbit line in the same minute; a new connection
// ~600 ms. Workers VPC is in open beta and free on every Workers plan.
//
// THREE tunnels, slots `a`, `b` and `c`. A session's runner runs the connector of ONE slot; the
// next session (make-before-break) takes another. Two runners on one tunnel would be replicas, and
// Cloudflare sends each request to the NEAREST replica, not to the one that holds the session.
// Quick tunnels stay as they were, beside the slot: a fallback and extra capacity.
//
// Where things live:
//   * Cloudflare — the three tunnels (remotely managed; no ingress, the Worker's binding routes),
//     and the Worker redeployed with GT_SLOT_A/B/C bindings (gt-broker-deploy.js reads
//     workerBindings() on EVERY deploy, so no later redeploy can drop them).
//   * GitHub — every account's repo holds the connector tokens as Actions secrets GT_SLOT_A/B/C:
//     encrypted at rest, masked in logs, read by the workflow at job start. They belong to a
//     slot, not to a session, so the job-start timing that rules secrets out for SESSION
//     credentials (gt-session-crypto.js) does not apply to them.
//   * here — the tunnel ids and the tokens, DPAPI-protected, so a GitHub account added later
//     gets its secrets without asking for the Cloudflare account again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'gt-slots.json');
// THREE, not two: the active session and the next one (make-before-break) hold two, and a slot
// whose session just ended stays taken for SLOT_RELEASE_MS — so «end, then start again» still finds
// a free one instead of falling back to quick tunnels for three minutes.
const SLOTS = ['a', 'b', 'c'];
const SECRET_NAME = { a: 'GT_SLOT_A', b: 'GT_SLOT_B', c: 'GT_SLOT_C' };
const BINDING_NAME = { a: 'GT_SLOT_A', b: 'GT_SLOT_B', c: 'GT_SLOT_C' };
// A session stays on its slot until GitHub has actually stopped its runner, and a cancel takes
// 35–95 s to complete (measured 2026-09-23). A slot whose last session ended more recently than
// this is treated as still taken.
const SLOT_RELEASE_MS = 3 * 60 * 1000;
const LIVE = ['SETTING_UP', 'STARTING', 'INSTALLING', 'CONNECTING_NETWORK', 'READY', 'ACTIVE', 'EXPIRING_SOON', 'STANDBY', 'ENDING'];

function load() {
    try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { return { enabled: false, slots: {}, secrets: {} }; }
}
function save(s) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(`${STORE_FILE}.tmp`, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
    return s;
}

/** What the panel shows. Never a token. */
function status() {
    const s = load();
    let accountsTotal = 0;
    try { accountsTotal = require('./gt-accounts').list().length; } catch (e) {}
    const slots = {};
    for (const k of SLOTS) if (s.slots && s.slots[k]) slots[k] = { tunnelId: s.slots[k].tunnelId, name: s.slots[k].name };
    return {
        enabled: !!s.enabled,
        accountName: s.accountName || '',
        slots,
        // How many GitHub accounts already carry the connector tokens; the rest get them before
        // their next session.
        accountsReady: Object.keys(s.secrets || {}).length,
        accountsTotal,
        createdAt: s.createdAt || 0,
        lastSlot: s.lastSlot || '',
    };
}

function isEnabled() {
    const s = load();
    return !!s.enabled && SLOTS.every((k) => s.slots && s.slots[k] && s.slots[k].tunnelId && s.slots[k].token);
}

/**
 * The Worker bindings for gt-broker-deploy.js — empty unless the slots exist, and (given the
 * account being deployed to) unless they live on that same Cloudflare account.
 */
function workerBindings(cfAccountId = null) {
    const s = load();
    if (!s.enabled) return [];
    if (cfAccountId && s.cfAccountId && s.cfAccountId !== cfAccountId) return [];
    return SLOTS.filter((k) => s.slots && s.slots[k] && s.slots[k].tunnelId)
        .map((k) => ({ type: 'vpc_network', name: BINDING_NAME[k], tunnel_id: s.slots[k].tunnelId }));
}

function tokenOf(s, k) {
    const { unprotect } = require('./gt-crypto');
    return unprotect((s.slots && s.slots[k] && s.slots[k].token) || '');
}

// ── Cloudflare ─────────────────────────────────────────────────────────────────────────
async function cf(creds, method, endpoint, body, { allowFail = false } = {}) {
    const { authHeaders } = require('./gt-broker-deploy');
    const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
        method,
        headers: { ...authHeaders(creds.token, creds.email), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if ((!res.ok || !data.success) && !allowFail) {
        const msg = (data.errors && data.errors[0] && data.errors[0].message) || `Cloudflare API error (${res.status})`;
        throw Object.assign(new Error(msg), { status: res.status });
    }
    return data;
}

async function accountIdOf(creds) {
    const d = await cf(creds, 'GET', '/accounts');
    const id = d.result && d.result[0] && d.result[0].id;
    if (!id) throw new Error('شناسهٔ حساب کلادفلر پیدا نشد. توکن/ایمیل را بررسی کنید.');
    return id;
}

/** An existing slot tunnel is reused when Cloudflare still has it; otherwise a new one. */
async function ensureTunnel(creds, accountId, prev, k, log) {
    if (prev && prev.tunnelId) {
        const d = await cf(creds, 'GET', `/accounts/${accountId}/cfd_tunnel/${prev.tunnelId}`, null, { allowFail: true });
        if (d.success && d.result && !d.result.deleted_at) return prev;
    }
    // Neutral on purpose — the same rule as the Worker's own name (gt-broker-deploy.js).
    const name = `gt-edge-${crypto.randomBytes(3).toString('hex')}-${k}`;
    const d = await cf(creds, 'POST', `/accounts/${accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' });
    let token = d.result && d.result.token;
    if (!token) token = (await cf(creds, 'GET', `/accounts/${accountId}/cfd_tunnel/${d.result.id}/token`)).result;
    if (!token) throw new Error('کلادفلر برای تونل پایدار کلید اتصال نداد.');
    log(`تونل پایدار ${k.toUpperCase()} روی حساب کلادفلر ساخته شد.`);
    const { protect } = require('./gt-crypto');
    return { tunnelId: d.result.id, name, token: protect(token) };
}

async function deleteTunnel(creds, accountId, tunnelId) {
    // A connector still attached (a runner that GitHub has not finished stopping) blocks the
    // delete: its connections go first, then the tunnel — retried while the runner lets go.
    for (let i = 0; i < 6; i++) {
        await cf(creds, 'DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`, null, { allowFail: true });
        const d = await cf(creds, 'DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, null, { allowFail: true });
        if (d.success) return true;
        const gone = await cf(creds, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, null, { allowFail: true });
        if (!gone.success || (gone.result && gone.result.deleted_at)) return true;
        await new Promise((r) => setTimeout(r, 5000));
    }
    return false;
}

// ── GitHub ─────────────────────────────────────────────────────────────────────────────
/**
 * The connector tokens on one account's repo, before that account runs a session with a slot.
 * Only what is missing is written; `force` rewrites (the tokens changed).
 */
async function ensureSecrets(accountId, { force = false, onLog } = {}) {
    const s = load();
    if (!isEnabled()) return false;
    const have = s.secrets && s.secrets[accountId];
    if (!force && have && have.gen === s.gen) return true;
    const accounts = require('./gt-accounts');
    const github = require('./gt-github');
    const token = accounts.token(accountId);
    if (!token) return false;
    const repo = await github.ensureRepo(token);
    for (const k of SLOTS) await github.setRepoSecret(token, repo.fullName, SECRET_NAME[k], tokenOf(s, k));
    const cur = load();
    cur.secrets = { ...(cur.secrets || {}), [accountId]: { at: Date.now(), repo: repo.fullName, gen: cur.gen } };
    save(cur);
    try { onLog && onLog(`کلیدهای تونل پایدار روی مخزن @${repo.owner} گذاشته شد.`); } catch (e) {}
    return true;
}

async function pushSecretsToAll(log) {
    const accounts = require('./gt-accounts');
    const out = { ok: 0, failed: [] };
    for (const a of accounts.list()) {
        try { if (await ensureSecrets(a.id, { onLog: log })) out.ok++; else out.failed.push(a.login); }
        catch (e) { out.failed.push(a.login); log(`کلیدهای تونل پایدار روی @${a.login} گذاشته نشد: ${String(e.message || e).slice(0, 120)}`); }
    }
    return out;
}

// ── setup / removal ────────────────────────────────────────────────────────────────────
/**
 * Everything the stable path needs, on the Cloudflare account the secure-network Worker is on:
 * two tunnels, the Worker redeployed with their bindings, the tokens on every GitHub account.
 * Safe to run again: live tunnels are reused, the rest is rewritten.
 */
async function setup({ email, token, accountName, onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (!token) throw new Error('حساب کلادفلر معتبر نیست.');
    const creds = { email, token };
    const brokerDeploy = require('./gt-broker-deploy');
    const bs = brokerDeploy.status();
    log('در حال بررسی حساب کلادفلر…');
    const accountId = await accountIdOf(creds);
    // The binding only reaches tunnels of the Worker's own account.
    if (bs.deployed && bs.cfAccountId && bs.cfAccountId !== accountId) {
        throw Object.assign(new Error('تونل پایدار باید روی همان حساب کلادفلری ساخته شود که «سرویس شبکهٔ امن» روی آن است. همان حساب را انتخاب کنید.'), { code: 'SLOTS_OTHER_ACCOUNT' });
    }
    const prev = load();
    const slots = {};
    for (const k of SLOTS) slots[k] = await ensureTunnel(creds, accountId, prev.cfAccountId === accountId ? (prev.slots || {})[k] : null, k, log);
    const sameTokens = SLOTS.every((k) => prev.slots && prev.slots[k] && prev.slots[k].tunnelId === slots[k].tunnelId);
    save({
        ...prev,
        enabled: true, cfAccountId: accountId, accountName: accountName || prev.accountName || '',
        slots, createdAt: prev.createdAt || Date.now(),
        // A new pair of tunnels means new tokens: every repo needs them again.
        gen: sameTokens && prev.gen ? prev.gen : crypto.randomBytes(4).toString('hex'),
        secrets: sameTokens ? (prev.secrets || {}) : {},
    });
    log('در حال به‌روزرسانی سرویس شبکهٔ امن با تونل‌های پایدار…');
    // workerBindings() now answers with every slot, and the redeploy includes them.
    await brokerDeploy.deployBroker({ email, token, accountName: accountName || bs.accountName || '', onLog });
    log('در حال گذاشتن کلیدهای اتصال روی مخزن گیت‌هاب…');
    const pushed = await pushSecretsToAll(log);
    log(pushed.failed.length
        ? `تونل پایدار آماده است؛ ${pushed.failed.length.toLocaleString('fa-IR')} حساب گیت‌هاب کلیدها را قبل از نشست بعدی‌شان می‌گیرند.`
        : 'تونل پایدار آماده است — از نشست بعدی به کار می‌رود.');
    return status();
}

/**
 * Takes everything down again: the Worker without the bindings, both tunnels, every secret.
 * Refused while a session is on a slot — its runner would lose the path under the user.
 */
async function remove({ email, token, accountName, onLog, sessions = [] } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (!token) throw new Error('حساب کلادفلر معتبر نیست.');
    const s = load();
    if (!s.enabled && !Object.keys(s.slots || {}).length) return status();
    if (sessions.some((x) => x.v2 && x.v2.slot && LIVE.includes(x.status))) {
        throw Object.assign(new Error('یک نشست ابری هنوز از تونل پایدار استفاده می‌کند. اول آن را تمام کنید.'), { code: 'SLOTS_IN_USE' });
    }
    const creds = { email, token };
    const accountId = await accountIdOf(creds);
    if (s.cfAccountId && s.cfAccountId !== accountId) {
        throw Object.assign(new Error('تونل‌های پایدار روی حساب کلادفلر دیگری هستند. همان حساب را انتخاب کنید.'), { code: 'SLOTS_OTHER_ACCOUNT' });
    }
    save({ ...s, enabled: false });
    const brokerDeploy = require('./gt-broker-deploy');
    if (brokerDeploy.status().deployed) {
        log('در حال به‌روزرسانی سرویس شبکهٔ امن بدون تونل پایدار…');
        await brokerDeploy.deployBroker({ email, token, accountName: accountName || s.accountName || '', onLog });
    }
    // A tunnel Cloudflare would not delete yet stays on record, so the next removal retries it.
    const left = {};
    for (const k of SLOTS) {
        const t = s.slots && s.slots[k];
        if (t && t.tunnelId && !(await deleteTunnel(creds, accountId, t.tunnelId))) {
            left[k] = t;
            log(`تونل پایدار ${k.toUpperCase()} هنوز پاک نشد؛ «برداشتن» را کمی بعد دوباره بزنید (یا از داشبورد کلادفلر پاکش کنید).`);
        }
    }
    const accounts = require('./gt-accounts');
    const github = require('./gt-github');
    for (const [id, rec] of Object.entries(s.secrets || {})) {
        const t = accounts.token(id);
        if (!t || !rec.repo) continue;
        for (const k of SLOTS) await github.deleteRepoSecret(t, rec.repo, SECRET_NAME[k]);
    }
    save({ enabled: false, slots: left, secrets: {}, ...(Object.keys(left).length ? { cfAccountId: accountId } : {}) });
    log('تونل پایدار برداشته شد؛ نشست‌ها مثل قبل فقط از تونل‌های موقت کلادفلر می‌روند.');
    return status();
}

// ── which slot a new session gets ──────────────────────────────────────────────────────
/**
 * The slot for the next session, or '' (quick tunnels only). Never one a live session holds,
 * nor one whose session ended less than SLOT_RELEASE_MS ago; between two free slots, the one
 * NOT used last — so a runner still being cancelled never shares a tunnel with a new one.
 */
function pickSlot(sessions = [], now = Date.now()) {
    if (!isEnabled()) return '';
    // The Worker must carry both bindings — a redeploy onto another account goes without them.
    try {
        const bound = require('./gt-broker-deploy').status().slotsBound || [];
        if (!SLOTS.every((k) => bound.includes(BINDING_NAME[k]))) return '';
    } catch (e) { return ''; }
    const s = load();
    const taken = new Set();
    for (const x of sessions) {
        const k = x && x.v2 && x.v2.slot;
        if (!SLOTS.includes(k)) continue;
        if (LIVE.includes(x.status)) taken.add(k);
        else if (x.endedAt && now - x.endedAt < SLOT_RELEASE_MS) taken.add(k);
        else if (!x.endedAt && x.createdAt && now - x.createdAt < SLOT_RELEASE_MS) taken.add(k);
    }
    const free = SLOTS.filter((k) => !taken.has(k));
    if (!free.length) return '';
    // Round the ring from the slot used last: the one after it that is free.
    const from = SLOTS.indexOf(s.lastSlot);
    for (let i = 1; i <= SLOTS.length; i++) {
        const k = SLOTS[(from + i + SLOTS.length) % SLOTS.length];
        if (free.includes(k)) return k;
    }
    return free[0];
}

function noteSlotUsed(k) {
    if (!SLOTS.includes(k)) return;
    const s = load();
    save({ ...s, lastSlot: k });
}

module.exports = {
    status, isEnabled, workerBindings, ensureSecrets, pushSecretsToAll, setup, remove, pickSlot, noteSlotUsed,
    SLOTS, SECRET_NAME, BINDING_NAME, SLOT_RELEASE_MS, STORE_FILE,
};
