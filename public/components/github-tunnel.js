// --- پنل GitHub Tunnel ---
// در #ls-github-tunnel رندر می‌شود و با /api/github-tunnel/* روی سرور محلی صحبت می‌کند.
//
// This file is the window itself: its state, the data it reads, the frame (sidebar, pane, the
// stage with the power button) and the render loop. What each part SHOWS lives in its own file,
// loaded before this one — gt-ui.js (the kit pieces and the action registry), gt-session.js,
// gt-accounts.js, gt-route.js, gt-exit.js and gt-broker.js.
//
// کاربر فقط این مراحل را می‌بیند: اتصال گیت‌هاب -> ادامه -> یک لیست پیشرفت -> کارت شمارش
// معکوس با دکمه‌های اتصال/تمدید.

const gtState = {
    githubStatus: null,   // /api/github-tunnel/github/status
    status: null,          // /api/github-tunnel/status  ({ provisioning, session })
    broker: null,           // /api/github-tunnel/broker/status
    pollTimer: null,
    githubPollTimer: null,
    connecting: false,     // فوراً بعد از کلیک «اتصال به گیت‌هاب» تا اولین پاسخ سرور
    brokerDeploying: false,
    brokerError: '',
    forceBrokerSetup: false, // با «پیکربندی مجدد سرویس شبکه‌ی امن» فعال می‌شود، حتی اگر broker از قبل دیپلوی شده باشد
    engine: null,            // /api/github-tunnel/engine/status → { engine, tun, systemProxy }
    busy: '',                // 'connect' | 'proxy' | 'tun' | … — برای غیرفعال کردن دکمه‌ها حین عملیات
    accounts: null,          // /api/github-tunnel/accounts → { accounts, currentAccountId }
    view: 'main',            // 'main' | 'accounts'
    addingAccount: false,    // جریان افزودن حساب، حتی وقتی حساب دیگری از قبل هست
    speed: null,             // the last path/speed report
    lastFailure: null,       // { code, message, at } — the advice card reads it
    slotsBusy: '',
    slotsError: '',
    // What the window itself remembers between redraws: open disclosures, the country pickers
    // (open, search text, the rule's country), and what was typed into a field (by its id).
    ui: { open: {}, cc: {}, ccQuery: {}, ruleCc: '' },
    drafts: {},
};

async function gtFetch(path, opts = {}) {
    const res = await fetch(path, {
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `خطا (${res.status})`), { code: data.code || '' });
    return data;
}

