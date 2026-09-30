// --- GitHub Tunnel session store ---
// Owns `~/.mlmvpn/github-tunnel.json`: GitHub connection state + the history/current
// state of provisioned Cloud Sessions (ephemeral Windows runner + Tailscale relay).
//
// Nothing here is VM-durable — the whole point (see gt-deployer.js) is that every
// session is disposable and rebuilt from scratch. Only *metadata about* sessions lives
// here, never anything the runner itself needs to keep alive.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'github-tunnel.json');

const SESSION_LIFETIME_MS = 6 * 60 * 60 * 1000; // 6h, matches the workflow's own timeout-minutes

function load() {
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[github-tunnel] store read failed (${e.message}) — starting empty`);
    }
    return {
        repo: stored.repo || null,          // { fullName, owner, name, defaultBranch }
        sessions: Array.isArray(stored.sessions) ? stored.sessions : [],
        // Which data plane NEW sessions use: 'v2' (Xray through the user's Worker to Cloudflare
        // quick tunnels) or 'v1' (Tailscale/WireGuard). Kept so v1 stays one switch away until
        // v2 has replaced it everywhere; a session keeps the plane it was created with.
        dataPlane: stored.dataPlane === 'v1' ? 'v1' : 'v2',
        // «روشن کردن دیوارآتش ویندوز فقط هنگام اتصال» — the user's explicit yes to switching a
        // firewall they had turned OFF on for the full tunnel's lifetime (gt-guard.js › WHEN
        // WINDOWS FIREWALL IS OFF). Never assumed: off unless they said so.
        firewallAutoEnable: stored.firewallAutoEnable === true,
        // «تمدید خودکار بی‌وقفه»: while the tunnel is IN USE, the next session is made ready before
        // this one ends and swapped in with one short reconnect; a runner lost mid-session is
        // replaced the same way. On unless switched off — an idle tunnel is never renewed.
        autoRenew: stored.autoRenew !== false,
        // THE EXIT COUNTRY (P4, runner/exits.mjs), chosen by the user and brought up on every
        // session's runner: '' = «حداکثر سرعت» (the runner's own address); a country code
        // otherwise. The provider is '' (automatic: VPN Gate where it has the country, else
        // Psiphon) unless the user picked one. `exitRules`: sites that leave by another country.
        exit: normalizeExitPrefs(stored.exit),
    };
}

/** Only what can be acted on survives a read: codes, a known provider, plain domain names. */
function normalizeExitPrefs(x) {
    const cc = (v) => (typeof v === 'string' && /^[A-Z]{2}$/.test(v.toUpperCase()) ? v.toUpperCase() : '');
    const prov = (v) => (v === 'vpngate' || v === 'psiphon' ? v : '');
    const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
    const src = x && typeof x === 'object' ? x : {};
    const rules = [];
    for (const r of Array.isArray(src.rules) ? src.rules : []) {
        const country = cc(r && r.country);
        const domains = [...new Set((r && Array.isArray(r.domains) ? r.domains : [])
            .map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/^www\./, ''))
            .filter((d) => DOMAIN.test(d)))].slice(0, 200);
        if (country && domains.length) rules.push({ country, provider: prov(r.provider), domains });
    }
    return { country: cc(src.country), provider: prov(src.provider), rules: rules.slice(0, 5) };
}

function getExitPrefs() { return load().exit; }
function setExitPrefs(patch = {}) {
    const cfg = load();
    cfg.exit = normalizeExitPrefs({ ...cfg.exit, ...patch });
    save(cfg);
    return cfg.exit;
}

function getAutoRenew() { return load().autoRenew; }
function setAutoRenew(v) {
    const cfg = load();
    cfg.autoRenew = v !== false;
    save(cfg);
    return cfg.autoRenew;
}

function getFirewallAutoEnable() { return load().firewallAutoEnable; }
function setFirewallAutoEnable(v) {
    const cfg = load();
    cfg.firewallAutoEnable = v === true;
    save(cfg);
    return cfg.firewallAutoEnable;
}

function getDataPlane() { return load().dataPlane; }
function setDataPlane(v) {
    const cfg = load();
    cfg.dataPlane = v === 'v1' ? 'v1' : 'v2';
    save(cfg);
    return cfg.dataPlane;
}

function save(cfg) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return cfg;
}

function setRepo(repo) {
    const cfg = load();
    cfg.repo = repo;
    save(cfg);
    return repo;
}

function getRepo() {
    return load().repo;
}

function genSessionId() {
    const year = new Date().getFullYear();
    return `GT-${year}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Shape of one session:
 *   { id, workflowRunId, repository, status, createdAt, expiresAt,
 *     tailscaleIp, tailscaleNodeId, rdp: { host, port, username, password },
 *     lastError, log: [{ t, msg }] }
 */
function addSession(fields = {}) {
    const cfg = load();
    const session = {
        id: fields.id || genSessionId(),
        workflowRunId: fields.workflowRunId || null,
        repository: fields.repository || (cfg.repo && cfg.repo.fullName) || '',
        // WHICH GitHub account owns this session. Written once, at creation, and never
        // changed — every later operation (monitor, reconcile, cancel, cleanup) resolves
        // its credential from here. Without it, "cancel this session" means "cancel it with
        // whatever token is lying around", which with a pool is a different account's.
        accountId: fields.accountId || '',
        accountLogin: fields.accountLogin || '',
        status: fields.status || 'SETTING_UP',
        // Sessions from before v2 have no field and are v1 by definition.
        dataPlane: fields.dataPlane === 'v2' ? 'v2' : 'v1',
        createdAt: Date.now(),
        expiresAt: null,
        tailscaleIp: '',
        tailscaleNodeId: '',
        rdp: null,
        clientKey: fields.clientKey || "",
        lastError: '',
    };
    cfg.sessions.unshift(session);
    // Only the newest 20 are ever shown, and nothing reads older ones. Keeping every session
    // ever created just grows this file forever on a machine that renews daily.
    if (cfg.sessions.length > 20) cfg.sessions.length = 20;
    save(cfg);
    return session;
}

function updateSession(id, patch = {}) {
    const cfg = load();
    const idx = cfg.sessions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    // accountId is identity, like id and createdAt: a session cannot change which account
    // owns it, and allowing a patch to rewrite it would silently break session affinity in
    // the one direction nothing downstream could detect.
    const { id: _i, createdAt: _c, accountId: _a, ...safe } = patch;
    cfg.sessions[idx] = { ...cfg.sessions[idx], ...safe };
    save(cfg);
    return cfg.sessions[idx];
}

function getSession(id) {
    return load().sessions.find(s => s.id === id) || null;
}

function getActiveSession() {
    // The deadline was written against GitHub's clock (gt-deployer), so it has to be read
    // against the same one. Comparing it to a PC whose clock is off by even a few minutes
    // makes a live session look expired, or a dead one look alive.
    let now;
    try { now = require('./gt-github').serverNow(); } catch (e) { now = Date.now(); }
    return load().sessions.find(s =>
        ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status) && s.expiresAt && s.expiresAt > now
    ) || null;
}

