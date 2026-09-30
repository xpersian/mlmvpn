// --- GitHub Tunnel API routes ---
// Mounted from server.js with one line:
//     require('./github-tunnel/routes')(app, { broadcastLog });
// Everything the GitHub Tunnel panel needs lives under /api/github-tunnel/*.
//
// Provisioning (setup/renew) runs in the background and reports progress through an
// in-memory `provisioning` tracker the panel polls — same pattern as vodi's device-flow
// `pending` object — rather than holding the HTTP request open for minutes.

const github = require('./gt-github');
const deployer = require('./gt-deployer');
const store = require('./gt-config');
const broker = require('./gt-broker');
const accounts = require('./gt-accounts');
const allocator = require('./gt-allocator');
const quota = require('./gt-quota');
const brokerDeploy = require('./gt-broker-deploy');
const slots = require('./gt-slots');
const verify = require('./gt-verify');
const path = require('path');
const dataplane = require('./gt-dataplane');
const guard = require('./gt-guard');
const tun = require('../tun-manager');

// How v2's full tunnel registers itself with tun-manager (WHO OWNS THE SHARED TUNNEL there).
const TUN_OWNER = 'github-tunnel';

// The engine behind the session being brought up: v1 (gt-engine.js, Tailscale) or v2
// (gt-core.js, Xray through the user's Worker). Set by bringUp from the session itself; code
// that only asks "is anything up" goes through dataplane.active() instead.
let engine = dataplane.v1;
const bothEngines = () => [dataplane.v1, dataplane.v2];
// The engine whose state the panel should see: the active session's, or whichever is running.
function currentEngine() {
    const s = deployer.activeSession();
    return s ? dataplane.forSession(s) : dataplane.active();
}

// The shared full-system tunnel is someone else's unless it is chained to our own engine —
// which only the game booster does, pointing it at our SOCKS port. That one dies with us;
// every other tunnel is left exactly as its owner left it.
function sharedTunnelIsOurs() {
    if (!tun.isRunning()) return false;
    const running = String(tun.currentEngine() || '').toLowerCase();
    return bothEngines().some((e) => running === String(e.PROCESS_NAME || '').toLowerCase());
}

let provisioning = null; // { state, steps: [{key,label,done}], log: [string], error, startedAt }

const STEP_ORDER = [
    ['SETTING_UP', 'GitHub connected'],
    ['STARTING', 'Cloud workflow configured'],
    ['INSTALLING', 'Starting Windows cloud'],
    ['CONNECTING_NETWORK', 'Connecting secure network'],
    ['READY', 'Generating configuration'],
];

function setProvisioningState(s) {
    if (!provisioning) return;
    provisioning.state = s;
    provisioning.updatedAt = Date.now();
}

// ── one owner of the data plane at a time ────────────────────────────────────────────
// connect / disconnect / mode-switch / reset all tear the same three machine-wide things
// down and build them back up: a daemon that owns a kernel adapter, a firewall profile,
// and the Windows proxy switch. Run two of them at once — a double click, a mode switch
// landing on top of a connect, the watchdog rebuilding while the user presses disconnect —
// and they interleave: two daemons race for the same UDP port and control pipe, one
// disengage lands after the other's engage (leaving the machine firewalled with no rules,
// i.e. no internet), and the engine's module-level state ends up describing neither.
// None of that is theoretical; it is what "the tunnel connects and drops in a loop" was.
//
// The UI's busy flag is not enough on its own: it is one renderer's opinion, and the HTTP
// API is reachable regardless of what it thinks. So the serialisation lives here.
let dataPlaneQueue = Promise.resolve();
let dataPlaneBusy = false;

function exclusive(fn) {
    const next = dataPlaneQueue.then(
        () => { dataPlaneBusy = true; return fn(); },
        () => { dataPlaneBusy = true; return fn(); },
    );
    // The queue must never inherit a rejection, or every later transition is skipped.
    dataPlaneQueue = next.then(() => { dataPlaneBusy = false; }, () => { dataPlaneBusy = false; });
    return next;
}

function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req, res);
            if (!res.headersSent) res.json(result ?? { ok: true });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            // The code travels with the words: the panel turns a known one into one finding and
            // one button (github-tunnel.js › GT_ADVICE) instead of a sentence to decipher.
            if (!res.headersSent) res.status(500).json({ ok: false, error: message, code: (err && err.code) || '' });
        }
    };
}

function publicSession(session) {
    if (!session) return null;
    // Corrected clock, not Date.now(): the deadline lives on GitHub's timeline.
    const remainingMs = session.expiresAt ? Math.max(0, session.expiresAt - github.serverNow()) : 0;
    return {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        remainingMs,
        tailscaleIp: session.tailscaleIp || '',
        hasConfig: !!(session.rdp || (session.v2 && session.v2.sealed)),
        lastError: session.lastError || '',
        // v2: where the server is and how many quick tunnels it has — never the sealed
        // transport or its key, which stay in the main process.
        dataPlane: session.dataPlane === 'v2' ? 'v2' : 'v1',
        runner: session.v2 && session.v2.runner ? session.v2.runner : null,
        tunnels: session.v2 ? (session.v2.hosts || 0) : 0,
        // «تونل پایدار»: which slot this session runs, and whether its runner connected it.
        slot: session.v2 && session.v2.slot ? { name: session.v2.slot, ready: !!session.v2.slotReady } : null,
        // Which account is carrying this session. A login is not a credential, and without
        // it the user cannot tell which of ten accounts their tunnel is actually spending.
        accountId: session.accountId || '',
        accountLogin: session.accountLogin || '',
    };
}