// ── ERROR-DRIVEN ADVICE ──────────────────────────────────────────────────────────
// A failure the server names by code gets one finding and ONE button that does the fix — not a
// sentence to decipher. Anything unrecognised keeps its own words and no invented cause.
const GT_ADVICE = {
    NO_CLEAN_IP: { fa: 'هیچ آی‌پی تمیز کلادفلری از این خط به سرویس شبکهٔ امن شما نرسید.', btn: 'پیدا کردن آی‌پی تمیز', run: () => { if (window.MV && MV.wm) MV.wm.open('scanner'); } },
    TUN_NO_DNS: { fa: 'تونل کامل روشن نشد چون هیچ DNS‌ای از آن جواب نداد. پروکسی سیستم با همین نشست کار می‌کند (پوشش جزئی).', btn: 'روشن کردن پروکسی سیستم', run: () => gtToggleProxy(true) },
    TUN_NO_DATA: { fa: 'تونل کامل بالا آمد ولی داده از آن رد نشد. پروکسی سیستم با همین نشست کار می‌کند (پوشش جزئی).', btn: 'روشن کردن پروکسی سیستم', run: () => gtToggleProxy(true) },
    TUN_BUSY: { fa: 'تونل کامل یک بخش دیگر (V2Ray، ماسک، وایرگارد، وارپ در وارپ…) روشن است. اول آن را خاموش کنید.', btn: '', run: null },
    QT_UNAVAILABLE: { fa: 'سرور ابری روشن شد ولی کلادفلر برایش تونل نساخت. معمولاً با یک نشست تازه درست می‌شود.', btn: 'ساخت نشست تازه', run: () => gtActivateAgain(true) },
    SESSION_TIMEOUT: { fa: 'نشست ابری در زمان مقرر آماده نشد.', btn: 'ساخت نشست تازه', run: () => gtActivateAgain(true) },
    SESSION_ENDED: { fa: 'نشست ابری پایان یافته است.', btn: 'ساخت نشست تازه', run: () => gtActivateAgain(true) },
    REPAIR_GAVE_UP: { fa: 'تونل بعد از چند تلاش برنگشت. اگر محافظ نشت روشن است، اینترنت تا «قطع اتصال» بسته می‌ماند.', btn: 'ساخت نشست تازه', run: () => gtActivateAgain(true) },
    RUN_DIED_EARLY: { fa: 'سرور ابری بلافاصله بعد از شروع متوقف شد — معمولاً یعنی سهمیهٔ ماهانهٔ این حساب گیت‌هاب تمام شده است.', btn: 'افزودن حساب گیت‌هاب', run: () => gtAddAccount() },
    BROKER_NOT_DEPLOYED: { fa: 'سرویس شبکهٔ امن (Worker کلادفلر شما) هنوز راه‌اندازی نشده است.', btn: 'راه‌اندازی سرویس شبکهٔ امن', run: () => gtGoSec('broker') },
    BROKER_NEEDS_UPDATE: { fa: 'سرویس شبکهٔ امن یک به‌روزرسانی لازم دارد.', btn: 'به‌روزرسانی سرویس شبکهٔ امن', run: () => gtGoSec('broker') },
    // The line reached the Worker; what failed is behind it (gt-core.js › noPathError).
    TUNNEL_UNREACHABLE: { fa: 'خط شما سالم است و به Worker کلادفلرتان می‌رسد؛ این سرور ابری است که دیگر جواب نمی‌دهد.', btn: 'ساخت نشست تازه', run: () => gtActivateAgain(true) },
    BROKER_LIMIT: { fa: 'Worker کلادفلر شما سقف درخواست‌هایش را پر کرده است (معمولاً سقف روزانهٔ حساب رایگان، که فردا دوباره باز می‌شود).', btn: '', run: null },
    BROKER_REFUSED: { fa: 'Worker کلادفلر شما این اتصال را رد کرد.', btn: 'به‌روزرسانی سرویس شبکهٔ امن', run: () => gtGoSec('broker') },
    PREEMPTED: { fa: 'بخش دیگری از برنامه مسیر سیستم را گرفت و تونل گیت‌هاب قطع شد.', btn: 'وصل شدن دوباره', run: () => gtConnectEngine() },
    NOT_RUNNING: { fa: 'هستهٔ تونل از کار افتاد.', btn: 'وصل شدن دوباره', run: () => gtConnectEngine() },
    NO_EGRESS: { fa: 'تونل بالا آمد ولی داده‌ای از آن عبور نکرد.', btn: 'وصل شدن دوباره', run: () => gtConnectEngine() },
};

/** Keep the last failure a switch or button hit, for the advice card. */
function gtNoteFailure(e) {
    gtState.lastFailure = e && (e.code || e.message) ? { code: e.code || '', message: e.message || '', at: Date.now() } : null;
}

// حساب‌های کلادفلر در «زیرساخت ابری» سمت مرورگر (PersistentStorage['cf_accounts']) نگه
// داشته می‌شوند نه در سرور — همان کلیدی که public/components/cloud.js می‌خواند/می‌نویسد.
function gtLoadCfAccounts() {
    try {
        const raw = PersistentStorage.getItem('cf_accounts');
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter(a => a && a.token) : [];
    } catch (e) { return []; }
}

function gtToast(msg) {
    if (typeof toast === 'function') toast(msg); else console.log('[github-tunnel]', msg);
}

function gtEsc(s) { return GTUI.esc(s); }

