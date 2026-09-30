// --- گیت‌هاب تانل · مسیر و محافظ ---
// How the traffic goes (the full tunnel or the system proxy), the guards that hold when the
// tunnel drops (kill switch, the IPv6 and DNS locks, and the Windows Firewall they stand on),
// and the two measurements: the path/speed report and the leak test asked of the far end.

// ── connect, disconnect, the two routes ──────────────────────────────────────────

async function gtConnectEngine() {
    gtState.busy = 'connect';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/connect', { method: 'POST' });
        gtState.lastFailure = null;
        gtToast('اتصال برقرار شد.');
    } catch (e) { gtNoteFailure(e); gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtDisconnectEngine() {
    gtState.busy = 'connect';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/disconnect', { method: 'POST' });
        gtToast('اتصال قطع شد.');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtToggleProxy(enabled) {
    gtState.busy = 'proxy';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/proxy', { method: 'POST', body: JSON.stringify({ enabled }) });
        gtState.lastFailure = null;
    } catch (e) { gtNoteFailure(e); gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtToggleTun(enabled) {
    gtState.busy = 'tun';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/tun', { method: 'POST', body: JSON.stringify({ enabled }) });
        gtState.lastFailure = null;
    } catch (e) { gtNoteFailure(e); gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

// «نشست آماده شد — تونل کامل یا پروکسی کل سیستم؟» — the same sheet the WARP engines open
// (route-sheet.js). A ready session carries nothing until one of the two routes is on, so once
// per session, while neither is, the user is asked. It stays until the chosen one reads back as
// connected, or until the user closes it; the controls on the panel are unchanged.
let gtRouteAskedFor = null;

function gtMaybeOfferRoute() {
    if (!window.MVRouteSheet) return;
    const eng = gtState.engine && gtState.engine.engine;
    if (!gtSessionLive()) { MVRouteSheet.close('gt'); return; }
    const s = gtState.status.session;
    // The session id, not its Tailscale address: a v2 session has none, and every v2 session
    // on one account would otherwise share a key and be asked only once, ever.
    const key = `${s.accountLogin || ''}|${s.id || s.tailscaleIp || ''}`;
    if (eng && eng.connected) {
        // A control on the panel already brought it up. The session counts as answered, so
        // turning both off later on purpose does not bring the question back.
        gtRouteAskedFor = key;
        if (!gtState.routeChoosing) MVRouteSheet.close('gt');
        return;
    }
    if (!eng || gtState.busy || gtState.engine.busy) return;   // not known yet, or mid-change
    if (gtRouteAskedFor === key) return;
    gtRouteAskedFor = key;
    // v2: one button for a beginner — the session they just asked for is connected, once, the
    // way that covers everything (the full tunnel, with the kill switch and the DNS and IPv6
    // locks). If that is refused the reason is said, with the partial-cover alternative named —
    // never taken silently, because it would leave every non-proxy app on the real address.
    if (gtSessionV2(s)) {
        gtRouteChoose('tun').then((r) => {
            if (r && !r.ok) gtToast(`تونل کامل روشن نشد${r.error ? `: ${r.error}` : '.'} — برای پوشش جزئی (فقط مرورگر) «پروکسی سیستم» را بزنید.`);
        });
        return;
    }
    MVRouteSheet.open({
        owner: 'gt',
        title: 'نشست تونل گیت‌هاب آماده شد',
        text: 'تا یکی از این دو روشن نشود، هیچ ترافیکی از تونل رد نمی‌شود. کدام را می‌خواهید؟',
        notes: {
            tun: 'کل ترافیک ویندوز و همه‌ی برنامه‌ها، با UDP. کلید قطع اضطراری فقط در این حالت کار می‌کند. پیشنهادی.',
        },
        choose: gtRouteChoose,
    });
}

async function gtRouteChoose(kind) {
    gtState.busy = kind;
    gtState.routeChoosing = true;
    gtRender();
    let error = '';
    try {
        await gtFetch(kind === 'tun' ? '/api/github-tunnel/tun' : '/api/github-tunnel/proxy',
            { method: 'POST', body: JSON.stringify({ enabled: true }) });
        gtState.lastFailure = null;
    } catch (e) { error = e.message; gtNoteFailure(e); }
    gtState.busy = '';
    // Only the engine's own reading counts as up.
    await gtRefreshEngine();
    gtState.routeChoosing = false;
    const eng = gtState.engine && gtState.engine.engine;
    if (eng && eng.connected && eng.mode === kind) return { ok: true };
    return { ok: false, error: error || (eng && eng.error) || '' };
}

// ── the guards ───────────────────────────────────────────────────────────────────

async function gtToggleKillSwitch(enabled) {
    gtState.busy = 'ks';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/killswitch', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtToggleIpv6Guard(enabled) {
    gtState.busy = 'v6';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/ipv6guard', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

// «روشن کردن دیوارآتش ویندوز فقط هنگام اتصال» — the user's explicit choice (gt-guard.js › WHEN
// WINDOWS FIREWALL IS OFF). Kept across restarts; the server re-arms the guards when it is set.
async function gtSetFirewall(autoEnable) {
    gtState.busy = 'fw';
    gtRender();
    try {
        const r = await gtFetch('/api/github-tunnel/firewall', { method: 'POST', body: JSON.stringify({ autoEnable }) });
        gtToast(autoEnable
            ? (r && r.killSwitch ? 'دیوارآتش ویندوز برای مدت اتصال روشن شد و محافظ نشت فعال است.' : 'از این پس با تونل کامل، دیوارآتش ویندوز فقط برای مدت اتصال روشن می‌شود.')
            : 'دیوارآتش ویندوز دیگر روشن نمی‌شود؛ محافظ‌هایی که به آن وابسته بودند برداشته شدند.');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

/** True when the guards' rules would not be enforced: the firewall is off and we may not switch it on. */
function gtFirewallOff(fw) { return !!(fw && fw.enforcing === false && !fw.autoEnable); }

/**
 * Windows Firewall switched off: every guard is a firewall rule, and an off firewall enforces
 * none of them. Said plainly, with the one choice that fixes it — never switched on without a yes.
 * Returns a row (or '') for a group: a callout with its button, or the switch once it is chosen.
 */
function gtFirewallRow(fw, busy) {
    const U = GTUI;
    if (!fw) return '';
    if (gtFirewallOff(fw)) {
        return U.callout({
            tone: 'warn',
            title: 'دیوارآتش ویندوز روی این سیستم خاموش است',
            text: 'محافظ نشت و قفل‌های DNS و IPv6 بدون آن اجرا نمی‌شوند. تا وقتی تونل وصل است خود تونل جلوی نشت را می‌گیرد؛ این محافظ‌ها برای لحظه‌ای‌اند که تونل قطع شود.',
            actions: [U.button({ text: 'روشن کردن فقط هنگام اتصال', icon: 'ph-bold ph-shield-check', act: 'fw-enable', size: 'sm',
                busy: busy === 'fw', busyText: 'لطفاً صبر کنید…', disabled: !!busy })],
        });
    }
    if (fw.autoEnable) {
        return U.switchRow({ name: 'firewall', icon: 'ph-fill ph-wall', tint: 'var(--mv-orange)',
            title: 'روشن کردن دیوارآتش ویندوز هنگام اتصال',
            sub: fw.leased ? 'روشن است، فقط برای مدت اتصال — ورودی‌ها باز مانده‌اند و با قطع، به حالت قبلش برمی‌گردد.'
                : 'اگر دیوارآتش ویندوز خاموش باشد، فقط برای مدت اتصال روشن می‌شود و ورودی‌ها باز می‌مانند.',
            on: true, disabled: !!busy, busy: busy === 'fw' });
    }
    return '';
}

/** The kill switch and the IPv6 lock as switch rows — the same two on the card and in the section. */
function gtGuardRows(st, busy, withTiles) {
    const U = GTUI;
    const ks = st.killSwitch || {};
    const v6 = st.ipv6Guard || {};
    const fwOff = gtFirewallOff(st.firewall);
    const ksApplicable = ks.applicable !== false;
    const v6Applicable = v6.applicable !== false;
    return [
        U.switchRow({ name: 'killswitch', icon: withTiles && 'ph-fill ph-lock-key', tint: 'var(--mv-red)',
            title: 'محافظ نشت (Kill-Switch)',
            sub: !ksApplicable
                ? 'در حالت پراکسی کار نمی‌کند — محافظ به آداپتور تونل کامل نیاز دارد. در این حالت ترافیک برنامه‌هایی که از پراکسی استفاده نمی‌کنند بدون تونل خارج می‌شود.'
                : ks.engaged ? 'فعال — اگر تونل قطع شود، هیچ ترافیکی با آی‌پی واقعی خارج نمی‌شود.'
                    : fwOff ? 'در دسترس نیست — دیوارآتش ویندوز خاموش است.'
                        : 'اگر تونل قطع شود، اینترنت تا وصل‌شدن دوباره مسدود می‌ماند.',
            on: !!ks.enabled && ksApplicable, disabled: !!busy, busy: busy === 'ks' }),
        U.switchRow({ name: 'ipv6', icon: withTiles && 'ph-fill ph-lock-simple', tint: 'var(--mv-purple)',
            title: 'قفل IPv6',
            sub: !v6Applicable ? 'در حالت پراکسی اعمال نمی‌شود.'
                : v6.active ? 'فعال — آدرس واقعی IPv6 شما به هیچ سایتی نمی‌رسد.'
                    : fwOff ? 'اجرا نمی‌شود — دیوارآتش ویندوز خاموش است. تا وقتی تونل وصل است، خود تونل IPv6 را رد می‌کند.'
                        : 'مسیر IPv6 مودم را می‌بندد تا سایت‌های دارای IPv6 آدرس واقعی شما را نبینند. اگر در شبکهٔ محلی به IPv6 نیاز دارید خاموشش کنید.',
            on: !!v6.enabled && v6Applicable, disabled: !!busy, busy: busy === 'v6' }),
    ];
}

// ── the advice after a failure ───────────────────────────────────────────────────

/** The code's own finding and one button; or the server's words, verbatim. '' when nothing failed. */
function gtAdviceRow(code, message, busy) {
    const U = GTUI;
    const a = code && GT_ADVICE[code];
    if (!a && !message) return '';
    return U.callout({
        tone: 'danger',
        text: U.esc(a ? a.fa : message),
        actions: a && a.btn && a.run ? [U.button({ text: a.btn, act: 'advice', arg: code, kind: 'primary', size: 'sm', disabled: !!busy })] : [],
    });
}

// The engine reports WHY it is down. To the user a switch that flips itself off is "it
// disconnected in the middle of my work" with no cause and nothing to act on — the single worst
// state this panel can be in — so each known reason is said in words.
const GT_ERRORS = {
    EXIT_NODE_NOT_APPROVED: 'نشست ابری به‌عنوان خروجی تأیید نشده — بخش autoApprovers را در تنظیمات دسترسی (ACL) اضافه کنید.',
    NOT_RUNNING: 'موتور اتصال از شبکه خارج شد. اینترنت شما قطع شده یا نشست ابری پایان یافته است.',
    NO_STATUS: 'وضعیت موتور اتصال خوانده نشد.',
    NO_EGRESS: 'تونل برقرار است ولی داده‌ای از آن عبور نمی‌کند.',
    REPAIR_GAVE_UP: 'بازیابی خودکار چند بار تلاش کرد و موفق نشد. اگر محافظ نشت روشن است، اینترنت شما تا قطع اتصال مسدود می‌ماند — «قطع اتصال» را بزنید و دوباره وصل شوید؛ اگر باز هم تکرار شد، «تمدید» بزنید.',
    SESSION_ENDED: 'نشست ابری پایان یافت و اتصال به‌طور خودکار بسته شد. از این لحظه ترافیک شما مستقیم و با آی‌پی واقعی خارج می‌شود — برای ادامه «تمدید» بزنید.',
    PREEMPTED: 'بخش دیگری از برنامه (تونل V2Ray، وارپ، شتاب بازی…) مسیر سیستم را گرفت، پس تونل گیت‌هاب قطع شد و محافظ نشت و قفل‌ها هم برداشته شدند. برای برگشت، دوباره وصل شوید.',
    TUN_DOWN: 'تونل کامل از کار افتاد — در حال ساختن دوباره‌اش. اگر محافظ نشت روشن است، تا آن موقع هیچ ترافیکی با آی‌پی واقعی بیرون نمی‌رود.',
    NO_CLEAN_IP: 'هیچ آی‌پی کلادفلری از این خط به سرویس شبکهٔ امن شما نرسید. اگر فیلترشکن دیگری روشن است خاموشش کنید؛ اگر نه، از بخش «اسکن» آی‌پی تمیز تازه پیدا کنید.',
};

// ── the leak test ────────────────────────────────────────────────────────────────
// Asked of the far end by the main process (gt-verify.js); the result is kept there too, so a
// reopened panel shows the last one.

async function gtRunLeakTest() {
    gtState.busy = 'leak';
    gtRender();
    try {
        const r = await gtFetch('/api/github-tunnel/leaktest', { method: 'POST' });
        const v = r && r.result && r.result.verdict;
        gtToast(v === 'clean' ? 'آزمون نشتی: هیچ نشتی پیدا نشد.' : v === 'leak' ? 'آزمون نشتی: نشت پیدا شد — جزئیات در کارت «آزمون نشتی».' : 'آزمون نشتی: بعضی سنجش‌ها جواب ندادند — دوباره بزنید.');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

const GT_LEAK_ICON = { pass: 'ph-fill ph-check-circle', fail: 'ph-fill ph-x-circle', warn: 'ph-fill ph-warning-circle', unknown: 'ph-fill ph-question' };

function gtLeakVerdict(lt) {
    if (!lt) return { word: 'انجام نشده', tone: '', tint: 'var(--mv-gray)' };
    if (lt.verdict === 'clean') return { word: 'بدون نشتی', tone: 'ok', tint: 'var(--mv-green)' };
    if (lt.verdict === 'leak') return { word: 'نشت پیدا شد', tone: 'bad', tint: 'var(--mv-red)' };
    return { word: 'نتیجهٔ ناقص', tone: 'warn', tint: 'var(--mv-orange)' };
}

/**
 * A Persian sentence with addresses and provider names in it («… 20.168.103.50 (United States،
 * Phoenix) را می‌بینند»): every Latin run is set left-to-right on its own, or the bidi algorithm
 * reorders the address and the panel's font draws its digits in Persian — an IP nobody can read
 * or compare. Each piece is escaped separately, so no entity is ever split.
 */
function gtLtrRuns(text) {
    return String(text || '').split(/([A-Za-z0-9][A-Za-z0-9 .,:\-/]*[A-Za-z0-9]|[0-9])/)
        .map((seg, i) => (i % 2 ? `<span dir="ltr">${gtEsc(seg)}</span>` : gtEsc(seg))).join('');
}

/**
 * The safety net, beside the four answers: they say nothing leaks NOW; this says what happens if
 * the tunnel drops. Not part of the verdict — a missing net is not a leak — but never silent.
 */
function gtLeakGuardLine(lt) {
    const g = lt && lt.guards;
    if (!g || g.killSwitch || !g.killSwitchWanted) return '';
    const why = gtFirewallOff(lt.firewall) ? 'چون دیوارآتش ویندوز خاموش است' : 'لاگ اتصال دلیلش را می‌گوید';
    return `<div class="gt-note is-warn">کیل‌سوییچ فعال نیست (${why}) — اگر تونل قطع شود، ترافیک با آدرس واقعی بیرون می‌رود.</div>`;
}

/** The four answers of the last leak test, one line each — what the far end saw, in words. */
function gtLeakRows(lt) {
    if (!lt || !Array.isArray(lt.checks)) return '';
    return `<div class="gt-checks">${lt.checks.map((c) => {
        const s = GT_LEAK_ICON[c.status] ? c.status : 'unknown';
        return `<div class="gt-check is-${s}"><i class="${GT_LEAK_ICON[s]}" aria-hidden="true"></i><span class="gt-check-text"><small>${gtLtrRuns(c.fa)}</small></span></div>`;
    }).join('')}</div>`
        + (lt.note ? `<div class="gt-note is-warn">${gtLtrRuns(lt.note)}</div>` : '')
        + gtLeakGuardLine(lt);
}

// ── the path/speed report ────────────────────────────────────────────────────────

async function gtRunSpeedtest() {
    gtState.busy = 'speed';
    gtState.speed = null;
    gtRender();
    try {
        gtState.speed = await gtFetch('/api/github-tunnel/engine/speedtest');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    gtRender();
}

function gtSpeedRows() {
    const s = gtState.speed;
    if (!s || !s.results) return '';
    const kind = { PASS: 'pass', WARN: 'warn', FAIL: 'fail' };
    const icon = { PASS: 'ph-fill ph-check-circle', WARN: 'ph-fill ph-warning-circle', FAIL: 'ph-fill ph-x-circle' };
    return GTUI.stack(`<div class="gt-checks">${s.results.map((r) => `
        <div class="gt-check is-${kind[r.verdict] || 'unknown'}"><i class="${icon[r.verdict] || GT_LEAK_ICON.unknown}" aria-hidden="true"></i>
          <span class="gt-check-text"><span><b>${gtEsc(r.name)}</b><em>${gtEsc(r.detail)}</em></span>${r.hint ? `<small>${gtEsc(r.hint)}</small>` : ''}</span>
        </div>`).join('')}</div>
        ${GTUI.actions([GTUI.button({ text: 'کپی نتیجه', icon: 'ph-bold ph-copy', act: 'speed-copy', size: 'sm' })])}`);
}

/** Plain-text dump of the last run, so the result can be pasted into a report. */
function gtCopySpeedResults() {
    const s = gtState.speed;
    if (!s || !s.results) return;
    const lines = [
        `GitHub Tunnel — path/speed report`,
        `overall: ${s.summary}   path: ${s.pathKind}${s.pingMs != null ? `   ping: ${s.pingMs}ms` : ''}`,
        '',
        ...s.results.map(r => `[${r.verdict}] ${r.name}: ${r.detail}${r.hint ? `\n        ↳ ${r.hint}` : ''}`),
    ];
    gtCopyText(lines.join('\n'), 'نتیجه کپی شد.');
}

// ── the cards ────────────────────────────────────────────────────────────────────

function gtRouteCard(v) {
    const U = GTUI;
    const st = gtState.engine || {};
    const eng = st.engine || {};
    const ks = st.killSwitch || {};
    const dnsGuard = st.dnsGuard || {};
    const connected = !!eng.connected;
    const tunOn = connected && eng.mode === 'tun';
    const proxyOn = connected && eng.mode === 'proxy';
    const busy = gtBusy();
    const ksApplicable = ks.applicable !== false;
    // v2's full tunnel is the app's shared adapter on top of its engine — every app, DNS and UDP,
    // with the kill switch and the DNS/IPv6 locks. Its proxy mode is PARTIAL cover and says so:
    // every app that ignores the proxy, and every name lookup, stays on the line.
    const v2s = gtSessionV2(v.session);

    const pick = (kind, on, title, sub) => `
          <button type="button" class="mv-eng-pick${on ? ' is-on is-live' : ''}"${U.act('mode', kind)}
                  role="radio" aria-checked="${on}"${busy || !v.live ? ' disabled' : ''}${v.live ? '' : ' title="اول یک نشست ابری بسازید"'}>
            <i class="${busy === kind ? 'mv-spin-ring' : on ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>${title}</b><small>${sub}</small></span>
          </button>`;

    // What went wrong last, as one finding and one button (ERROR-DRIVEN ADVICE).
    let advice = '';
    if (!connected && !busy) {
        const f = gtState.lastFailure;
        const code = (f && f.code) || (GT_ADVICE[eng.error] ? eng.error : '');
        advice = gtAdviceRow(code, f ? f.message : '', busy);
    }

    const foot = v2s && proxyOn
        ? 'پوشش جزئی: محافظ نشت و قفل‌ها به آداپتور تونل کامل نیاز دارند و در حالت پروکسی کاری نمی‌کنند.'
        : !ksApplicable
            ? (v2s ? 'تونل جدید: از Worker خودتان روی کلادفلر به سرور ابری. «تونل کامل» همه‌چیز را می‌پوشاند.' : 'محافظ نشت در حالت پروکسی کار نمی‌کند — به آداپتور تونل کامل نیاز دارد.')
            : tunOn
                ? (dnsGuard.active ? 'قفل DNS هم فعال است — نام دامنه‌ها دیگر بیرون از تونل جستجو نمی‌شوند.' : 'قفل DNS هنوز فعال نشده — لاگ اتصال را ببینید.')
                : 'قفل DNS با روشن‌شدن تونل کامل، خودش فعال می‌شود.';

    return U.card({
        tint: 'var(--mv-blue)', icon: 'ph-fill ph-shield-check', title: 'مسیر ترافیک', go: 'network',
        end: tunOn ? U.pill('تونل کامل', 'ok', true) : proxyOn ? U.pill('پروکسی سیستم', 'warn', true) : eng.repairing ? U.pill('بازسازی…', 'warn') : U.pill('خاموش'),
        body: `<div role="radiogroup" aria-label="مسیر ترافیک">
            ${pick('tun', tunOn, 'تونل کامل (پیشنهادی)', v2s
                ? 'همهٔ برنامه‌ها، DNS و UDP از تونل — محافظ نشت و قفل‌های DNS و IPv6 خودکار روشن می‌شوند.'
                : 'تمام ترافیک، با UDP — بازی و تماس تصویری کار می‌کند. کمترین پینگ.')}
            ${pick('proxy', proxyOn, `پروکسی سیستم${v2s ? ' (پوشش جزئی)' : ''}`, v2s
                ? 'فقط مرورگر و برنامه‌های پروکسی‌پذیر؛ بقیهٔ برنامه‌ها و DNS با آدرس واقعی شما بیرون می‌روند.'
                : 'فقط مرورگر و برنامه‌های پروکسی‌پذیر. بدون UDP، ولی روی اینترنت‌های سخت‌گیر بهتر جواب می‌دهد.')}
          </div>`
            + U.facts([v2s && connected && eng.delayMs && { k: 'تأخیر تا سرور', v: `${U.fa(eng.delayMs)} میلی‌ثانیه` }])
            + (advice ? `<div class="mv-form-group">${advice}</div>` : '')
            + (ksApplicable ? U.rows([...gtGuardRows(st, busy, false), gtFirewallRow(st.firewall, busy)]) : ''),
        foot,
    });
}

function gtLeakCard() {
    const U = GTUI;
    const st = gtState.engine || {};
    const eng = st.engine || {};
    const tunOn = !!eng.connected && eng.mode === 'tun';
    const busy = gtBusy();
    const lt = st.leakTest || null;
    const lv = gtLeakVerdict(lt);
    return U.card({
        tint: lv.tint, icon: 'ph-fill ph-detective', title: 'آزمون نشتی',
        end: busy === 'leak' ? U.pill('در حال سنجش…', 'warn') : U.pill(lv.word, lv.tone),
        side: U.cardAct({ act: 'leaktest', icon: 'ph-bold ph-play', title: tunOn ? 'آزمون نشتی' : 'اول تونل کامل را روشن کنید',
            busy: busy === 'leak', disabled: !tunOn || !!busy }),
        body: lt ? gtLeakRows(lt) : `<div class="gt-note">${tunOn
            ? 'دکمهٔ کنار عنوان را بزنید: آدرس، DNS، UDP (WebRTC) و IPv6 را از چشم خود سایت‌ها می‌سنجد — حدود ده ثانیه.'
            : 'با تونل کامل روشن معنا دارد.'}</div>`,
        foot: lt && lt.at ? `آخرین آزمون: ${new Date(lt.at).toLocaleTimeString('fa-IR')}` : 'هر پاسخ از چیزی است که طرف مقابل واقعاً دید، نه از وضعیت خود برنامه.',
    });
}

// ── the section ──────────────────────────────────────────────────────────────────

/** The engine + the two independent traffic switches: connecting only brings the engine up;
 *  what actually uses it is chosen separately. */
function gtRenderNetwork() {
    const U = GTUI;
    const st = gtState.engine;
    if (!st) return U.form([U.section({ rows: [U.empty({ spin: true, title: 'در حال بررسی وضعیت اتصال…' })] })]);

    const eng = st.engine || {};
    const connected = !!eng.connected;
    const tunOn = connected && eng.mode === 'tun';
    const proxyOn = connected && eng.mode === 'proxy';
    const ks = st.killSwitch || {};
    // Proxy mode has no tunnel adapter, so the firewall allow-list the guard is built from
    // cannot exist and the guard is never engaged there. The switch used to render "on"
    // anyway — telling someone they were protected while nothing at all was blocking a
    // leak, on the one mode that already leaks every packet no proxy-aware app sends.
    const ksApplicable = ks.applicable !== false;
    const dnsGuard = st.dnsGuard || {};
    const busy = gtBusy();
    const v2s = gtSessionV2(gtState.status && gtState.status.session);
    // Shown whenever there is something to tear down — NOT only when connected. After the
    // watchdog gives up, `connected` is false while the kill-switch is still blocking the
    // machine's traffic; hiding the control there strands the user with no internet and no
    // control that obviously restores it.
    const needsTeardown = connected || !!ks.engaged || !!eng.running;
    const lt = st.leakTest || null;

    const state = connected
        ? U.row({ icon: tunOn ? 'ph-fill ph-globe-simple' : 'ph-fill ph-browser', tint: 'var(--mv-green)',
            title: tunOn ? 'تونل کامل فعال است' : 'پروکسی سیستم فعال است',
            sub: tunOn ? 'UDP فعال — مناسب بازی و تماس تصویری' : 'فقط TCP — بازی و تماس تصویری پشتیبانی نمی‌شود',
            end: U.pill('وصل', 'ok', true) })
        : U.row({ icon: 'ph-fill ph-plugs', tint: 'var(--mv-gray)', title: 'تونل خاموش است',
            sub: gtSessionLive() ? 'نشست ابری آماده است؛ یکی از دو مسیر پایین را روشن کنید.' : 'اول یک نشست ابری بسازید.',
            end: U.pill('خاموش') });

    return U.form([
        U.section({
            header: 'مسیر ترافیک',
            rows: [
                (!connected && eng.error) ? U.callout({ tone: 'danger', text: gtEsc(GT_ERRORS[eng.error] || eng.error) }) : '',
                state,
                U.switchRow({ name: 'tun', icon: 'ph-fill ph-globe-hemisphere-west', tint: 'var(--mv-blue)',
                    title: 'تونل کامل (پیشنهادی)',
                    sub: v2s ? 'همهٔ برنامه‌ها، DNS و UDP از تونل — روی آداپتور مشترک برنامه، بدون تونل در تونل. محافظ نشت و قفل‌های DNS و IPv6 خودکار روشن می‌شوند.'
                        : 'تمام ترافیک، با UDP — بازی و تماس تصویری کار می‌کند. کمترین پینگ.',
                    on: tunOn, disabled: !!busy, busy: busy === 'tun' }),
                U.switchRow({ name: 'proxy', icon: 'ph-fill ph-browser', tint: 'var(--mv-teal)',
                    title: v2s ? 'پراکسی سیستم (پوشش جزئی)' : 'پراکسی سیستم',
                    sub: v2s ? 'فقط مرورگر و برنامه‌های پراکسی‌پذیر؛ بقیهٔ برنامه‌ها و DNS با آدرس واقعی شما بیرون می‌روند.'
                        : 'فقط مرورگر و برنامه‌های پراکسی‌پذیر. بدون UDP، ولی روی اینترنت‌های سخت‌گیر بهتر جواب می‌دهد.',
                    on: proxyOn, disabled: !!busy, busy: busy === 'proxy' }),
            ],
            footer: 'هر بار فقط یکی از این دو روشن است؛ روشن کردن یکی، دیگری را خاموش می‌کند.',
        }),
        U.section({
            header: 'محافظ‌ها',
            rows: [
                ...gtGuardRows(st, busy, true),
                U.valueRow({ icon: 'ph-fill ph-list-magnifying-glass', tint: 'var(--mv-indigo)', title: 'قفل DNS',
                    sub: 'نام دامنه‌ها فقط از داخل تونل جستجو می‌شوند — با تونل کامل خودش روشن می‌شود.',
                    value: tunOn ? (dnsGuard.active ? U.pill('فعال', 'ok') : U.pill('هنوز فعال نشده', 'warn')) : U.pill('با تونل کامل'), html: true }),
                ksApplicable ? gtFirewallRow(st.firewall, busy) : '',
            ],
            footer: 'این محافظ‌ها برای لحظه‌ای‌اند که تونل قطع شود؛ تا وقتی تونل وصل است، خود تونل جلوی نشت را می‌گیرد.',
        }),
        U.section({
            header: 'سنجش',
            rows: [
                U.actionRow({ act: 'speedtest', icon: 'ph-fill ph-gauge', tint: 'var(--mv-green)',
                    title: connected ? 'تست سرعت و کیفیت مسیر' : 'تست سرعت خط (بدون تونل)',
                    sub: 'تأخیر، سرعت و سلامت هر بخش مسیر، هر کدام با توضیح', busy: busy === 'speed', disabled: !!busy }),
                gtSpeedRows(),
                v2s ? U.actionRow({ act: 'leaktest', icon: 'ph-fill ph-detective', tint: 'var(--mv-orange)',
                    title: 'آزمون نشتی', sub: tunOn ? 'آدرس، DNS، WebRTC و IPv6 — از چشم خود سایت‌ها' : 'با تونل کامل روشن معنا دارد',
                    value: lt ? gtLeakVerdict(lt).word : '', busy: busy === 'leak', disabled: !tunOn || !!busy }) : '',
                v2s && lt ? U.stack(gtLeakRows(lt)) : '',
            ],
        }),
        (needsTeardown || gtSessionLive()) ? U.section({
            header: 'اتصال',
            rows: [
                needsTeardown ? U.actionRow({ act: 'disconnect', icon: 'ph-bold ph-power', tint: 'var(--mv-red)', title: 'قطع اتصال',
                    sub: 'تونل، محافظ نشت و قفل‌ها روی این کامپیوتر برداشته می‌شوند', tone: 'danger', busy: busy === 'connect', disabled: !!busy }) : '',
                gtEndSessionRow(),
            ],
            footer: '«قطع اتصال» فقط تونل را روی این کامپیوتر می‌بندد و نشست ابری تا پایان وقتش سهمیه مصرف می‌کند.',
        }) : '',
    ]);
}

GTUI.on({
    act: {
        mode: (kind) => {
            const eng = (gtState.engine && gtState.engine.engine) || {};
            const on = !!eng.connected && eng.mode === kind;
            if (kind === 'tun') gtToggleTun(!on); else gtToggleProxy(!on);
        },
        disconnect: () => gtDisconnectEngine(),
        'fw-enable': () => gtSetFirewall(true),
        leaktest: () => gtRunLeakTest(),
        speedtest: () => gtRunSpeedtest(),
        'speed-copy': () => gtCopySpeedResults(),
    },
    switch: {
        tun: (on) => gtToggleTun(on),
        proxy: (on) => gtToggleProxy(on),
        killswitch: (on) => gtToggleKillSwitch(on),
        ipv6: (on) => gtToggleIpv6Guard(on),
        firewall: (on) => gtSetFirewall(on),
    },
});