function getSessions() {
    return load().sessions.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20);
}

function removeSession(id) {
    const cfg = load();
    const before = cfg.sessions.length;
    cfg.sessions = cfg.sessions.filter(s => s.id !== id);
    if (cfg.sessions.length === before) return false;
    save(cfg);
    return true;
}

/**
 * Wipe every trace of this feature from the machine: sessions, the GitHub connection, the
 * broker configuration, the per-install signing secret, and the engine's own state dir.
 *
 * Deliberately does NOT touch the user's GitHub repository or the deployed Worker. Those
 * live in accounts the user owns, and deleting someone's repo because they clicked "reset"
 * inside a VPN client is not a trade this feature gets to make on their behalf.
 */
function resetAll() {
    const removed = [];
    const targets = [
        STORE_FILE,                                                  // sessions
        path.join(HOME_DIR, 'github-tunnel-account.json'),           // legacy single GitHub token
        path.join(HOME_DIR, 'github-tunnel-accounts.json'),          // the account pool
        path.join(HOME_DIR, 'github-tunnel-broker-deploy.json'),     // broker config + TS client
        path.join(HOME_DIR, 'github-tunnel-broker.json'),            // per-install signing secret
        path.join(HOME_DIR, 'gt-daemon.log'),
        path.join(HOME_DIR, 'gt-core.log'),                           // v2 core's own log
        path.join(HOME_DIR, 'gt-cleanip.json'),                       // v2 clean-IP winners per network
    ];
    for (const f of targets) {
        try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); } } catch (e) {}
    }
    try {
        const stateDir = path.join(HOME_DIR, 'gt-state');
        if (fs.existsSync(stateDir)) { fs.rmSync(stateDir, { recursive: true, force: true }); removed.push('gt-state'); }
    } catch (e) {}
    return { removed };
}

module.exports = {
    resetAll,
    load, save, setRepo, getRepo, getDataPlane, setDataPlane, getFirewallAutoEnable, setFirewallAutoEnable,
    getAutoRenew, setAutoRenew, getExitPrefs, setExitPrefs, normalizeExitPrefs,
    addSession, updateSession, getSession, getActiveSession, getSessions, removeSession,
    SESSION_LIFETIME_MS, STORE_FILE,
};