function gtFmtCountdown(ms) {
    if (ms <= 0) return '۰۰:۰۰:۰۰';
    const total = Math.floor(ms / 1000);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

/** Clipboard with a prompt fallback — the API can be refused depending on window focus,
 *  and losing a one-time code to a silent failure is worse than an ugly dialog. */
function gtCopyText(text, okMsg) {
    try {
        navigator.clipboard.writeText(text);
        gtToast(okMsg || 'کپی شد.');
    } catch (e) {
        window.prompt('کپی کنید:', text);
    }
}

// ── data ─────────────────────────────────────────────────────────────────────────
// همه‌ی توابع رفرش، خطای شبکه را خودشان می‌بلعند تا هیچ Promise ردشده‌ای بدون catch نماند
// (fetch به سمت سروری که هنوز بالا نیامده باشد وگرنه Unhandled Promise Rejection می‌سازد).

async function gtRefreshGithub() {
    try {
        gtState.githubStatus = await gtFetch('/api/github-tunnel/github/status');
    } catch (e) { /* سرور هنوز آماده نیست؛ در تیک بعدی دوباره تلاش می‌شود */ }
    gtRender();
}

async function gtRefreshStatus() {
    try {
        gtState.status = await gtFetch('/api/github-tunnel/status');
    } catch (e) { /* همان بالا */ }
    gtRender();
    gtMaybeOfferRoute();

    // Provisioning has stopped moving, so stop hammering it — but do NOT stop polling.
    // Killing the timer here also killed the ENGINE refresh that rides the same tick, so
    // after any failed setup the connection status froze at whatever it last was: a tunnel
    // that dropped, or a kill-switch that engaged, showed nothing at all. Slow down instead.
    const p = gtState.status && gtState.status.provisioning;
    if (p && p.state === 'FAILED' && gtState.pollFast) gtStartStatusPoll(false);
}

async function gtRefreshEngine() {
    try {
        gtState.engine = await gtFetch('/api/github-tunnel/engine/status');
    } catch (e) { /* همان بالا */ }
    gtRender();
    if (!gtState.routeChoosing) gtMaybeOfferRoute();
}

async function gtRefreshBroker() {
    try {
        gtState.broker = await gtFetch('/api/github-tunnel/broker/status');
    } catch (e) { /* همان بالا */ }
    gtRender();
}

async function gtRefreshAccounts() {
    try {
        gtState.accounts = await gtFetch('/api/github-tunnel/accounts');
        gtNoticeSignIn();
    } catch (e) { /* همان بالا */ }
    gtRender();
}

function gtStartStatusPoll(fast) {
    if (gtState.pollTimer) clearInterval(gtState.pollTimer);
    gtState.pollFast = !!fast;
    let tick = 0;
    gtState.pollTimer = setInterval(() => {
        gtRefreshStatus();
        // Accounts move far more slowly than the tunnel does (quota is cached for ten
        // minutes server-side), so they ride a slower beat — but they must still refresh
        // on their own, or a failover the user did not trigger never shows up in the list.
        if (++tick % 6 === 0 || gtState.view === 'accounts') gtRefreshAccounts();
        // The engine/proxy/tunnel switches are re-rendered on every one of these ticks, so
        // they must be refreshed on the same tick. Polling only the session status meant a
        // freshly-enabled tunnel visibly snapped back off a few seconds later, reading as
        // "the tunnel doesn't work" when it was in fact running.
        if (!gtState.busy) gtRefreshEngine();
    }, fast ? 2000 : 5000);
}

async function gtResetAll() {
    const ok = await uiConfirm({
        title: 'ریست کامل GitHub Tunnel؟',
        message: 'اتصال گیت‌هاب، تنظیمات سرویس شبکه‌ی امن، کلیدها و همه‌ی نشست‌ها پاک می‌شوند و همه‌چیز از اول شروع می‌شود.\n\nریپازیتوری گیت‌هاب و سرویسی که روی کلادفلر دیپلوی شده حذف نمی‌شوند.',
        confirmLabel: 'ریست کامل',
        danger: true,
    });
    if (!ok) return;
    gtState.busy = 'reset';
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/reset', { method: 'POST' });
        gtToast('همه‌چیز پاک شد.');
    } catch (e) { gtToast(e.message); }
    // Everything the panel was showing is gone; rebuild from a clean slate.
    gtState.busy = '';
    gtState.status = null;
    gtState.engine = null;
    gtState.broker = null;
    gtState.speed = null;
    gtState.forceBrokerSetup = false;
    gtState.drafts = {};
    await gtRefreshGithub();
    await gtRefreshStatus();
    gtRender(true);
}

// ── what the window is in ─────────────────────────────────────────────────────────

function gtSessionLive() {
    const s = gtState.status && gtState.status.session;
    return !!(s && ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status));
}

// New sessions use the v2 data plane (Xray through the user's Worker) unless switched back.
// It needs no Tailscale at all — the relay only has to carry the passthrough.
function gtNewSessionsV2() { return !!(gtState.status && gtState.status.dataPlane === 'v2'); }
function gtSessionV2(session) { return !!(session && session.dataPlane === 'v2'); }

/** Is there anything running or engaged that the user might need to switch off? */
function gtHasLiveEngine() {
    const st = gtState.engine;
    if (!st) return false;
    const eng = st.engine || {};
    const ks = st.killSwitch || {};
    return !!(eng.connected || eng.running || ks.engaged);
}

/** A transition in flight, started here or by another window (the server says so). */
function gtBusy() {
    return gtState.busy || (gtState.engine && gtState.engine.busy ? 'server' : '');
}