module.exports = function registerGithubTunnelRoutes(app, { broadcastLog, broadcast, readSystemProxy, expose, withTunLock, tunWantedElsewhere, dnsBridge } = {}) {
    const emitLog = (msg) => { try { if (broadcastLog) broadcastLog(`[GitHub Tunnel] ${msg}`); } catch (e) {} };
    // tun-manager's own lines already say «[TUN]».
    const tunLog = (msg) => { try { if (broadcastLog) broadcastLog(msg); } catch (e) {} };
    // The shared adapter's lock (server.js › withTunLock). Every feature that builds or tears down
    // that tunnel takes it, and so does ours — always INSIDE our own `exclusive`, never around it,
    // which is the one order that cannot deadlock. Without it (tests, an older caller) calls just run.
    const tunLock = typeof withTunLock === 'function' ? withTunLock : (who, fn) => Promise.resolve().then(fn);
    // Another feature means to hold the adapter although it is down this second — WARP re-arming
    // its tunnel, the V2Ray switch mid-rebuild. Building ours then would only be taken straight back.
    const adapterWantedElsewhere = () => { try { return !!(tunWantedElsewhere && tunWantedElsewhere()); } catch (e) { return false; } };
    // A WARP-family engine connected beside us in proxy mode keeps a local DNS bridge that points
    // Windows at 127.0.0.1 — and under a live full tunnel that is a machine with no DNS at all
    // (server.js › tunTookOverDns). server.js takes it down before our tunnel goes up and hands it
    // back once the tunnel is gone. Without the hook (tests, an older caller) nothing happens.
    const bridgeStop = async () => { try { if (dnsBridge && dnsBridge.stop) await dnsBridge.stop(); } catch (e) {} };
    const bridgeRestore = async () => { try { if (dnsBridge && dnsBridge.restore) await dnsBridge.restore(); } catch (e) {} };
    const foreignTunnel = () => Object.assign(
        new Error('یک تونل دیگر (ماسک، وایرگارد، وارپ در وارپ یا V2Ray) روشن است. اول آن را خاموش کنید، بعد تونل GitHub را روشن کنید.'),
        { code: 'TUN_BUSY' });

    // Windows' proxy switch is global, so it is read and written through the very same
    // helpers server.js uses for Xray/Aether — otherwise the two panels would disagree
    // about whether the proxy is on.
    const readProxyState = () => {
        try { return readSystemProxy ? readSystemProxy() : { enabled: false, server: '' }; }
        catch (e) { return { enabled: false, server: '' }; }
    };
    // HTTP_PORT, not SOCKS_PORT: WinINET's ProxyServer is an HTTP proxy and cannot speak
    // SOCKS5 (see gt-engine.js).
    //
    // Ownership is tracked because the switch is global and shared with Xray/GST. Two
    // things depend on knowing whether it is ours:
    //   * turning it OFF blindly silently breaks whatever else had it on;
    //   * leaving it ON when this process dies points every WinINET app on the machine at
    //     127.0.0.1:20813, where nothing is listening any more. That is not "the VPN
    //     stopped working", that is the user's entire internet gone, permanently, with a
    //     cause they cannot possibly guess. It is the single most common way a proxy-mode
    //     VPN bricks a machine, and it needed a synchronous undo on every exit path.
    // Hosts tailscaled itself must reach WITHOUT going through the proxy.
    //
    // In proxy mode the system proxy points at tailscaled's own listener, and tailscaled
    // reads that setting for its outbound HTTPS (its own log: "PAC or proxyConfig
    // changed; updating routes"). With no bypass its control-plane and DERP traffic is
    // proxied through itself — a loop that cannot complete. The tunnel still comes up
    // (the proxy is set only afterwards), then drops the next time the control plane is
    // needed, which is why it looked intermittent rather than broken.
    const TS_PROXY_BYPASS = [
        '*.tailscale.com',
        'tailscale.com',
        '*.tailscale.io',
        'tailscale.io',
        '*.ts.net',
    ];
    let systemProxyOwned = false;
    const setSystemProxy = (enable) => {
        require('../xray-manager').enableSystemProxy(!!enable, engine.HTTP_PORT, { bypass: TS_PROXY_BYPASS });
        systemProxyOwned = !!enable;
    };
    const clearSystemProxy = () => {
        try {
            const st = readProxyState();
            if (!st.enabled) { systemProxyOwned = false; return; }
            if (!systemProxyOwned) {
                emitLog('پراکسی سیستم (متعلق به موتور دیگر) خاموش شد — با تونل GitHub قابل جمع نیست.');
            }
            setSystemProxy(false);
        } catch (e) { systemProxyOwned = false; }
    };

    // Runs on process exit / SIGINT / SIGTERM, synchronously, via the engines' own hooks —
    // both of them: either may be the one that set the proxy.
    for (const e of bothEngines()) {
        e.registerEmergencyUndo(() => {
            if (!systemProxyOwned) return;
            try { require('../xray-manager').enableSystemProxy(false, e.HTTP_PORT); } catch (err) {}
            systemProxyOwned = false;
        });
        // Installed now rather than on first connect: the undo above has to be armed before
        // anything can possibly set the proxy, not after.
        e.installExitHooks();
    }
    // On by default: the whole point of the guard is the case where the user is not
    // watching. Off is an explicit choice, kept in memory only so it never silently
    // persists across restarts into a session the user thinks is protected.
    let killSwitchEnabled = true;
    // The user's standing answer to «may we switch your firewall on while connected» (gt-config).
    guard.setFirewallPolicy({ enableWhenOff: store.getFirewallAutoEnable() });
    // On by default for the same reason, and kept in memory for the same reason. Off is a
    // deliberate choice for someone who needs IPv6 on their LAN more than they need their
    // real v6 address hidden — see gt-guard.js › THE IPv6 LEAK.
    let ipv6GuardEnabled = true;
    // Why the data plane came down, when it came down on its own. Without it the panel
    // just shows everything switched off and the user is left guessing whether they did
    // it, the app did it, or it broke.
    let teardownReason = '';
    // The outcome of the most recent device-flow sign-in, so the panel can tell the user
    // whether the pool actually grew. Holds a login and a flag — never a credential.
    let lastSignIn = null;
    // The latest «آزمون نشتی» result (gt-verify.js) — addresses and a verdict, nothing else.
    let lastLeakTest = null;
    // What the leak test compares against: the line's own address from before the full tunnel
    // took the route, and the resolver the tunnel was built with. In memory only.
    let lineId = null;
    let lastTunResolver = null;
    // The mode the user last connected in — what a failover or a swap to the next session
    // restores, since the engine that knew it may already be gone.
    let wantedMode = '';

    const broadcastState = () => {
        try {
            if (!broadcast) return;
            broadcast('tun', { running: tun.isRunning() });
            broadcast('system_proxy', readProxyState());
        } catch (e) {}
    };

    // ── GitHub accounts ──────────────────────────────────────────────────────────
    // A completed device-flow sign-in is handed straight to the pool. This is what makes
    // adding the tenth account the same operation as the first: there is no "the account"
    // anywhere in the flow, only a pool that gained a member.
    github.setSignInHandler(async (result) => {
        try {
            const { account, created } = accounts.upsert({
                login: result.login, name: result.name, avatarUrl: result.avatarUrl,
                scopes: result.scopes, token: result.token,
            });
            // WHICH account got authorised is decided by the BROWSER, not by us: the device
            // flow authorises whoever is signed in on github.com. So "add an account" while
            // already signed in as account #1 silently re-authorises account #1 — the pool
            // is unchanged, and without saying so the user is left believing they now have
            // two accounts and wondering why nothing failed over.
            lastSignIn = { login: account.login, created, at: Date.now(), poolSize: accounts.count() };
            emitLog(created
                ? `حساب گیت‌هاب @${account.login} اضافه شد.`
                : `این همان حساب @${account.login} بود که از قبل متصل بود — فقط دسترسی‌اش تازه شد.`);
            if (!github.hasBillingScope(account.scopes)) {
                emitLog(`@${account.login}: دسترسی خواندن سهمیه داده نشد — مصرف به‌صورت تخمینی نشان داده می‌شود.`);
            }
            // Best effort and never blocking: a first quota reading makes the new row
            // useful immediately instead of showing "unknown" until the next poll.
            quota.refresh(account.id, { force: true }).catch(() => {});
        } catch (e) {
            emitLog(`افزودن حساب گیت‌هاب ناموفق بود: ${e.message}`);
        }
    });

    /** The pool, joined with live session ownership. Never includes a token. */
    function accountsView() {
        const sessions = store.getSessions();
        const liveByAccount = new Map();
        for (const s of sessions) {
            if (['READY', 'ACTIVE', 'EXPIRING_SOON', 'STANDBY'].includes(s.status) && s.accountId) {
                if (!liveByAccount.has(s.accountId)) liveByAccount.set(s.accountId, s.id);
            }
        }
        const leased = allocator.leasedIds();
        return accounts.list().map(a => accounts.publicAccount(a, {
            activeSessionId: liveByAccount.get(a.id) || null,
            inUse: liveByAccount.has(a.id) || leased.includes(a.id),
        }));
    }

    app.get('/api/github-tunnel/accounts', handle(async () => {
        const list = accountsView();
        const active = deployer.activeSession();
        return {
            ok: true,
            accounts: list,
            lastSignIn,
            // Which account the tunnel is on RIGHT NOW — the question the panel exists to
            // answer and the one a per-account list alone cannot.
            currentAccountId: (active && active.accountId) || null,
            poolProblem: list.length ? (list.some(a => a.health !== 'AUTH_REQUIRED' && !a.disabled) ? null : allocator.explainEmptyPool()) : null,
        };
    }));

    // Kept for compatibility with the panel's older status call; the pool is the truth.
    app.get('/api/github-tunnel/github/status', handle(async () => {
        const list = accountsView();
        return {
            ok: true,
            ...github.status(),
            connected: list.length > 0,
            accounts: list,
            account: list[0] || null,
        };
    }));

    app.post('/api/github-tunnel/github/start', handle(async () => {
        const r = await github.startLogin();
        emitLog(`Enter code ${r.userCode} in the browser tab that just opened.`);
        return { ok: true, ...r };
    }));

    app.post('/api/github-tunnel/github/cancel', handle(async () => ({ ok: true, ...github.cancelPending() })));

    /** Remove ONE account from the pool. Ends only that account's own session. */
    app.post('/api/github-tunnel/accounts/remove', handle(async (req) => {
        const id = String((req.body && req.body.id) || '');
        const account = accounts.get(id);
        if (!account) throw new Error('این حساب پیدا نشد.');

        // Only sessions belonging to THIS account. Removing account #2 must not touch a
        // tunnel running on account #1 — that is the whole point of session affinity.
        for (const s of store.getSessions()) {
            if (s.accountId === id && ['READY', 'ACTIVE', 'EXPIRING_SOON', 'STANDBY', 'ENDING'].includes(s.status)) {
                await deployer.endSession(s, emitLog);
                // If the live data plane was pointed at that session, it is now pointed at
                // a machine that is being destroyed. Take it down rather than leave the
                // user connected to a corpse behind an engaged kill-switch.
                const engineOn = dataplane.active().getStatus().connected || guard.isEngaged();
                if (engineOn && deployer.activeSession() == null) {
                    await exclusive(() => teardownAll('SESSION_ENDED'));
                }
            }
        }
        accounts.remove(id);
        allocator.release(id);
        emitLog(`حساب گیت‌هاب @${account.login} حذف شد.`);
        return { ok: true, accounts: accountsView() };
    }));

    /** Temporarily take an account out of the rotation without forgetting it. */
    app.post('/api/github-tunnel/accounts/toggle', handle(async (req) => {
        const id = String((req.body && req.body.id) || '');
        const disabled = !!(req.body && req.body.disabled);
        if (!accounts.get(id)) throw new Error('این حساب پیدا نشد.');
        accounts.update(id, { disabled });
        return { ok: true, accounts: accountsView() };
    }));

    /** Clear a cooldown the user believes is stale (they fixed billing, the limit lifted). */
    app.post('/api/github-tunnel/accounts/retry', handle(async (req) => {
        const id = String((req.body && req.body.id) || '');
        const a = accounts.get(id);
        if (!a) throw new Error('این حساب پیدا نشد.');
        if (a.health === accounts.HEALTH.AUTH_REQUIRED) {
            throw new Error('این حساب نیاز به اتصال دوباره دارد؛ تلاش مجدد کمکی نمی‌کند.');
        }
        accounts.update(id, { cooldownUntil: 0, consecutiveFailures: 0, health: accounts.HEALTH.UNKNOWN, healthReason: '' });
        await quota.refresh(id, { force: true }).catch(() => {});
        return { ok: true, accounts: accountsView() };
    }));

    app.post('/api/github-tunnel/accounts/refresh', handle(async () => {
        // Sequential on purpose: firing ten billing calls at once is exactly the shape
        // GitHub's secondary rate limiter punishes, and it would cool down the whole pool.
        for (const a of accounts.list()) {
            try { await quota.refresh(a.id, { force: true }); } catch (e) {}
        }
        return { ok: true, accounts: accountsView() };
    }));

    app.post('/api/github-tunnel/github/disconnect', handle(async () => {
        // "Disconnect GitHub" now means the whole pool, so every account's own live session
        // is ended with its own credential.
        for (const s of store.getSessions()) {
            if (['READY', 'ACTIVE', 'EXPIRING_SOON', 'STANDBY', 'ENDING'].includes(s.status)) {
                await deployer.endSession(s, emitLog);
            }
        }
        for (const a of accounts.list()) accounts.remove(a.id);
        emitLog('همه‌ی حساب‌های گیت‌هاب قطع شدند.');
        return { ok: true };
    }));

    // ── setup / renew ────────────────────────────────────────────────────────────
    app.post('/api/github-tunnel/setup', handle(async () => {
        if (provisioning && provisioning.state !== 'READY' && provisioning.state !== 'FAILED') {
            return { ok: true, alreadyRunning: true };
        }
        provisioning = { state: 'SETTING_UP', log: [], error: '', startedAt: Date.now() };
        (async () => {
            try {
                await deployer.createSession({
                    onLog: (msg) => { provisioning.log.push(msg); emitLog(msg); },
                    onState: (s) => setProvisioningState(s),
                });
            } catch (e) {
                provisioning.state = 'FAILED';
                provisioning.error = e.message;
                provisioning.errorCode = e.code || '';
                emitLog(`راه‌اندازی ناموفق بود: ${e.message}`);
            }
        })();
        return { ok: true };
    }));

    app.post('/api/github-tunnel/activate-again', handle(async (req) => {
        const force = !!(req.body && req.body.force);
        if (!force) {
            const existing = deployer.activeSession();
            if (existing) return { ok: true, existing: true, session: publicSession(existing) };
        }
        provisioning = { state: 'RENEWING', log: [], error: '', startedAt: Date.now() };
        (async () => {
            try {
                await deployer.renewSession({
                    force,
                    onLog: (msg) => { provisioning.log.push(msg); emitLog(msg); },
                    onState: (s) => setProvisioningState(s),
                });
            } catch (e) {
                provisioning.state = 'FAILED';
                provisioning.error = e.message;
                provisioning.errorCode = e.code || '';
                emitLog(`تمدید ناموفق بود: ${e.message}`);
            }
        })();
        return { ok: true };
    }));

    app.get('/api/github-tunnel/status', handle(async () => {
        let active = deployer.activeSession() || (store.getSessions()[0] || null);
        // Confirm against the real run (rate-limited internally) before trusting the clock,
        // so a session that died early is reported dead instead of counted down.
        if (active) active = await deployer.reconcile(active);
        const ticked = active ? deployer.tick(active) : null;
        return {
            ok: true,
            provisioning: provisioning ? {
                state: provisioning.state,
                log: provisioning.log.slice(-30),
                error: provisioning.error || '',
                errorCode: provisioning.errorCode || '',
                steps: STEP_ORDER.map(([key, label]) => ({ key, label })),
            } : null,
            session: publicSession(ticked),
            // Which data plane a NEW session would use — the panel shapes the relay setup
            // (v2 needs no Tailscale at all) and the mode picker from it.
            dataPlane: store.getDataPlane(),
            // «تمدید خودکار بی‌وقفه» and where the next session is (MAKE-BEFORE-BREAK).
            autoRenew: store.getAutoRenew(),
            continuity: { phase: continuity.phase, error: continuity.error, at: continuity.at, tries: continuity.tries,
                forSession: continuity.forSession, standby: !!(continuity.nextId && (store.getSession(continuity.nextId) || {}).status === 'STANDBY') },
            // «تونل پایدار»: set up or not — the slots themselves, never a token.
            slots: { ...slots.status(), slotsBound: brokerDeploy.status().slotsBound },
            // The exit country the user asked for, and where bringing it up stands.
            exitChoice: { prefs: store.getExitPrefs(), job: { ...exitJob } },
        };
    }));

    // v1 stays one switch away until v2 has replaced it everywhere (plan P7).
    app.post('/api/github-tunnel/dataplane', handle(async (req) => {
        const v = store.setDataPlane(req.body && req.body.dataPlane);
        emitLog(v === 'v2' ? 'نشست‌های تازه با تونل جدید (کلادفلر) ساخته می‌شوند.' : 'نشست‌های تازه با تونل قدیمی (Tailscale) ساخته می‌شوند.');
        return { ok: true, dataPlane: v };
    }));

    app.get('/api/github-tunnel/sessions', handle(async () => ({
        ok: true, sessions: store.getSessions().map(publicSession),
    })));

    // ── secure network relay (broker) deploy ────────────────────────────────────
    // Deploys cloudflare-worker/gt-broker/worker.js onto the SAME Cloudflare account
    // already connected in the Cloud module, reusing that account store — one button
    // here instead of a separate wrangler/Tailscale-account onboarding flow.
    app.get('/api/github-tunnel/broker/status', handle(async () => ({ ok: true, ...brokerDeploy.status() })));

    app.post('/api/github-tunnel/broker/url', handle(async (req) => {
        const r = brokerDeploy.setCustomUrl(req.body && req.body.url);
        emitLog(r.customUrl ? `آدرس سرویس شبکه‌ی امن روی «${r.customUrl}» تنظیم شد.` : 'آدرس اختصاصی حذف شد.');
        return { ok: true, ...r };
    }));

    app.post('/api/github-tunnel/broker/deploy', handle(async (req) => {
        const { email, token, accountName, tsClientId, tsClientSecret, tsTailnet } = req.body || {};
        const r = await brokerDeploy.deployBroker({ email, token, accountName, tsClientId, tsClientSecret, tsTailnet, onLog: emitLog });
        emitLog('سرویس شبکه‌ی امن با موفقیت راه‌اندازی شد.');
        return { ok: true, ...r };
    }));

    // ── «تونل پایدار» (gt-slots.js): two named tunnels behind the Worker, no domain ──
    // Same Cloudflare account as the Worker, sent per request like the deploy above. Setup and
    // removal redeploy the Worker; a session already running keeps its path (a new session
    // starts using the slots), so neither needs the tunnel down.
    app.get('/api/github-tunnel/slots', handle(async () => ({ ok: true, ...slots.status(), slotsBound: brokerDeploy.status().slotsBound })));
    app.post('/api/github-tunnel/slots/setup', handle(async (req) => {
        const { email, token, accountName } = req.body || {};
        const r = await slots.setup({ email, token, accountName, onLog: emitLog });
        broadcastState();
        return { ok: true, ...r };
    }));
    // ── the exit country (P4) ──
    app.get('/api/github-tunnel/exits', handle(async () => {
        const st = dataplane.v2.getStatus();
        return { ok: true, prefs: store.getExitPrefs(), job: { ...exitJob }, plan: st.exitPlan, exits: st.exits, catalog: st.catalog, exit: st.exit || null };
    }));
    // The country every connection leaves by ('' = «حداکثر سرعت»), optionally with a provider.
    app.post('/api/github-tunnel/exit', handle(async (req) => {
        const { country = '', provider = '' } = req.body || {};
        const prefs = store.setExitPrefs({ country, provider });
        emitLog(prefs.country ? `کشور خروجی: ${countryFa(prefs.country)}.` : 'کشور خروجی: حداکثر سرعت (آدرس خود سرور ابری).');
        scheduleExits('choice');
        return { ok: true, prefs };
    }));
    // «این سایت‌ها از فلان کشور»: [{ country, provider?, domains: [...] }]
    app.post('/api/github-tunnel/exit/rules', handle(async (req) => {
        const prefs = store.setExitPrefs({ rules: (req.body && req.body.rules) || [] });
        emitLog(prefs.rules.length ? `قانون سایت‌ها: ${prefs.rules.map((r) => `${r.domains.length.toLocaleString('fa-IR')} سایت از ${countryFa(r.country)}`).join('، ')}.` : 'قانون سایت‌ها برداشته شد.');
        scheduleExits('rules');
        return { ok: true, prefs };
    }));
    // A vless:// link of the running session through one exit — for the phone app, valid until
    // the session ends. The user's own tunnel, handed to their own other device.
    app.post('/api/github-tunnel/exit/link', handle(async (req) => {
        const link = dataplane.v2.shareLink((req.body && req.body.id) || 'direct');
        if (!link) throw Object.assign(new Error('اول تونل را وصل کنید — لینک از نشست در حال اجرا ساخته می‌شود.'), { code: 'NOT_RUNNING' });
        return { ok: true, ...link };
    }));

    app.post('/api/github-tunnel/slots/remove', handle(async (req) => {
        const { email, token, accountName } = req.body || {};
        const r = await slots.remove({ email, token, accountName, onLog: emitLog, sessions: store.getSessions() });
        broadcastState();
        return { ok: true, ...r };
    }));

    // ── data plane: connect / disconnect ────────────────────────────────────────
    // Mirrors the Aether engine's contract exactly: connecting only brings the engine up
    // and exposes a local SOCKS port. Whether traffic actually goes through it is then
    // decided by the two independent switches below (system proxy / full tunnel), which is
    // the same split the Aether panel uses.

    app.get('/api/github-tunnel/engine/status', handle(async () => {
        const eng = currentEngine().getStatus();
        const session = deployer.activeSession();
        const v2 = !!(session && session.dataPlane === 'v2');
        // The guards are built around a tunnel ADAPTER: v1's own, or for v2 the shared one, which
        // only its full tunnel uses. As a proxy, or as the game tab's bare engine, there is nothing
        // for an allow rule to point at. Disconnected, the switches stand for the next full tunnel.
        const guarded = v2 ? !['proxy', 'engine'].includes(eng.mode) : eng.mode !== 'proxy';
        return {
            ok: true,
            dataPlane: v2 ? 'v2' : 'v1',
            engine: { ...eng, error: eng.error || teardownReason || '' },
            // Whether the shared tunnel is OURS: a V2Ray or WARP tunnel on the same adapter is not.
            tun: { running: tun.isRunning(), ours: v2 ? tun.isRunning() && tun.currentOwner() === TUN_OWNER : tun.isRunning() },
            systemProxy: readProxyState(),
            busy: dataPlaneBusy,
            killSwitch: {
                enabled: killSwitchEnabled,
                engaged: guard.isEngaged(),
                // The guard is a firewall allow-list built around the tunnel ADAPTER, and
                // proxy mode has no adapter — so in proxy mode it cannot be engaged at all.
                // The switch used to render "on" there anyway, which told the user they
                // were protected while nothing whatsoever was blocking a leak. Say so.
                applicable: guarded,
            },
            // Whether name lookups are held inside the tunnel (gt-guard.js › THE DNS LEAK).
            dnsGuard: { active: guard.isDnsBlocked() },
            // Whether the machine's real IPv6 address is kept off the wire (gt-guard.js ›
            // THE IPv6 LEAK). Same shape as killSwitch: the exit node has no v6 egress, so
            // there is nothing to contain in proxy mode either.
            ipv6Guard: {
                enabled: ipv6GuardEnabled,
                active: guard.isIpv6Blocked(),
                applicable: guarded,
            },
            // The most recent leak test (gt-verify.js), so a reopened panel still shows it.
            leakTest: lastLeakTest,
            // Whether the guards' rules are enforced at all — a switched-off Windows Firewall
            // enforces none of them — and whether the user let us switch it on for the tunnel.
            firewall: guard.firewallStatus(),
        };
    }));

    // «روشن کردن دیوارآتش ویندوز فقط هنگام اتصال» — the user's explicit choice, kept across
    // restarts. On: a full tunnel that is up gets its guards now. Off: guards that only worked
    // because we switched the firewall on come down, and the firewall goes back as it was.
    app.post('/api/github-tunnel/firewall', handle(async (req) => {
        const autoEnable = !!(req.body && req.body.autoEnable);
        store.setFirewallAutoEnable(autoEnable);
        guard.setFirewallPolicy({ enableWhenOff: autoEnable });
        await exclusive(async () => {
            const st = currentEngine().getStatus();
            const fullTunnel = st.connected && st.mode === 'tun';
            if (autoEnable && fullTunnel) {
                emitLog('دیوارآتش ویندوز فقط برای مدت اتصال روشن می‌شود تا محافظ نشت و قفل‌ها کار کنند.');
                await armGuards();
            } else if (!autoEnable && guard.firewallStatus().leased) {
                emitLog('روشن کردن دیوارآتش خاموش شد — محافظ نشت و قفل‌هایی که به آن وابسته بودند برداشته می‌شوند.');
                await guard.disengage(emitLog);
                await guard.unblockLanDns(emitLog);
                await guard.unblockIpv6(emitLog);
            }
        });
        broadcastState();
        return { ok: true, firewall: await guard.refreshFirewall(), killSwitch: guard.isEngaged() };
    }));

    app.post('/api/github-tunnel/ipv6guard', handle(async (req) => {
        ipv6GuardEnabled = !!(req.body && req.body.enabled);
        let reason = '';
        await exclusive(async () => {
            if (!ipv6GuardEnabled) await guard.unblockIpv6(emitLog);
            else if (currentEngine().getStatus().connected && currentEngine().getStatus().mode === 'tun') {
                try { const r = await guard.blockIpv6({ onLog: emitLog }); if (r && r.ok === false) reason = r.error || r.reason || ''; }
                catch (e) { emitLog('قفل IPv6 فعال نشد (احتمالاً برنامه دسترسی مدیر ندارد).'); reason = 'error'; }
            }
        });
        broadcastState();
        return { ok: true, enabled: ipv6GuardEnabled, active: guard.isIpv6Blocked(), reason };
    }));

    app.post('/api/github-tunnel/killswitch', handle(async (req) => {
        killSwitchEnabled = !!(req.body && req.body.enabled);
        let reason = '';
        await exclusive(async () => {
            if (!killSwitchEnabled) await guard.disengage(emitLog);
            else if (currentEngine().getStatus().connected && currentEngine().getStatus().mode === 'tun') {
                try { const r = await engageGuard(); if (r && r.ok === false) reason = r.reason || ''; }
                catch (e) { emitLog('محافظ نشت فعال نشد (احتمالاً برنامه دسترسی مدیر ندارد).'); reason = 'error'; }
            }
        });
        broadcastState();
        return { ok: true, enabled: killSwitchEnabled, engaged: guard.isEngaged(), reason };
    }));

    app.get('/api/github-tunnel/engine/speedtest', handle(async () => ({ ok: true, ...(await currentEngine().speedtest()) })));

    // «آزمون نشتی» — the full tunnel's four leak paths, asked of the far end (gt-verify.js).
    // Read-only, so outside `exclusive`: it must not freeze the switches while it runs.
    app.post('/api/github-tunnel/leaktest', handle(async () => {
        const session = deployer.activeSession();
        const st = dataplane.v2.getStatus();
        const ours = tun.isRunning() && tun.currentOwner() === TUN_OWNER;
        if (!session || session.dataPlane !== 'v2' || !st.connected || st.mode !== 'tun' || !ours) {
            throw Object.assign(new Error('آزمون نشتی برای «تونل کامل» است — اول تونل کامل را روشن کنید. در حالت پروکسی سیستم فقط برنامه‌هایی که از پروکسی استفاده می‌کنند از تونل می‌روند.'), { code: 'NOT_FULL_TUNNEL' });
        }
        let appRouting = null;
        try {
            const ar = require('../app-routing').tunRules('gt', dataplane.v2.PROCESS_NAME);
            appRouting = { mode: ar.mode, count: ar.count };
        } catch (e) { /* no per-app routing */ }
        const result = await verify.run({ exit: st.exit, line: lineId, appRouting, tunnelResolver: lastTunResolver });
        result.guards = { killSwitch: guard.isEngaged(), killSwitchWanted: killSwitchEnabled, dns: guard.isDnsBlocked(), ipv6: guard.isIpv6Blocked() };
        result.firewall = await guard.refreshFirewall();
        lastLeakTest = result;
        const failed = result.checks.filter((c) => c.status === 'fail').length;
        emitLog(result.verdict === 'clean' ? 'آزمون نشتی: هیچ نشتی پیدا نشد — آدرس، DNS، UDP و IPv6 همه از تونل می‌روند.'
            : result.verdict === 'leak' ? `آزمون نشتی: ${failed.toLocaleString('fa-IR')} مسیر نشت پیدا شد — جزئیات در کارت «آزمون نشتی».`
                : 'آزمون نشتی: بعضی سنجش‌ها جواب قطعی ندادند — یک بار دیگر بزنید.');
        return { ok: true, result };
    }));

    app.get('/api/github-tunnel/engine/diagnose', handle(async () => ({ ok: true, ...(await currentEngine().diagnose()) })));

    // Bring the engine up in a given mode. Every call gets a FRESH key: the keys are
    // single-use, so a mode switch (which restarts the daemon) needs its own.
    async function bringUp(mode) {
        const session = deployer.activeSession();
        if (session && session.dataPlane === 'v2') return bringUpV2(session, mode);
        if (!session || !session.tailscaleIp) throw new Error('نشست ابری فعالی برای اتصال وجود ندارد.');
        // v1's SOCKS port carries no UDP, so a bare engine is no use to anyone: the game tab gets
        // what it always got from v1, the full tunnel.
        if (mode === 'engine') mode = 'tun';
        // A v2 engine left running by an earlier session must not share the machine with v1.
        if (dataplane.v2.getStatus().running) await dataplane.v2.disconnect(emitLog);
        engine = dataplane.v1;

        // Only one thing may own the default route. server.js enforces that between Xray,
        // Aether and sing-box through tun-manager — but this mode drives its OWN kernel
        // adapter and never passes through tun-manager, so that interlock did not cover it.
        // Two owners means both keep winning and losing the route, which shows up as the
        // tunnel connecting and dropping in a loop.
        //
        // The shared tunnel is refused in proxy mode too, and is never stopped from here unless
        // it is chained to our own engine. This used to stop ANY running tunnel before a proxy
        // connect (and on every teardown), so pressing a GitHub button silently took down the
        // user's V2Ray or WARP tunnel. And leaving it up under a proxy-mode connect would make
        // our uplink ride inside someone else's tunnel — a tunnel within a tunnel.
        if (tun.isRunning() && !sharedTunnelIsOurs()) throw foreignTunnel();
        await stopOurTunnel('reconnect');
        clearSystemProxy();

        // THE RECONNECT WINDOW, AND WHY THE GUARD NOW STAYS UP THROUGH IT
        //
        // This used to disengage the guard unconditionally before tearing the engine down.
        // That opens a hole for the entire length of a reconnect — the daemon restart, the
        // key mint, `up`, and the verification, which together run tens of seconds — during
        // which the machine is wide open on its real address. And a reconnect is not a rare
        // event: it is what the watchdog does the moment a tunnel wobbles, i.e. exactly
        // when the user is least likely to be looking. Someone with a browser mid-session
        // hands over their real IP and never learns it happened.
        //
        // Nothing actually required that hole. The allow-list is written in terms of an
        // interface ALIAS ('mlmvpn-gt') and two program paths, none of which stop being
        // true while the adapter is recreated, and both the daemon and this app are on it —
        // so a reconnect has every path it needs with the guard still engaged.
        //
        // It comes down only when it genuinely cannot stay: proxy mode has no adapter for
        // the allow rule to point at, so leaving it up would block everything.
        const keepGuard = guard.isEngaged() && mode === 'tun' && killSwitchEnabled;
        if (keepGuard) emitLog('محافظ نشت در طول اتصال مجدد فعال می‌ماند — ترافیک شما در این فاصله بیرون نمی‌رود.');
        else await guard.disengage(emitLog);
        // The DNS block follows the same rule: through a guarded full-tunnel reconnect it stays
        // (the daemon finds its control plane with its own bootstrap DNS, and the stored key
        // needs no lookup at all); for anything else it comes down now and, in tun mode, goes
        // back up the moment the new connection is verified.
        if (!keepGuard) await guard.unblockLanDns(emitLog);
        if (!keepGuard) await guard.unblockIpv6(emitLog);

        await engine.disconnect(emitLog);

        // Prefer the key taken during setup: the broker may well be unreachable right now
        // (see gt-deployer.js). Only reach for it as a fallback.
        const mintFresh = async () => {
            try {
                const k = await broker.mintAuthKey(`client-${session.id}-${Date.now().toString(36)}`);
                return k.key;
            } catch (e) {
                // The ACL failure names the exact edit that fixes it. Replacing it with
                // "the relay is unreachable" sends the user to debug the wrong thing.
                if (e && e.code === 'ACL_TAG_NOT_PERMITTED') throw e;
                throw new Error('کلید اتصال معتبر نیست و سرویس شبکه‌ی امن هم در دسترس نیست. یک‌بار «تمدید» بزنید تا نشست تازه با کلید جدید ساخته شود.');
            }
        };

        let authKey = session.clientKey || '';
        let r;
        try {
            try {
                if (!authKey) authKey = await mintFresh();
                r = await engine.connect({ exitNodeIp: session.tailscaleIp, authKey, mode, onLog: emitLog });
            } catch (e) {
                // A stored key that the control plane rejects is spent or revoked, and will
                // keep failing forever if left in place. Drop it and try once with a fresh one
                // rather than stranding the session on a dead credential.
                if (session.clientKey && /invalid key|not valid|unauthorized/i.test(e.message || '')) {
                    store.updateSession(session.id, { clientKey: '' });
                    emitLog('کلید ذخیره‌شده معتبر نبود؛ کلید تازه گرفته می‌شود…');
                    authKey = await mintFresh();
                    r = await engine.connect({ exitNodeIp: session.tailscaleIp, authKey, mode, onLog: emitLog });
                } else {
                    throw e;
                }
            }
        } catch (e) {
            // connect() can fail AFTER the daemon is up — a rejected key, an exit node that
            // was never approved, no egress. That leaves a live tailscaled holding an
            // adapter and a DNS policy, attached to nothing, which nobody else will clean
            // up: the watchdog was never started, and the user sees a failed connect and no
            // reason to press disconnect. Tear it down here.
            //
            // The guard is deliberately NOT touched: if it was engaged before this attempt
            // it stays engaged, because a failed reconnect is exactly when fail-closed
            // matters. teardownAll() is what the user's disconnect button reaches.
            try { await engine.disconnect(emitLog); } catch (_) {}
            broadcastState();
            throw e;
        }
        if (mode === 'proxy') setSystemProxy(true);
        teardownReason = '';
        if (mode === 'tun') await armGuards();
        broadcastState();
        return r;
    }

    /**
     * The three guards of a full tunnel, once it is verified carrying traffic — engaging earlier
     * would block the very connection being established. None is fatal: a tunnel that works is
     * reported as working, and each guard reports its own failure.
     */
    async function armGuards() {
        // Every one of the three is a Windows Firewall rule. With the firewall switched off and
        // no yes from the user to switch it on (gt-guard.js › WHEN WINDOWS FIREWALL IS OFF), all
        // three would refuse — so say it ONCE, with what fixes it, instead of three failures.
        const fw = await guard.refreshFirewall();
        if (fw.enforcing === false && !fw.autoEnable) {
            emitLog('دیوارآتش ویندوز روی این سیستم خاموش است؛ محافظ نشت و قفل‌های DNS و IPv6 بدون آن اجرا نمی‌شوند. تا وقتی تونل وصل است خود تونل جلوی نشت را می‌گیرد — این محافظ‌ها برای لحظه‌ای‌اند که تونل قطع شود. در پنل «روشن کردن دیوارآتش ویندوز فقط هنگام اتصال» را بزنید.');
            return;
        }
        // Name lookups must go through the tunnel too, or sites that decide by DNS see Iran —
        // see gt-guard.js › THE DNS LEAK. Only in tun mode: in proxy mode nothing but the proxied
        // apps is tunnelled, and taking the router's DNS from everything else would leave them
        // with none.
        if (!guard.isDnsBlocked()) {
            try { await guard.blockLanDns({ onLog: emitLog }); } catch (e) {
                emitLog(`جلوگیری از نشت DNS فعال نشد: ${e.message}`);
            }
        }

        // And the machine's real IPv6 address — gt-guard.js › THE IPv6 LEAK. v1: Tailscale leaves
        // a working v6 default route because the exit node has no v6 egress. v2: the adapter takes
        // v6 and refuses it, but only while it is up; this holds through a rebuild as well.
        if (ipv6GuardEnabled && !guard.isIpv6Blocked()) {
            try { await guard.blockIpv6({ onLog: emitLog }); } catch (e) {
                emitLog(`قفل IPv6 فعال نشد: ${e.message}`);
            }
        }

        // Engaging needs administrator rights (it rewrites the firewall profiles); without them
        // this throws, and letting that propagate reported a WORKING tunnel as a failed connection.
        if (killSwitchEnabled && !guard.isEngaged()) {
            try {
                const g = await engageGuard();
                if (g && g.ok === false && g.reason === 'aether-guard-engaged') {
                    emitLog('محافظ نشت فعال نشد، چون محافظ ماسک/وایرگارد/وارپ در وارپ هنوز روشن است. آن را خاموش کنید و تونل را یک بار قطع و وصل کنید.');
                }
            } catch (e) {
                emitLog('محافظ نشت فعال نشد (احتمالاً برنامه دسترسی مدیر ندارد). تونل برقرار است، ولی اگر قطع شود ترافیک با آی‌پی واقعی خارج می‌شود.');
            }
        }
    }

    /** Our own shared tunnel — v2's full tunnel, or the game tab's on our port — under the adapter's lock. */
    async function stopOurTunnel(reason) {
        if (!sharedTunnelIsOurs()) return;
        await tunLock(`github-tunnel-${reason}`, async () => {
            if (!sharedTunnelIsOurs()) return;   // re-checked under the lock
            await tun.stopTunAsync(emitLog, `github-tunnel: ${reason}`, { by: TUN_OWNER });
            await tun.verifyTornDown(emitLog);
        });
    }

    /**
     * v2: Xray through the user's Worker to the session's Cloudflare quick tunnels (gt-core.js).
     * No key to mint and no daemon of its own to keep: the sealed transport the runner published
     * is all it needs, refreshed first in case the runner had to replace a quick tunnel.
     *
     * Three modes. 'proxy': the system proxy on our HTTP port — partial cover, only the apps that
     * honour it. 'engine': ports only, for the game tab. 'tun': the whole machine, through the
     * app's shared adapter (tun-manager) on top of our SOCKS port — DNS inside the tunnel, IPv6
     * refused, the clean addresses kept out of the routes — with the kill switch and the DNS and
     * IPv6 blocks around it. Never a tunnel inside a tunnel: one adapter, one engine, one hop to
     * the runner.
     */
    async function bringUpV2(session, mode) {
        const full = mode === 'tun';
        wantedMode = mode;
        // Never ride, and never stop, somebody else's tunnel (P0) — nor build ours under a feature
        // that is about to take the adapter back.
        if (tun.isRunning() && !sharedTunnelIsOurs()) throw foreignTunnel();
        if (full && !sharedTunnelIsOurs() && adapterWantedElsewhere()) throw foreignTunnel();
        // A bare engine (the game tab) touches nothing machine-wide, so another engine's system
        // proxy stays as it is. The full tunnel cannot share the machine with one: the browser
        // would hand its traffic to that engine, whose uplink the adapter then captures and feeds
        // into ours — a tunnel inside a tunnel, on the client.
        if (mode !== 'engine' || systemProxyOwned) clearSystemProxy();
        // Whatever v1 left behind belongs to v1's adapter and would strand the machine.
        if (dataplane.v1.getStatus().running) {
            await guard.disengage(emitLog);
            await guard.unblockLanDns(emitLog);
            await guard.unblockIpv6(emitLog);
            await dataplane.v1.disconnect(emitLog);
        }
        // THE RECONNECT WINDOW (see bringUp): a guarded full tunnel keeps its guard — and the DNS
        // and IPv6 blocks — through a rebuild. Everything a rebuild needs is on its allow-list:
        // gtcore (the clean-IP measurement runs the same binary), sing-box, this app, loopback.
        const keepGuard = full && killSwitchEnabled && guard.isEngaged();
        if (keepGuard) emitLog('محافظ نشت در طول اتصال مجدد فعال می‌ماند — ترافیک شما در این فاصله بیرون نمی‌رود.');
        else {
            await guard.disengage(emitLog);
            await guard.unblockLanDns(emitLog);
            await guard.unblockIpv6(emitLog);
        }
        // Our own tunnel comes down before the engine under it.
        await stopOurTunnel('reconnect');
        // The line's own address, while it is still the line that answers — the leak test's
        // «your real address is hidden» needs it. Beside the connect, never in its way; behind a
        // kept guard it simply fails and the last one stands.
        const lineP = full ? verify.lineIdentity({ timeoutMs: 5000 }).catch(() => null) : null;
        engine = dataplane.v2;
        const fresh = await deployer.refreshTransport(session);
        const r = await engine.connect({ session: fresh, mode: full ? 'tun' : (mode === 'engine' ? 'engine' : 'proxy'), onLog: emitLog });
        if (lineP) { const l = await lineP; if (l && l.ip) lineId = l; }
        if (mode === 'proxy') setSystemProxy(true);
        if (full) {
            try {
                await buildFullTunnel();
            } catch (e) {
                // Never a half-built tunnel, and never an engine left «connected» over a machine
                // that is not using it. A guard kept up for this rebuild STAYS up: a failed
                // reconnect is exactly when fail-closed matters, and the user's disconnect is what
                // releases it (or the watchdog's next attempt succeeds).
                await stopOurTunnel('start failed');
                try { await engine.disconnect(emitLog); } catch (_) {}
                broadcastState();
                throw e;
            }
            await armGuards();
        }
        teardownReason = '';
        broadcastState();
        // The exit country, on this (possibly new) runner — after this transition releases the
        // lock, never inside it: bringing an exit up takes tens of seconds.
        scheduleExits('connect');
        return r;
    }

    // ── THE EXIT COUNTRY (P4, runner/exits.mjs) ─────────────────────────────────────
    // The user picks a country (and, optionally, sites that leave by another); every runner is
    // asked to bring those exits up, and the connection moves onto them as a different VLESS user
    // of the SAME tunnel — never a second tunnel on this PC. Until an exit is ready the traffic
    // leaves by the runner's own address, and the panel says so.
    const exitJob = { phase: 'idle', country: '', error: '', at: 0, forSession: '', failed: [] };
    let exitRunning = false;
    let exitAgain = false;
    const EXIT_WAIT_MS = 100000;

    /** The exits the prefs need from a runner: the default country, then each rule's. */
    function neededExits(prefs) {
        const out = [];
        const add = (country, provider) => { if (country && !out.some((x) => x.country === country && x.provider === provider)) out.push({ country, provider }); };
        add(prefs.country, prefs.provider);
        for (const r of prefs.rules) add(r.country, r.provider);
        return out;
    }
    const findExit = (exits, n) => (exits || []).filter((x) => x.country === n.country && (!n.provider || x.provider === n.provider) && x.state !== 'idle')
        .sort((a, b) => (a.state === 'ready' ? 0 : 1) - (b.state === 'ready' ? 0 : 1))[0] || null;
    /** The plan for one runner, from what it has READY: anything not ready leaves by `direct`. */
    function planFor(prefs, exits) {
        const ready = (n) => { const x = findExit(exits, n); return x && x.state === 'ready' ? x.id : null; };
        const use = prefs.country ? (ready({ country: prefs.country, provider: prefs.provider }) || 'direct') : 'direct';
        const rules = prefs.rules.map((r) => ({ id: ready(r), domains: r.domains })).filter((r) => r.id && r.id !== use);
        return { use, rules };
    }
    /**
     * Asks a runner — `ask` goes through the running tunnel, or through a throwaway core to the
     * next session — for every exit the prefs need, and waits until each is ready or has failed.
     */
    async function prepareExits(ask, prefs) {
        const need = neededExits(prefs);
        if (!need.length) return { plan: { use: 'direct', rules: [] }, failed: [], exits: [] };
        let exits = [];
        for (const n of need) {
            const r = await ask(`/x?cc=${n.country}${n.provider ? `&provider=${n.provider}` : ''}`);
            if (r && r.payload && Array.isArray(r.payload.exits)) exits = r.payload.exits;
        }
        const until = Date.now() + EXIT_WAIT_MS;
        while (Date.now() < until) {
            if (need.every((n) => { const x = findExit(exits, n); return x && x.state !== 'starting'; })) break;
            await new Promise((res) => setTimeout(res, 3000));
            const r = await ask('/s');
            if (r && r.payload && Array.isArray(r.payload.exits)) exits = r.payload.exits;
        }
        const failed = need.filter((n) => { const x = findExit(exits, n); return !x || x.state !== 'ready'; })
            .map((n) => { const x = findExit(exits, n); return { country: n.country, error: (x && x.error) || 'آماده نشد' }; });
        return { plan: planFor(prefs, exits), failed, exits };
    }
    const countryFa = (cc) => { try { return new Intl.DisplayNames(['fa'], { type: 'region' }).of(cc) || cc; } catch (e) { return cc; } };

    function scheduleExits(reason) {
        setImmediate(() => { ensureExits(reason).catch(() => {}); });
    }

    /**
     * The runner's exits that the prefs no longer name are stopped: it has six slots, and each
     * one is an OpenVPN or Psiphon process on it. Never one the connection is still on.
     */
    async function freeUnusedExits(exits, prefs, plan) {
        const need = neededExits(prefs);
        const inUse = new Set([plan.use, ...(plan.rules || []).map((r) => r.id)]);
        for (const x of exits || []) {
            if (!x || x.state === 'idle' || inUse.has(x.id)) continue;
            if (need.some((n) => x.country === n.country && (!n.provider || x.provider === n.provider))) continue;
            try { await dataplane.v2.askRunner(`/x/stop?id=${x.id}`); } catch (e) { /* the runner frees it at its end anyway */ }
        }
    }

    /** The running connection onto what the prefs ask for — brought up first, then switched. */
    async function ensureExits(reason = '') {
        if (exitRunning) { exitAgain = true; return; }
        const eng = dataplane.v2.getStatus();
        const session = deployer.activeSession();
        if (!eng.connected || !session || session.dataPlane !== 'v2') return;
        exitRunning = true;
        try {
            const prefs = store.getExitPrefs();
            const current = eng.exitPlan || { use: 'direct', rules: [] };
            const need = neededExits(prefs);
            if (!need.length) {
                // Back to the runner's own address, if the connection was anywhere else.
                if (current.use !== 'direct' || (current.rules || []).length) {
                    Object.assign(exitJob, { phase: 'switching', country: '', error: '', at: Date.now(), forSession: session.id, failed: [] });
                    broadcastState();
                    await exclusive(() => dataplane.v2.applyExitPlan({ use: 'direct', rules: [] }, { onLog: emitLog }));
                    emitLog('خروجی به «حداکثر سرعت» برگشت — آدرس خود سرور ابری.');
                }
                // What the runner has up NOW (the engine's copy can be a minute old).
                const fresh = await dataplane.v2.askRunner('/s').catch(() => null);
                await freeUnusedExits((fresh && fresh.payload && fresh.payload.exits) || eng.exits, prefs, { use: 'direct', rules: [] });
                Object.assign(exitJob, { phase: 'idle', country: '', error: '', at: Date.now(), failed: [] });
                return;
            }
            Object.assign(exitJob, { phase: 'preparing', country: prefs.country || need[0].country, error: '', at: Date.now(), forSession: session.id, failed: [] });
            broadcastState();
            emitLog(`خروجی ${need.map((n) => countryFa(n.country)).join('، ')} روی سرور ابری آماده می‌شود — تا آماده شود، ترافیک از آدرس خود سرور می‌رود.`);
            const { plan, failed, exits: runnerExits } = await prepareExits((p) => dataplane.v2.askRunner(p), prefs);
            // Still the same connection? A disconnect or a new session meanwhile makes this moot.
            const now = dataplane.v2.getStatus();
            const still = deployer.activeSession();
            if (!now.connected || !still || still.id !== session.id) { Object.assign(exitJob, { phase: 'idle' }); return; }
            Object.assign(exitJob, { phase: 'switching', at: Date.now() });
            broadcastState();
            const r = await exclusive(() => dataplane.v2.applyExitPlan(plan, { onLog: emitLog }));
            if (!r || !r.ok) throw new Error('اتصال روی خروجی تازه برقرار نشد.');
            const seen = r.exit && r.exit.country;
            if (prefs.country && plan.use !== 'direct' && seen && seen !== prefs.country) {
                emitLog(`خروجی درخواستی ${countryFa(prefs.country)} بود، ولی آدرسی که سایت‌ها می‌بینند در ${countryFa(seen)} است.`);
            }
            await freeUnusedExits(runnerExits, prefs, plan);
            Object.assign(exitJob, { phase: failed.length ? 'partial' : 'done', error: failed.map((f) => `${countryFa(f.country)}: ${f.error}`).join(' — '), at: Date.now(), failed });
            if (failed.length) emitLog(`این خروجی‌ها آماده نشدند: ${exitJob.error}. ترافیکشان از آدرس خود سرور ابری می‌رود.`);
            else emitLog(prefs.country ? `ترافیک حالا از ${countryFa(prefs.country)} خارج می‌شود${seen ? ` (آدرس دیده‌شده: ${countryFa(seen)})` : ''}.` : 'قانون‌های سایت فعال شدند.');
        } catch (e) {
            Object.assign(exitJob, { phase: 'failed', error: String((e && e.message) || e).slice(0, 240), at: Date.now() });
            emitLog(`خروجی کشوری آماده نشد: ${exitJob.error}`);
        } finally {
            exitRunning = false;
            broadcastState();
            if (exitAgain) { exitAgain = false; scheduleExits('again'); }
        }
    }

    /** The shared tunnel on top of gtcore, under the adapter's lock, proven before it is kept. */
    async function buildFullTunnel() {
        await tunLock('github-tunnel-on', async () => {
            // Somebody took the adapter while the engine was connecting: it is theirs now.
            if (tun.isRunning() && !sharedTunnelIsOurs()) throw foreignTunnel();
            const opts = await measureTunOptions();
            await bridgeStop();
            await tun.startTun(dataplane.v2.SOCKS_PORT, tunLog, opts);
            // NO FAKE TUNNEL — the same bar as the V2Ray tunnel: a real payload through the
            // finished adapter, or it does not stay up.
            if (!(await tun.verifyTunCarriesTraffic(tunLog, { bytes: 262144 }))) {
                throw Object.assign(new Error('تونل کامل بالا آمد ولی داده از آن رد نشد، پس روشن نماند و همه‌چیز به حالت قبل برگشت. «پروکسی سیستم» را امتحان کنید.'), { code: 'TUN_NO_DATA' });
            }
        });
    }

    /**
     * What the shared tunnel needs to know about this engine. The resolver is measured THROUGH it
     * (tun.pickTunnelResolver): which one the runner reaches, and over UDP or TCP.
     */
    async function measureTunOptions() {
        const port = dataplane.v2.SOCKS_PORT;
        let candidates;
        let logLevel = 'warn';
        try {
            const ns = require('../network-settings');
            // Settings › «سرور DNS بک‌اند», tried first when the user chose one — still only if the
            // runner actually reaches it.
            const chosen = ns.get().backendDns;
            if (require('net').isIPv4(chosen)) candidates = [...new Set([chosen, '8.8.8.8', '1.1.1.1', '9.9.9.9'])];
            logLevel = ns.tunLogLevel();
        } catch (e) { /* defaults */ }
        const resolver = await tun.pickTunnelResolver(port, candidates ? { candidates } : undefined);
        lastTunResolver = resolver ? resolver.server : null;
        if (!resolver) {
            throw Object.assign(new Error('هیچ پرس‌وجوی DNS از تونل گیت‌هاب رد نشد (نه UDP و نه TCP)، پس تونل کامل روشن نشد — اگر روشن می‌شد، هیچ برنامه‌ای نام سایت‌ها را پیدا نمی‌کرد. «پروکسی سیستم» را امتحان کنید.'), { code: 'TUN_NO_DNS' });
        }
        tunLog(`[TUN] توان این تونل: DNS از ${resolver.server} روی ${resolver.udp ? 'UDP' : 'TCP'} ✅ — QUIC رد می‌شود تا مرورگر بی‌درنگ از TCP برود.`);
        const ips = dataplane.v2.getStatus().ips || [];
        return {
            processName: [dataplane.v2.PROCESS_NAME],
            engineLabel: 'تونل گیت‌هاب',
            engineTag: 'gt',
            logLevel,
            // WARP's ranges and registration host are its uplink, not ours.
            apiSuffixes: [],
            uplinkCidrs: [],
            // The clean Cloudflare addresses gtcore dials, kept out of the ROUTES: re-opened from
            // sing-box's socket, a fragmented ClientHello would arrive re-merged. The /32 rule
            // that uplinkIps adds is the backstop. Anything ELSE bound for exactly these addresses
            // leaves beside the tunnel too — which the kill switch turns into a block, not a leak.
            uplinkIps: ips,
            routeExcludeAddress: ips.map((ip) => `${ip}/32`),
            supportsUdp: resolver.udp,
            remoteDns: resolver.server,
            // gtcore refuses UDP/443 itself (xudpProxyUDP443), so browsers are told «no» at the
            // adapter and take TCP at once instead of waiting out a timeout.
            rejectQuic: true,
            skipThroughputProbe: true,
            owner: TUN_OWNER,
            onPreempted,
            onExited: () => {
                emitLog('تونل کامل (sing-box) بسته شد — بررسی و بازسازی…');
                dataplane.v2.pokeWatchdog();
            },
        };
    }

    // ── handing the shared adapter over ──────────────────────────────────────────
    // Another feature taking the adapter — the V2Ray switch, WARP, the game tab — calls this and
    // WAITS for it (tun-manager › WHO OWNS THE SHARED TUNNEL), so the kill switch and the DNS/IPv6
    // blocks built around OUR tunnel are gone before its engine needs the network. Otherwise a
    // block-by-default firewall would outlive the tunnel it was for: no internet, and a panel that
    // still says «connected». Lock-free on purpose: it runs inside that feature's transition, and
    // our own `exclusive` may be queued behind the very lock that feature holds.
    async function onPreempted({ next } = {}) {
        // The game tab building its tunnel on OUR engine: the engine stays, it just stops carrying
        // the whole machine.
        const chained = !!(next && next.socksPort === dataplane.v2.SOCKS_PORT);
        emitLog(chained
            ? 'شتاب بازی تونل را روی همین موتور ساخت — محافظ نشت و قفل‌ها برداشته شدند؛ موتور روشن می‌ماند.'
            : 'بخش دیگری از برنامه مسیر سیستم را گرفت — تونل گیت‌هاب قطع شد و محافظ نشت و قفل‌ها برداشته شدند.');
        try { await guard.disengage(emitLog); } catch (e) {}
        try { await guard.unblockLanDns(emitLog); } catch (e) {}
        try { await guard.unblockIpv6(emitLog); } catch (e) {}
        if (chained && dataplane.v2.setMode('engine')) { /* still up, as a bare engine */ }
        else {
            try { await dataplane.v2.disconnect(emitLog); } catch (e) {}
            teardownReason = 'PREEMPTED';
        }
        broadcastState();
    }

    function engageGuard() {
        if (engine === dataplane.v2) {
            // The shared adapter, and every program that must reach the internet beside it:
            // gtcore (its uplink, and the clean-IP measurement a repair runs), every copy of
            // sing-box (it owns the socket of everything the rules send `direct`), and this app
            // (the session and GitHub calls a repair needs).
            const corePaths = require('../core-paths');
            const bins = tun.binPaths();
            const bundledSingbox = path.join(path.dirname(bins.config), 'sing-box.exe');
            return guard.engage({
                adapterName: tun.TUN_IFACE_NAME,
                allowPrograms: [...new Set([
                    dataplane.v2.daemonExe(),
                    bins.exe,
                    ...corePaths.candidates('singbox', 'sing-box.exe', bundledSingbox),
                    process.execPath,
                ])],
                onLog: emitLog,
            });
        }
        return guard.engage({
            adapterName: engine.TUN_ADAPTER,
            // Both the copy that would start now and the one a running daemon came from — see the
            // same rule in server.js's WARP guard.
            allowPrograms: [...require('../core-paths').candidates('tailscale', 'tailscaled.exe', engine.DAEMON_EXE), process.execPath],
            onLog: emitLog,
        });
    }

    /** Everything this feature can have switched on, switched back off, in the only order
     *  that never leaves the machine pointed at something dead. */
    async function teardownAll(reason) {
        // Our full tunnel, or a game tunnel built on our engine, dies with it — nobody else's.
        const hadTunnel = sharedTunnelIsOurs();
        await stopOurTunnel('teardown');
        clearSystemProxy();
        await guard.disengage(emitLog);
        // Before the engine goes: with the tunnel gone, the router may be the only DNS left.
        await guard.unblockLanDns(emitLog);
        // Likewise, IPv6 is the machine's own again the moment there is no tunnel to keep it out of.
        await guard.unblockIpv6(emitLog);
        // Both engines: teardown must not depend on remembering which one was up.
        await dataplane.v2.disconnect(emitLog);
        await dataplane.v1.disconnect(emitLog);
        // Last, once the firewall lets a WARP engine reach its edge again: the bridge's own start
        // proves a lookup through that engine before it repoints Windows.
        if (hadTunnel) await bridgeRestore();
        teardownReason = reason || '';
        broadcastState();
    }

    for (const e of bothEngines()) {
        e.setWatchdogLogger((m) => { emitLog(m); broadcastState(); });

        // How the watchdog recovers a connection whose DAEMON has died, as opposed to one that
        // merely lost its exit node. It cannot do that itself: rebuilding needs the session and
        // (v1) an auth key or (v2) freshly measured clean IPs, which the engine does not hold.
        // Without this the watchdog spent its three attempts on a control socket that no longer
        // existed and then gave up — on a fault a restart fixes in ten seconds.
        e.setRebuildHandler((mode) => exclusive(() => bringUp(mode)));

        // A degraded tunnel must fail closed, not keep passing traffic on the real address.
        e.setDegradedHandler(async (verdict) => {
            emitLog(`تونل ناسالم شد (${verdict.code}) — ترافیک تا بازیابی مسدود می‌ماند.`);
            if (killSwitchEnabled && !guard.isEngaged() && e.getStatus().mode === 'tun') {
                try { await engageGuard(); } catch (err) {}
            }
            broadcastState();
        });
    }

    // v2's full tunnel is two processes: gtcore, which the SOCKS probe sees, and the shared
    // adapter's sing-box, which it cannot. The adapter is asked first on every look.
    dataplane.v2.setLivenessCheck(async () => {
        if (!tun.isRunning() || tun.currentOwner() !== TUN_OWNER) {
            return { ok: false, immediate: true, code: 'TUN_DOWN', message: 'تونل کامل دیگر بالا نیست.' };
        }
        const live = await tun.fastLive().catch(() => ({ ok: false }));
        if (live.ok && (!live.adapter || !live.defaultViaTun)) {
            return { ok: false, immediate: true, code: 'TUN_DOWN', message: 'مسیر پیش‌فرض سیستم دیگر روی تونل نیست.' };
        }
        return { ok: true };
    });

    // ── the status channel → the store ───────────────────────────────────────────
    // A quick tunnel the runner replaced reaches us through the tunnel itself (gt-core ›
    // statusTick); kept here too, so a later reconnect — or the next launch — starts from the
    // hosts that are alive rather than the ones from the start of the session.
    dataplane.v2.setTransportHandler(async (session, sealed, payload) => {
        const cur = store.getSession(session.id);
        if (!cur || !cur.v2) return null;
        return store.updateSession(session.id, { v2: { ...cur.v2, sealed, rev: payload.rev || 0, hosts: payload.hosts.length } });
    });
    // The runner says its end is near: the next session is made ready now (MAKE-BEFORE-BREAK).
    dataplane.v2.setEndingHandler(() => { continuityTick().catch(() => {}); });

    // A dead tunnel is repaired against a runner that is still THERE; a runner that is gone is
    // replaced instead (FAILOVER) — three reconnects to a machine that no longer exists would
    // only spend the minutes the kill switch keeps the user offline.
    dataplane.v2.setRebuildHandler((mode) => exclusive(async () => {
        const s = deployer.activeSession();
        if (s && s.dataPlane === 'v2') {
            let now = s;
            try { now = await deployer.reconcile(s, { force: true }); } catch (e) { now = s; }
            if (now && ['EXPIRED', 'FAILED'].includes(now.status)) {
                if (await failover(now)) return { ok: true, failover: true };
                throw Object.assign(new Error('نشست ابری پایان یافته است.'), { code: 'SESSION_ENDED' });
            }
        }
        return bringUp(mode);
    }));

    // Three repairs failed. With the kill switch up the machine STAYS closed — handing the real
    // address back to a browser that is mid-session on a site that bans it is the one outcome this
    // feature exists to prevent — and the panel says so, next to the button that releases it.
    dataplane.v2.setGaveUpHandler(({ mode }) => {
        teardownReason = 'REPAIR_GAVE_UP';
        if (mode === 'tun' && guard.isEngaged()) {
            emitLog('تونل گیت‌هاب بعد از چند تلاش برنگشت. محافظ نشت اینترنت را بسته نگه می‌دارد تا آی‌پی واقعی شما لو نرود — برای برگرداندن اینترنت «قطع اتصال» را بزنید، یا «تمدید» تا نشست تازه ساخته شود.');
        } else {
            emitLog('تونل گیت‌هاب بعد از چند تلاش برنگشت. «قطع اتصال» را بزنید، یا «تمدید» تا نشست تازه ساخته شود.');
        }
        broadcastState();
    });

    app.post('/api/github-tunnel/connect', handle(async (req) => {
        // The full tunnel unless asked otherwise: it is the only mode that covers every app, DNS
        // and UDP, and the only one the guards can be built around.
        const asked = req.body && req.body.mode;
        const mode = asked === 'proxy' || asked === 'tun' ? asked : 'tun';
        return { ok: true, ...(await exclusive(() => bringUp(mode))) };
    }));

    /**
     * Hand the data plane to server.js, so another feature can bring this tunnel up.
     *
     * The «بازی» tab races every engine the app has and must be able to start this one
     * without the user going to the GitHub Tunnel panel. What it gets is exactly what the
     * button above calls — the same mutex, the same key minting, the same leak guard and
     * watchdog. Anything less than the real path would be a second, subtly different way
     * to connect, and the two would drift apart.
     */
    if (typeof expose === 'function') {
        expose({
            // 'engine' (ports only) exists for v2 alone — its SOCKS port carries UDP, so the game
            // tab measures and routes through it like any other engine. v1's does not.
            bringUp: (mode) => exclusive(() => bringUp(mode === 'proxy' || mode === 'engine' ? mode : 'tun')),
            teardown: () => exclusive(() => teardownAll('')),
            status: () => currentEngine().getStatus(),
            // Which data plane a connect would use RIGHT NOW: the live session's, or none.
            dataPlane: () => { const s = deployer.activeSession(); return s ? (s.dataPlane === 'v2' ? 'v2' : 'v1') : null; },
        });
    }

    app.post('/api/github-tunnel/disconnect', handle(async () => {
        // Tear the traffic paths down BEFORE the engine, never after: killing the engine
        // first would leave the system pointed at a dead proxy (or a TUN with no upstream)
        // and take the machine's internet down with it.
        await exclusive(() => teardownAll(''));
        return { ok: true };
    }));

    /**
     * End the CLOUD session, not just the local tunnel.
     *
     * This is the difference between "I stopped using it" and "it stopped costing me". A
     * plain disconnect only takes the data plane down; the GitHub runner keeps executing
     * until its own timeout and keeps consuming the account's Actions allowance the whole
     * time — on a Windows runner at 2x, an idle session left up after a one-hour need burns
     * roughly nine hours of a 2,000-minute monthly allowance for nothing.
     *
     * Deliberately NOT wired into the disconnect button. Disconnect is also the reconnect
     * path (mode switches, watchdog rebuilds, a dropped link the user retries), and a
     * session that cancels itself every time the tunnel blinks would make reconnecting
     * impossible — a new session means a new runner, several minutes of provisioning, and
     * another slice of allowance. Ending is therefore an explicit, separate act.
     */
    app.post('/api/github-tunnel/session/end', handle(async () => {
        const session = deployer.activeSession();
        if (!session) {
            await exclusive(() => teardownAll(''));
            return { ok: true, ended: false };
        }
        const accountId = session.accountId;

        // Data plane first: once the runner is cancelled the exit node is gone, and a TUN
        // still pointed at it behind an engaged kill-switch is a machine with no internet.
        await exclusive(() => teardownAll('SESSION_ENDED'));
        await deployer.endSession(session, emitLog);
        // A next session made ready for a swap that will now never happen is spending minutes too.
        const standby = continuity.nextId ? store.getSession(continuity.nextId) : null;
        if (standby && standby.status === 'STANDBY') await deployer.endSession(standby, emitLog);
        Object.assign(continuity, { phase: 'idle', forSession: '', nextId: '', tries: 0, error: '' });
        emitLog('نشست ابری پایان یافت — مصرف دقیقه‌های گیت‌هاب از همین لحظه متوقف شد.');

        // Re-read the allowance now rather than at the next poll. The run's real duration is
        // only final once it has stopped, so this is the first moment the number the user is
        // about to look at can be the true one. Never fatal: a billing read that fails says
        // nothing about whether the session ended.
        if (accountId) {
            try { await quota.refresh(accountId, { force: true }); } catch (e) {}
        }
        broadcastState();
        return { ok: true, ended: true, accounts: accountsView() };
    }));

    // ── the two switches ─────────────────────────────────────────────────────────
    // They are two faces of one setting, not two independent toggles: the engine can only
    // be in one mode at a time, and turning either on means restarting it in that mode.

    // Full tunnel: kernel WireGuard adapter, all traffic, UDP included (games, QUIC).
    app.post('/api/github-tunnel/tun', handle(async (req) => {
        const enable = !!(req.body && req.body.enabled);
        if (!enable) {
            await exclusive(() => teardownAll(''));
            return { ok: true, running: false };
        }
        return { ok: true, running: true, ...(await exclusive(() => bringUp('tun'))) };
    }));

    // System proxy: userspace engine, TCP only, no adapter — the compatibility fallback.
    app.post('/api/github-tunnel/proxy', handle(async (req) => {
        const enable = !!(req.body && req.body.enabled);
        if (!enable) {
            await exclusive(() => teardownAll(''));
            return { ok: true, enabled: false };
        }
        return { ok: true, enabled: true, ...(await exclusive(() => bringUp('proxy')))  };
    }));

    // Full reset: everything this feature stored, back to first-run state.
    app.post('/api/github-tunnel/reset', handle(async () => {
        // Order matters. Tear the live pieces down FIRST — a guard left engaged or DNS
        // policy left installed after the config that describes them is gone would be
        // unrecoverable from inside the app.
        await exclusive(() => teardownAll(''));

        // Best-effort: stop every cloud session still running, EACH on the account that
        // owns it, so a reset doesn't leave orphaned runners spending allowances the user
        // is about to lose the ability to cancel (the tokens are wiped a few lines below).
        for (const s of store.getSessions()) {
            if (['READY', 'ACTIVE', 'EXPIRING_SOON', 'STARTING', 'SETTING_UP', 'STANDBY', 'ENDING'].includes(s.status)) {
                try { await deployer.endSession(s, emitLog); } catch (e) {}
            }
        }

        const r = store.resetAll();
        for (const a of accounts.list()) accounts.remove(a.id);
        provisioning = null;
        emitLog('همه‌ی تنظیمات GitHub Tunnel پاک شد.');
        broadcastState();
        return { ok: true, ...r };
    }));

    // ── startup self-heal ────────────────────────────────────────────────────────
    // A previous run may have been killed without cleaning up — crash, Task Manager, an
    // antivirus, power loss. Two things it can leave behind are not "the tunnel didn't
    // work", they are "this PC has no internet and nothing on screen says why":
    //   1. the guard's block-by-default firewall profile, whose only allow rules point at
    //      an adapter that no longer exists;
    //   2. tailscaled's NRPT DNS policy, pointing every lookup at a dead resolver.
    // Both are undone here, before the user touches anything, and in that order — being
    // able to resolve names is no use while every packet is still dropped.
    //
    // This runs unconditionally: no session, no GitHub account and never having opened the
    // panel are all irrelevant to a machine that is currently firewalled shut.
    (async () => {
        try {
            const r = await guard.restoreIfStale(emitLog);
            if (r.error) emitLog(`محافظ نشت باقی‌مانده برداشته نشد: ${r.error}`);
        } catch (e) {}
        for (const e of bothEngines()) { try { await e.sweepStaleState(); } catch (err) {} }
        // After the restore, so what it reads is the machine's own state: the panel can say the
        // firewall is off BEFORE the first connect, not only after the guards refused.
        try { await guard.refreshFirewall(); } catch (e) {}
    })();

    // ── the session outliving the tunnel, and vice versa ─────────────────────────
    // The cloud session has a hard end: the countdown running out, GitHub cancelling the
    // run, the runner being evicted. When that happens the local engine does not notice
    // anything — it still has a node, still has a "selected" exit node, and the guard is
    // still blocking everything else. The result is a machine with no internet, an app
    // showing a tunnel that is fine, and (because the panel only draws the engine controls
    // while a session is ACTIVE) no disconnect button left on screen to get out of it.
    //
    // So session liveness is checked on the server, on its own timer, rather than being
    // left to whatever the open panel happens to poll.
    // ── MAKE-BEFORE-BREAK ────────────────────────────────────────────────────────
    // A cloud session has a hard end (~5½ h). While the tunnel is IN USE, the next session is
    // made ready before that end — on another account when one is free — and swapped in with ONE
    // short reconnect; with the kill switch up that moment is blocked, not leaked. The old runner
    // is cancelled right after, so its last minutes are not spent for nothing. The same parts
    // replace a runner that dies mid-session (FAILOVER). An idle tunnel is never renewed: nobody
    // spends an allowance on a tunnel nobody uses.
    const RENEW_LEAD_MS = 8 * 60 * 1000;
    const MAX_PREPARE_TRIES = 3;
    const continuity = { phase: 'idle', forSession: '', nextId: '', tries: 0, error: '', at: 0 };
    let continuityRunning = false;

    async function continuityTick() {
        if (continuityRunning || !store.getAutoRenew()) return;
        const s = deployer.activeSession();
        if (!s || s.dataPlane !== 'v2' || !s.expiresAt) return;
        const eng = dataplane.v2.getStatus();
        if (!eng.connected) return;
        const remaining = s.expiresAt - github.serverNow();
        if (remaining > RENEW_LEAD_MS && !eng.ending) return;
        if (continuity.forSession !== s.id) Object.assign(continuity, { phase: 'idle', forSession: s.id, nextId: '', tries: 0, error: '' });
        if (continuity.tries >= MAX_PREPARE_TRIES && continuity.phase === 'failed') return;
        continuityRunning = true;
        try {
            let next = continuity.nextId ? store.getSession(continuity.nextId) : null;
            if (!next || next.status !== 'STANDBY') {
                Object.assign(continuity, { phase: 'preparing', at: Date.now(), error: '' });
                continuity.tries++;
                broadcastState();
                emitLog('نشست ابری تا چند دقیقهٔ دیگر تمام می‌شود — نشست بعدی از همین حالا آماده می‌شود تا جابه‌جایی بی‌وقفه باشد.');
                next = await deployer.createSession({ dataPlane: 'v2', standby: true, onLog: (m) => emitLog(`نشست بعدی: ${m}`) });
                continuity.nextId = next.id;
            }
            // PROVEN BEFORE ANYTHING MOVES — outside the lock, while the current session still
            // carries traffic. A quick tunnel that has only just come up can need a few seconds
            // before it answers through the Worker; a next session that never answers is not
            // switched to at all: it is ended, the current one keeps working, and the next tick
            // tries again (up to MAX_PREPARE_TRIES).
            let fresh = next;
            try { fresh = await deployer.refreshTransport(next); } catch (e) { /* the stored copy */ }
            const proof = await dataplane.v2.proveSession(fresh, { onLog: emitLog });
            if (!proof.ok && proof.reason !== 'not-connected') {
                continuity.nextId = '';
                deployer.endSession(store.getSession(next.id) || next).catch(() => {});
                throw Object.assign(new Error(proof.message || 'نشست بعدی از Worker شما جواب نداد.'), { code: proof.code || '' });
            }
            // THE EXIT COUNTRY, READY BEFORE THE MOVE: the next runner brings the user's exits up
            // while this one still carries the traffic, so a renewal never shows a site the
            // runner's own country for a minute. Asked through a throwaway core to that session.
            let nextPlan = null;
            const prefs = store.getExitPrefs();
            if (proof.ok && neededExits(prefs).length) {
                emitLog('خروجی کشوری روی نشست بعدی آماده می‌شود — نشست فعلی همچنان وصل است…');
                const prep = await prepareExits((p) => dataplane.v2.askSession(fresh, p, { onLog: emitLog }), prefs);
                nextPlan = prep.plan;
                if (prep.failed.length) emitLog(`روی نشست بعدی آماده نشد: ${prep.failed.map((f) => countryFa(f.country)).join('، ')} — بعد از جابه‌جایی دوباره امتحان می‌شود.`);
            }
            continuity.phase = 'switching';
            broadcastState();
            await exclusive(() => cutover(s, next, nextPlan));
            Object.assign(continuity, { phase: 'done', error: '', at: Date.now() });
            // Whatever the next runner could not bring up in time is asked for again, now on it.
            if (neededExits(prefs).length) scheduleExits('renewed');
        } catch (e) {
            Object.assign(continuity, { phase: 'failed', error: String((e && e.message) || e).slice(0, 300), at: Date.now() });
            emitLog(`نشست بعدی آماده نشد: ${continuity.error}${continuity.tries < MAX_PREPARE_TRIES ? ' — دوباره امتحان می‌شود.' : ''}`);
        } finally {
            continuityRunning = false;
            broadcastState();
        }
    }

    /** The swap: the next session in, one reconnect, the old runner cancelled. */
    async function cutover(prev, next, nextPlan = null) {
        const st = dataplane.v2.getStatus();
        if (!st.connected && !guard.isEngaged()) {
            // Disconnected while the next one was being made: nobody needs it.
            await deployer.endSession(next, emitLog);
            return;
        }
        const mode = wantedMode || st.mode || 'tun';
        deployer.promoteStandby(next, prev);
        // HOT FIRST: the next session proven on the clean addresses in use while the old one still
        // carries traffic, then only the core restarts — the full tunnel, its guards and its DNS
        // stay exactly as they are (gt-core.js › swapSession). A full reconnect only if that fails.
        let hot = { ok: false };
        if (st.connected && engine === dataplane.v2) {
            try {
                const fresh = await deployer.refreshTransport(store.getSession(next.id) || next);
                hot = await dataplane.v2.swapSession(fresh, { onLog: emitLog, exitPlan: nextPlan });
            } catch (e) { hot = { ok: false, stopped: !dataplane.v2.getStatus().connected, reason: e.code || e.message }; }
            if (!hot.ok) {
                emitLog(hot.stopped
                    ? 'نشست تازه بعد از جابه‌جایی سریع داده رد نکرد — اتصال کامل روی آن از نو ساخته می‌شود.'
                    : 'نشست تازه روی آی‌پی‌های تمیز فعلی جواب نداد — اتصال کامل روی آن از نو ساخته می‌شود.');
            }
        }
        if (!hot.ok) {
            try {
                await bringUp(mode);
            } catch (e) {
                // The new one would not carry traffic: back on the old one while it lasts.
                deployer.demoteStandby(next, prev);
                deployer.endSession(store.getSession(next.id) || next).catch(() => {});
                try { await bringUp(mode); } catch (_) {}
                throw e;
            }
        }
        await deployer.endSession(store.getSession(prev.id) || prev, emitLog);
        emitLog(hot.ok
            ? 'به نشست تازه منتقل شد — فقط هستهٔ تونل یک بار دوباره راه افتاد (حدود یک ثانیه)؛ تونل کامل، محافظ‌ها و DNS دست نخوردند. نشست قبلی بسته شد تا دقیقه‌هایش هدر نرود.'
            : 'به نشست تازه منتقل شد — اتصال فقط یک بار و برای چند ثانیه قطع شد؛ نشست قبلی بسته شد تا دقیقه‌هایش هدر نرود.');
    }

    // ── FAILOVER ─────────────────────────────────────────────────────────────────
    // The runner is gone mid-session — cancelled, evicted, a GitHub incident. With the tunnel in
    // use and «تمدید خودکار» on, a new session (the standby one if it is ready) takes its place
    // while the guard keeps the machine CLOSED, instead of the old answer: release everything and
    // let the user's real address out. Called inside `exclusive`.
    async function failover(dead) {
        if (!store.getAutoRenew()) return false;
        const eng = dataplane.v2.getStatus();
        const wasV2 = dead ? dead.dataPlane === 'v2' : dataplane.active() === dataplane.v2;
        const inUse = eng.connected || eng.running || !!eng.repairing || guard.isEngaged();
        if (!wasV2 || !inUse) return false;
        const mode = wantedMode || eng.mode || 'tun';
        emitLog('سرور ابری از دست رفت — نشست تازه ساخته می‌شود. محافظ نشت در این فاصله بسته می‌ماند.');
        // Our full tunnel points at a runner that no longer exists: down, guard kept, so the calls
        // a new session needs leave straight from this app (it is on the kill switch's allow-list)
        // instead of into the dead tunnel.
        await stopOurTunnel('runner gone');
        try {
            let next = continuity.nextId ? store.getSession(continuity.nextId) : null;
            if (next && next.status === 'STANDBY') deployer.promoteStandby(next, null);
            else next = await deployer.createSession({ dataPlane: 'v2', onLog: (m) => emitLog(`نشست تازه: ${m}`) });
            await bringUp(mode);
            emitLog('اتصال روی نشست تازه برگشت.');
            return true;
        } catch (e) {
            emitLog(`جایگزینی نشست ابری ناموفق بود: ${String((e && e.message) || e).split('\n')[0]}`);
            return false;
        }
    }

    // «تمدید خودکار بی‌وقفه» — kept across restarts (gt-config).
    app.post('/api/github-tunnel/autorenew', handle(async (req) => {
        const v = store.setAutoRenew(!(req.body && req.body.enabled === false));
        emitLog(v ? 'تمدید خودکار بی‌وقفه روشن شد.' : 'تمدید خودکار بی‌وقفه خاموش شد — نشست در پایانش بسته می‌شود.');
        return { ok: true, autoRenew: v };
    }));

    const SESSION_WATCH_MS = 30 * 1000;
    const sessionWatch = setInterval(() => {
        // Checked BEFORE taking the lock. Inside it, this tick would mark the data plane
        // busy thirty times an hour for nothing, and the panel disables its switches while
        // that flag is set — a toggle that goes dead for no visible reason is its own bug.
        const engNow = dataplane.active().getStatus();
        if (!engNow.connected && !engNow.running && !guard.isEngaged()) return;

        exclusive(async () => {
            const eng = dataplane.active().getStatus();
            if (!eng.connected && !eng.running && !guard.isEngaged()) return;

            // activeSession(), not "the newest session": while a renewal is provisioning,
            // the newest record is a half-built one in SETTING_UP, and reading that as
            // "no live session" would tear down the tunnel the user is still using.
            let s = deployer.activeSession();
            if (s) {
                // Arithmetic is not enough — a run can also end EARLY. reconcile() is what
                // catches a cancelled or evicted runner, and it rate-limits itself.
                try { s = await deployer.reconcile(s); } catch (e) { return; }
                s = deployer.tick(s);
                if (s && ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status)) return;
            }
            // A runner lost while the tunnel is in use is REPLACED, guard kept closed — not
            // handed back to the user's real address (FAILOVER).
            if (await failover(s)) return;
            emitLog('نشست ابری پایان یافت — اتصال بسته شد. از این پس ترافیک شما مستقیم و با آی‌پی واقعی خارج می‌شود؛ برای ادامه «تمدید» بزنید.');
            await teardownAll('SESSION_ENDED');
        }).catch(() => {});
    }, SESSION_WATCH_MS);
    if (typeof sessionWatch.unref === 'function') sessionWatch.unref();

    // Checked on its own clock and OUTSIDE the lock: making the next session ready takes a
    // minute, and the panel's switches must not go dead for it. Only the swap takes the lock.
    const continuityTimer = setInterval(() => { continuityTick().catch(() => {}); }, 30 * 1000);
    if (typeof continuityTimer.unref === 'function') continuityTimer.unref();

    if (broadcastLog) emitLog('GitHub Tunnel routes registered');
};