/**
 * What the hero says, and what its one button does. Everything else on the page — the
 * sidebar identity, the step line, the footer — reads from here, so they cannot disagree.
 */
function gtView() {
    const gh = gtState.githubStatus;
    const list = gtAccountList();
    const hasAccounts = list.length > 0 || !!(gh && gh.connected);
    const st = gtState.status;
    const prov = st && st.provisioning;
    const session = st && st.session;
    const eng = (gtState.engine && gtState.engine.engine) || {};
    const pending = gh && gh.pending;
    const base = { hasAccounts, session, live: gtSessionLive(), connected: !!eng.connected };

    if (gtState.busy === 'reset') {
        return Object.assign(base, { tone: 'busy', act: '',
            head: 'در حال ریست کامل',
            line: 'تونل، محافظ نشت و موتور اتصال در حال خاموش شدن هستند و تنظیمات پاک می‌شود. چند ثانیه طول می‌کشد.' });
    }
    if (gtState.connecting || (pending && pending.state === 'waiting')) {
        return Object.assign(base, { tone: 'busy', act: '',
            head: hasAccounts ? 'افزودن حساب گیت‌هاب' : 'اتصال به گیت‌هاب',
            line: 'کد پایین را در صفحهٔ گیت‌هاب وارد کنید. تا وقتی این پنجره باز است کد معتبر می‌ماند.' });
    }
    // THREE STEPS IN THIS ORDER (Android 1.2.36 › ۶): Cloudflare, then GitHub, then connect. The
    // tunnel rides the user's own Worker, so a GitHub account without it only leads to a failed
    // session and a BROKER_NOT_DEPLOYED card afterwards. The round button does the current step.
    const b = gtState.broker;
    if (!gtLoadCfAccounts().length) {
        return Object.assign(base, { tone: 'off', act: 'cloud',
            head: 'قدم ۱ از ۳ — حساب کلادفلر',
            line: 'ترافیک این تونل از Worker کلادفلر خودتان رد می‌شود. دکمهٔ بالا بخش ابری را باز می‌کند تا یک حساب کلادفلر (رایگان) اضافه کنید؛ بعد برگردید.' });
    }
    if (b && (!b.deployed || b.needsRedeploy) && !gtState.brokerDeploying) {
        return Object.assign(base, { tone: 'off', act: 'broker',
            head: b.needsRedeploy ? 'قدم ۱ از ۳ — به‌روزرسانی ورکر رله' : 'قدم ۱ از ۳ — ورکر رله روی کلادفلر',
            line: 'دکمهٔ بالا ورکر رلهٔ این تونل را روی حساب کلادفلر شما نصب می‌کند (چند ثانیه). بخش «سرویس شبکهٔ امن» جزئیات و انتخاب حساب را دارد.' });
    }
    if (gtState.brokerDeploying) {
        return Object.assign(base, { tone: 'busy', act: '',
            head: 'قدم ۱ از ۳ — نصب ورکر رله…', line: 'چند ثانیه طول می‌کشد.' });
    }
    if (!hasAccounts) {
        return Object.assign(base, { tone: 'off', act: '',
            head: 'قدم ۲ از ۳ — حساب گیت‌هاب را وصل کنید',
            line: 'این تونل سرور اجاره‌ای ندارد: یک سرور ابری روی سهمیهٔ حساب گیت‌هاب خودتان بالا می‌آید و ترافیک از آن رد می‌شود. کارت پایین، اتصال حساب را قدم‌به‌قدم انجام می‌دهد.' });
    }

    const inProgress = prov && !['READY', 'FAILED'].includes(prov.state);
    const justFinished = prov && prov.state === 'READY' && (!session || session.status === 'SETTING_UP');
    if (inProgress || justFinished) {
        const label = GT_PROV_LABELS[prov && prov.state] || 'آماده‌سازی';
        return Object.assign(base, { tone: 'busy', act: '',
            head: 'در حال ساخت نشست ابری',
            line: `${gtEsc(label)}… — ساخت یک سرور ابری چند دقیقه طول می‌کشد؛ می‌توانید پنجره را ببندید، کار ادامه پیدا می‌کند.` });
    }
    if (prov && prov.state === 'FAILED') {
        return Object.assign(base, { tone: 'off', act: 'setup',
            head: 'ساخت نشست ناموفق بود',
            line: 'کارت پایین می‌گوید کجا گیر کرد و چه کاری آن را باز می‌کند. دکمهٔ بالا دوباره تلاش می‌کند.' });
    }
    if (base.connected) {
        const mode = eng.mode === 'tun' ? 'تونل کامل — همهٔ برنامه‌ها، با UDP' : 'پروکسی سیستم — فقط برنامه‌های پروکسی‌پذیر، بدون UDP';
        const left = session && session.remainingMs ? ` · ${gtFmtCountdown(session.remainingMs)} تا پایان نشست` : '';
        return Object.assign(base, { tone: 'on', act: 'disconnect',
            head: 'وصل است',
            line: `${mode}${left}` });
    }
    if (base.live) {
        return Object.assign(base, { tone: 'off', act: 'connect',
            head: 'نشست آماده است — هنوز چیزی از تونل رد نمی‌شود',
            line: 'سرور ابری شما بالاست و ساعتش دارد می‌گذرد، ولی تا وقتی یکی از دو مسیر روشن نشود هیچ ترافیکی از آن عبور نمی‌کند. دکمهٔ بالا مسیر آخری که انتخاب کرده بودید را روشن می‌کند.' });
    }
    if (gtHasLiveEngine()) {
        return Object.assign(base, { tone: 'off', act: 'disconnect',
            head: 'نشست تمام شد، ولی چیزی هنوز روشن مانده',
            line: 'محافظ نشت یا موتور اتصال هنوز برچیده نشده‌اند. تا وقتی محافظ درگیر است، اینترنت این کامپیوتر مسدود می‌ماند — دکمهٔ بالا همه را می‌بندد.' });
    }
    return Object.assign(base, { tone: 'off', act: 'setup',
        head: 'آمادهٔ ساخت نشست ابری',
        line: 'دکمهٔ بالا یک سرور ابری روی سهمیهٔ یکی از حساب‌های شما می‌سازد و بعد از چند دقیقه کانفیگ آماده می‌شود.' });
}

// ── the window ───────────────────────────────────────────────────────────────────
//
// The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one سایفون، ماسک and
// «تونل گوگل‌اسکریپت» wear. This window has more moving parts than any other engine — a pool of
// GitHub accounts, a cloud session with a clock on it, a relay on Cloudflare, an exit country on
// the server and the local tunnel — so the front page is the decision (the power button) with one
// card per part, and each card's header opens the section where the whole of that part lives.

const GT_SECTIONS = [
    { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)', group: 0 },
    { id: 'exit', label: 'کشور خروجی', icon: 'ph-fill ph-globe-hemisphere-east', tint: 'var(--mv-teal)', group: 0 },
    { id: 'network', label: 'مسیر و محافظ', icon: 'ph-fill ph-shield-check', tint: 'var(--mv-blue)', group: 0 },
    { id: 'accounts', label: 'حساب‌های گیت‌هاب', icon: 'ph-fill ph-github-logo', tint: 'var(--mv-gray)', group: 1 },
    { id: 'broker', label: 'سرویس شبکهٔ امن', icon: 'ph-fill ph-cloud-check', tint: 'var(--mv-indigo)', group: 1 },
];

// The provisioning run, in the order the server reports it. Used twice: as the line above
// the cards while it runs, and as the sentence under the hero's title.
const GT_PROV_ORDER = ['SETTING_UP', 'STARTING', 'INSTALLING', 'CONNECTING_NETWORK', 'READY'];
const GT_PROV_LABELS = {
    SETTING_UP: 'اتصال گیت‌هاب',
    STARTING: 'زیرساخت ابری',
    INSTALLING: 'سرور ابری',
    CONNECTING_NETWORK: 'شبکهٔ امن',
    READY: 'ساخت کانفیگ',
};

/** Which section is on screen. `gtState.view` follows it — the poll reads that. */
let gtSec = 'connect';

function gtSideItem(x) {
    return `
        <button type="button" class="mv-side-item" data-gt-sec="${x.id}"${GTUI.go(x.id)}>
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`;
}

const gtHtmlTemplate = `
<div id="gt-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های گیت‌هاب تانل">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="gt-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">${GT_SECTIONS.filter((x) => x.group === 0).map(gtSideItem).join('')}</div>
      <div class="mv-side-group">${GT_SECTIONS.filter((x) => x.group === 1).map(gtSideItem).join('')}</div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="gt-store" data-gt-act="store" title="موتور شبکهٔ امن در ام‌ال‌ام استور">
          <span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-arrow-circle-down"></i></span>
          <span>بررسی بروزرسانی</span>
          <i class="ph-bold ph-arrow-up-left" aria-hidden="true"></i>
        </button>
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="gt-back" data-gt-go="connect" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="gt-pane-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="gt-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="gt-stage" style="--tint:var(--mv-blue)"></div>
        <div class="mv-eng-flow" id="gt-flow" style="display:none"><div class="mv-steps" id="gt-steps"></div></div>
        <div class="mv-eng-grid" id="gt-cards"></div>
      </div>
      ${GT_SECTIONS.filter((x) => x.id !== 'connect').map((x) => `
      <div class="mv-eng-sec" data-sec="${x.id}"><div class="gt-sec" id="gt-sec-${x.id}"></div></div>`).join('')}
    </div>

    <div class="mv-eng-foot" id="gt-foot"></div>
  </section>
</div>`;

function gtDot(tone) {
    return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
}

function gtRenderIdent() {
    const host = document.getElementById('gt-ident');
    if (!host) return;
    const v = gtView();
    const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('github');
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : '<span class="mv-side-tile" style="--tint:var(--mv-label-2)"><svg aria-hidden="true"><use href="#g-github"/></svg></span>';
    const html = `${icon}
      <b>گیت‌هاب تانل</b>
      <small>${gtDot(v.tone)}${word}</small>`;
    // Unchanged markup is left alone: replacing the icon every tick restarts its artwork.
    if (host.__gtSig !== html) { host.innerHTML = html; host.__gtSig = html; }
}

/** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
function gtRenderStage() {
    const host = document.getElementById('gt-stage');
    if (!host) return;
    const v = gtView();

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-gt-act="power" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
        host.dataset.built = '1';
    }

    const q = (n) => host.querySelector(`[data-part="${n}"]`);
    q('head').innerHTML = v.head;
    q('line').innerHTML = v.line;

    const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
    const btn = q('power');
    const want = 'mv-eng-power' + ring;
    if (btn.className !== want) btn.className = want;
    btn.disabled = !v.act || !!gtState.busy;
    const aria = v.act === 'disconnect' ? 'قطع' : v.act === 'setup' ? 'ساخت نشست ابری' : v.act === 'cloud' ? 'باز کردن بخش ابری' : v.act === 'broker' ? 'نصب ورکر رله' : 'اتصال';
    btn.setAttribute('aria-label', aria);
    btn.title = v.act ? aria : 'هنوز کاری برای این دکمه نیست';
    const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (v.tone === 'on' ? 'ph-fill ph-power' : 'ph-bold ph-power');
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;

    const el = q('live');
    if (el && window.MVEngineLive) MVEngineLive.mount(el);
}

/** The provisioning run as one horizontal line, on screen only while it is running. */
function gtRenderFlow() {
    const wrap = document.getElementById('gt-flow');
    const host = document.getElementById('gt-steps');
    if (!wrap || !host) return;

    const prov = gtState.status && gtState.status.provisioning;
    const show = !!prov && !['FAILED'].includes(prov.state) && !gtSessionLive();
    wrap.style.display = show ? 'flex' : 'none';
    if (!show) return;

    const idx = Math.max(0, GT_PROV_ORDER.indexOf(prov.state));
    host.innerHTML = GT_PROV_ORDER.map((key, i) => {
        let cls = 'pending', mark = String(i + 1).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
        if (i < idx) { cls = 'done'; mark = '✓'; }
        else if (i === idx) { cls = 'active'; mark = '●'; }
        return `<span class="mv-step is-${cls}"><i>${mark}</i>${GT_PROV_LABELS[key]}</span>`;
    }).join('');
}

/**
 * The front page's cards: one per part this window owns. A card that answers the whole page —
 * the sign-in, a setup run, a failure — comes first and takes the whole row.
 */
function gtRenderCards(force) {
    const host = document.getElementById('gt-cards');
    if (!host || (!force && gtEditingIn(host))) return;

    const v = gtView();
    const gh = gtState.githubStatus;
    const pending = gh && gh.pending;
    const parts = [];

    // The device-code flow answers the whole page while it is on.
    if (!v.hasAccounts || gtState.addingAccount || gtState.connecting
        || (pending && ['waiting', 'error'].includes(pending.state))) {
        parts.push(`<div class="gt-span">${gtSignInPanel()}</div>`);
    }
    const run = gtRunPanel();
    if (run) parts.push(`<div class="gt-span">${run}</div>`);

    if (v.hasAccounts) {
        const v2 = gtSessionV2(v.session);
        parts.push(gtSessionCard(v));
        parts.push(gtRouteCard(v));
        if (v2) parts.push(gtExitCard());
        if (v2) parts.push(gtLeakCard());
        parts.push(gtAccountsCard());
        parts.push(gtBrokerCard());
    }
    host.innerHTML = parts.join('');
}

function gtRenderFoot() {
    const host = document.getElementById('gt-foot');
    if (!host) return;
    const v = gtView();
    const eng = (gtState.engine && gtState.engine.engine) || {};
    const word = v.tone === 'on' ? 'وصل' : v.tone === 'busy' ? 'در حال کار'
        : v.live ? 'نشست آماده — مسیری روشن نیست'
            : v.hasAccounts ? 'نشستی ندارید' : 'حسابی وصل نیست';
    const end = v.connected ? (eng.mode === 'tun' ? 'تونل کامل سیستم' : 'پروکسی سیستم')
        : v.live ? 'بدون مسیر' : '—';
    const clock = v.live && v.session && v.session.remainingMs
        ? `<code dir="ltr">${gtFmtCountdown(v.session.remainingMs)}</code>` : '';
    // Where the traffic leaves, when it is known — the one fact a glance at the window should give.
    const seen = v.connected && eng.exit && eng.exit.country
        ? `<span class="gt-foot-exit">${GTUI.flag(eng.exit.country, 15)}${gtEsc(gtCountryFa(eng.exit.country))}</span>` : '';
    host.innerHTML = `
      ${gtDot(v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end">${seen}${clock}<span>${end}</span></span>`;
}

// ── sections ─────────────────────────────────────────────────────────────────────

const GT_SECTION_RENDER = {
    exit: () => gtRenderExit(),
    network: () => gtRenderNetwork(),
    accounts: () => gtRenderAccounts(),
    broker: () => gtRenderBroker(),
};

/** Show one section. `gtState.view` follows it — the status poll reads that name. */
function gtGoSec(id) {
    const wrap = document.getElementById('gt-wrapper');
    if (!wrap) return;
    gtSec = GT_SECTIONS.some((x) => x.id === id) ? id : 'connect';
    gtState.view = gtSec === 'accounts' ? 'accounts' : 'main';
    // The relay form only renders its stored values when this is set; leaving the section
    // clears it so a background poll cannot put the form back over the page.
    gtState.forceBrokerSetup = gtSec === 'broker';
    if (gtSec === 'broker') gtState.brokerError = '';

    wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === gtSec));
    wrap.querySelectorAll('.mv-side-item[data-gt-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-gt-sec') === gtSec));
    const found = GT_SECTIONS.find((x) => x.id === gtSec);
    const title = document.getElementById('gt-pane-title');
    if (title) title.textContent = found ? found.label : '';
    const back = document.getElementById('gt-back');
    if (back) back.disabled = gtSec === 'connect';
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', gtSec === 'connect');
    const sc = document.getElementById('gt-scroll');
    if (sc) sc.scrollTop = 0;

    if (gtSec === 'accounts') gtRefreshAccounts();
    if (gtSec === 'broker') gtRefreshBroker();
    gtRender(true);
}

/**
 * Someone is typing in a field (or holding a picker open) inside `host`: a status poll redrawing
 * it now would throw that away and move the caret. The next render after they leave catches up —
 * and what they typed survives even that (GTUI.field keeps it in gtState.drafts).
 */
function gtEditingIn(host) {
    const ae = document.activeElement;
    return !!(ae && host && host.contains(ae)
        && ae.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select'));
}

/**
 * ONE listener per event kind for the whole window, installed once with the frame. Renders only
 * write markup; a control is wired by what it declares (gt-ui.js › EVENTS ARE DECLARATIVE).
 */
function gtWire(wrap) {
    wrap.addEventListener('click', (e) => {
        const t = e.target.closest('[data-gt-act], [data-gt-go]');
        if (!t || !wrap.contains(t) || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
        if (t.hasAttribute('data-gt-go')) { gtGoSec(t.getAttribute('data-gt-go')); return; }
        const fn = GT_ACTIONS[t.getAttribute('data-gt-act')];
        if (fn) fn(t.getAttribute('data-arg'), t, e);
    });
    // The kit flips a .mv-switch itself (ui/mv.js) and says so with `mv-change`.
    wrap.addEventListener('mv-change', (e) => {
        const t = e.target;
        const name = t && t.getAttribute && t.getAttribute('data-gt-switch');
        const fn = name && GT_SWITCHES[name];
        if (fn) fn(!!(e.detail && e.detail.checked), t);
    });
    wrap.addEventListener('input', (e) => {
        const t = e.target;
        if (!t || !t.dataset) return;
        if (t.dataset.gtDraft) gtState.drafts[t.dataset.gtDraft] = t.value;
        const fn = t.dataset.gtInput && GT_INPUTS[t.dataset.gtInput];
        if (fn) fn(t.value, t);
    });
    wrap.addEventListener('change', (e) => {
        const t = e.target;
        const fn = t && t.dataset && t.dataset.gtChange && GT_CHANGES[t.dataset.gtChange];
        if (fn) fn(t.value, t);
    });
    // Enter in a one-line field runs the button it belongs to (data-gt-enter="action").
    wrap.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        const t = e.target;
        const name = t && t.dataset && t.dataset.gtEnter;
        if (!name || t.tagName === 'TEXTAREA') return;
        e.preventDefault();
        const fn = GT_ACTIONS[name];
        if (fn) fn(t.dataset.arg || null, t, e);
    });
}

function gtRender(force) {
    const root = document.getElementById('ls-github-tunnel');
    if (!root) return;

    if (!document.getElementById('gt-wrapper')) {
        root.innerHTML = gtHtmlTemplate;
        gtWire(document.getElementById('gt-wrapper'));
        gtGoSec('connect');
        return;      // gtGoSec calls back in, with the frame in place
    }

    gtRenderIdent();
    gtRenderFoot();

    if (gtSec === 'connect') {
        gtRenderStage();
        gtRenderFlow();
        gtRenderCards(force);
        return;
    }
    const host = document.getElementById(`gt-sec-${gtSec}`);
    const draw = GT_SECTION_RENDER[gtSec];
    if (!host || !draw || (!force && gtEditingIn(host))) return;
    host.innerHTML = draw();
}

// ── actions the frame itself owns ────────────────────────────────────────────────
GTUI.on({
    act: {
        power: () => {
            const act = gtView().act;
            if (act === 'disconnect') gtDisconnectEngine();
            else if (act === 'connect') gtConnectEngine();
            else if (act === 'setup') gtBeginSetup();
            else if (act === 'cloud') { if (window.MV && MV.wm) MV.wm.open('cloud'); }
            else if (act === 'broker') {
                // With one Cloudflare account, install straight away; with several, the section
                // lets the user pick which account carries it.
                if (gtLoadCfAccounts().length === 1 && typeof gtDeployBroker === 'function') gtDeployBroker();
                else gtGoSec('broker');
            }
        },
        // The engine that carries this tunnel is a store item (store/catalog.js › core|tailscale).
        store: () => {
            if (typeof window.storeOpenItem === 'function') window.storeOpenItem('core|tailscale');
            else if (window.MV && MV.wm) MV.wm.open('store');
        },
        copy: (text) => gtCopyText(text),
        disclose: (key) => {
            gtState.ui.open[key] = !gtState.ui.open[key];
            gtRender(true);
        },
        'reset-all': () => gtResetAll(),
        advice: (code) => {
            const a = GT_ADVICE[code];
            gtState.lastFailure = null;
            if (a && a.run) a.run();
        },
    },
});

// ── init ─────────────────────────────────────────────────────────────────────────

function initGithubTunnelModule() {
    const container = document.getElementById('ls-github-tunnel');
    if (!container) return;
    if (container.parentElement) {
        container.parentElement.style.position = 'relative';
        container.parentElement.style.padding = '0';
        container.parentElement.style.overflow = 'hidden';
    }
    // The pane does the scrolling now, not this box — and no z-index of its own: a
    // positioned panel with one covers the window's title bar and takes the traffic
    // lights with it.
    container.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';

    gtRender();
    gtRefreshAccounts().then(() => gtRefreshGithub()).then(() => {
        const gh = gtState.githubStatus;
        if (gh && gh.pending && gh.pending.state === 'waiting') { gtState.connecting = true; gtStartGithubPoll(); }
        if (gtHasAccounts()) { gtRefreshStatus(); gtRefreshBroker(); gtRefreshEngine(); gtStartStatusPoll(false); }
    });

    // تیک محلی هر ۱ ثانیه بین دو رفرش سرور، تا شمارش معکوس ثابت به نظر نرسد.
    setInterval(() => {
        const el = document.getElementById('ls-github-tunnel');
        if (!el || el.style.display === 'none') return;
        const cd = document.getElementById('gt-countdown');
        const session = gtState.status && gtState.status.session;
        if (!cd || !session || !session.remainingMs) return;
        session.remainingMs = Math.max(0, session.remainingMs - 1000);
        cd.textContent = gtFmtCountdown(session.remainingMs);
    }, 1000);
}
