// --- گیت‌هاب تانل · حساب‌های گیت‌هاب ---
// Each account is a separate, exhaustible pot of GitHub Actions capacity. The panel's job is to
// make three things obvious at a glance: which one the tunnel is on right now, which ones could
// take over, and which ones need the user to do something. Plus the device-code sign-in that
// adds one.

const GT_ACCOUNT_STATE = {
    OK: { label: 'آماده', tone: 'ok' },
    UNKNOWN: { label: 'آماده', tone: 'ok' },
    EXHAUSTED: { label: 'سهمیه تمام شده', tone: 'warn' },
    RATE_LIMITED: { label: 'محدودیت موقت گیت‌هاب', tone: 'warn' },
    DISPATCH_FAILED: { label: 'اجرای ناموفق', tone: 'warn' },
    REPO_ERROR: { label: 'مشکل در زیرساخت این حساب', tone: 'warn' },
    AUTH_REQUIRED: { label: 'نیاز به اتصال دوباره', tone: 'bad' },
};

function gtAccountList() {
    return (gtState.accounts && gtState.accounts.accounts) || [];
}

function gtHasAccounts() { return gtAccountList().length > 0; }

/**
 * Tell the user what the last sign-in actually did.
 *
 * The device flow authorises whichever account is signed in ON GITHUB.COM, not whichever
 * one the user meant. So "add an account" from a browser already signed in as account #1
 * re-authorises account #1 and the pool does not grow. Silently succeeding there is the
 * worst outcome: the user believes they have a second capacity source and only finds out
 * they do not when the first one runs dry and nothing fails over.
 */
function gtNoticeSignIn() {
    const s = gtState.accounts && gtState.accounts.lastSignIn;
    if (!s || !s.at) return;
    if (gtState.lastSignInSeen === s.at) return;
    const first = gtState.lastSignInSeen === undefined;
    gtState.lastSignInSeen = s.at;
    if (first) return;   // a stale result from before this panel opened
    gtToast(s.created
        ? `حساب @${s.login} اضافه شد.`
        : `این همان حساب @${s.login} بود که از قبل متصل بود. برای افزودن یک حساب دیگر، اول در مرورگر از این حساب خارج شوید یا از پنجره‌ی ناشناس استفاده کنید.`);
}

// ── actions ──────────────────────────────────────────────────────────────────────

/** Add another account. Same device flow as the first one — the pool has no notion of a
 *  "primary" account, so there is nothing special about the second. */
function gtAddAccount() {
    gtState.addingAccount = true;
    gtConnectGithub();
}

/** Back out of adding an account without losing the ones already in the pool. */
async function gtCancelAddAccount() {
    gtState.addingAccount = false;
    gtState.connecting = false;
    if (gtState.githubPollTimer) { clearInterval(gtState.githubPollTimer); gtState.githubPollTimer = null; }
    try { await gtFetch('/api/github-tunnel/github/cancel', { method: 'POST' }); } catch (e) {}
    await gtRefreshGithub();
    await gtRefreshAccounts();
    gtRender(true);
}

async function gtRemoveAccount(id, login) {
    const ok = await uiConfirm({
        title: `حذف حساب @${login}؟`,
        message: 'اگر نشست فعالی روی همین حساب باشد پایان می‌یابد. نشست‌های حساب‌های دیگر دست‌نخورده می‌مانند.\n\nریپازیتوری گیت‌هاب شما حذف نمی‌شود.',
        confirmLabel: 'حذف حساب',
        danger: true,
    });
    if (!ok) return;
    try {
        await gtFetch('/api/github-tunnel/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) });
        gtToast('حساب حذف شد.');
    } catch (e) { gtToast(e.message); }
    await gtRefreshAccounts();
    await gtRefreshStatus();
    gtRender(true);
}

async function gtRetryAccount(id) {
    try {
        await gtFetch('/api/github-tunnel/accounts/retry', { method: 'POST', body: JSON.stringify({ id }) });
        gtToast('حساب دوباره در نوبت قرار گرفت.');
    } catch (e) { gtToast(e.message); }
    await gtRefreshAccounts();
    gtRender(true);
}

async function gtToggleAccount(id, disabled) {
    try {
        await gtFetch('/api/github-tunnel/accounts/toggle', { method: 'POST', body: JSON.stringify({ id, disabled }) });
    } catch (e) { gtToast(e.message); }
    await gtRefreshAccounts();
    gtRender(true);
}

async function gtRefreshQuota() {
    gtState.busy = 'quota';
    gtRender(true);
    try {
        gtState.accounts = await gtFetch('/api/github-tunnel/accounts/refresh', { method: 'POST' });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    gtRender(true);
}

async function gtConnectGithub() {
    gtState.connecting = true;
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/github/start', { method: 'POST' });
        await gtRefreshGithub();
        // PAINT IT. Without this the code sat in `gtState.githubStatus` unseen: the only other
        // render in this flow is the poll's, and the poll renders only when the sign-in has
        // ALREADY finished. So the browser tab opened asking for a code the app never showed.
        gtRender(true);
        gtStartGithubPoll();
    } catch (e) {
        gtState.connecting = false;
        gtToast(e.message);
        gtRender();
    }
}

function gtStartGithubPoll() {
    if (gtState.githubPollTimer) clearInterval(gtState.githubPollTimer);
    gtState.githubPollTimer = setInterval(async () => {
        await gtRefreshGithub();
        const p = gtState.githubStatus && gtState.githubStatus.pending;
        gtState.connecting = !!(p && p.state === 'waiting');
        // Still waiting: redraw anyway. The card carries a live state — «در انتظار تأیید…»,
        // and an expiry that turns into an error — and none of it moved without this.
        if (gtState.connecting) gtRender(true);
        if (!gtState.connecting) {
            clearInterval(gtState.githubPollTimer);
            // The sign-in landed in the pool server-side; pull the new row so the panel
            // shows it immediately instead of on the next slow tick.
            gtState.addingAccount = false;
            await gtRefreshAccounts();
            gtRender(true);
        }
    }, 2500);
}

function gtOpenVerificationUrl(url) {
    // نه nodeIntegration و نه یک پل contextBridge در این پنجره در دسترس است، پس require()
    // اینجا کار نمی‌کند. window.open کافی است — همان مسیری که main.js با
    // setWindowOpenHandler به مرورگر سیستم هدایتش می‌کند.
    window.open(url, '_blank');
}

async function gtDisconnectGithub() {
    const ok = await uiConfirm({
        title: 'اتصال گیت‌هاب قطع شود؟',
        message: 'نشست ابری فعال (در صورت وجود) پایان می‌یابد. ریپازیتوری شما حذف نمی‌شود.',
        confirmLabel: 'قطع اتصال',
        danger: true,
    });
    if (!ok) return;
    try {
        await gtFetch('/api/github-tunnel/github/disconnect', { method: 'POST' });
        gtToast('اتصال گیت‌هاب قطع شد.');
        gtState.status = null;
        await gtRefreshGithub();
        await gtRefreshStatus();
    } catch (e) { gtToast(e.message); }
}

// ── the sign-in ──────────────────────────────────────────────────────────────────

const GT_GITHUB_TILE = GTUI.tile('ph-fill ph-github-logo', 'var(--mv-gray)');

/**
 * The device code, or what stands before it, wherever the user asked for it.
 *
 * `onlyPending`: the accounts section shows it only while a sign-in is in flight — the page
 * already is the account list. It used to exist only on the front page, but «افزودن حساب» is a
 * button on the ACCOUNTS page too, and the code was then drawn on a page the user was not on.
 */
function gtSignInPanel(onlyPending) {
    const U = GTUI;
    const p = gtState.githubStatus && gtState.githubStatus.pending;
    const adding = gtHasAccounts();

    if (p && p.state === 'waiting') return gtCodePanel(p, adding);
    if (gtState.connecting) {
        // Clicked, the server has not answered yet — always show that something is happening.
        return U.panel(U.empty({ spin: true, title: 'در حال ساخت کد ورود…', text: 'لطفاً چند لحظه صبر کنید.',
            actions: adding ? [U.button({ text: 'انصراف', act: 'signin-cancel', kind: 'plain', size: 'sm' })] : [] }));
    }
    if (p && p.state === 'error') {
        return U.notice({ tone: 'danger', title: 'ورود به گیت‌هاب کامل نشد.', text: U.esc(p.error),
            actions: [U.button({ text: 'تلاش دوباره', act: 'signin', kind: 'primary', size: 'sm' })] });
    }
    if (onlyPending) return '';
    return U.panel(U.empty({
        tile: `<span class="mv-side-tile gt-welcome-tile" style="--tint:var(--mv-gray)"><i class="ph-fill ph-github-logo"></i></span>`,
        title: 'تونل ابری اختصاصی خودتان',
        text: 'حساب گیت‌هاب خود را با روشی امن متصل کنید — بقیهٔ مراحل را MLMVPN خودش انجام می‌دهد و سربرگ بالا می‌گوید هر لحظه کجای کار هستید.',
        actions: [
            U.button({ text: 'اتصال به گیت‌هاب', act: 'signin', kind: 'primary', size: 'lg', icon: 'ph-fill ph-github-logo' }),
        ],
    }) + U.actions([U.button({ text: 'پاک کردن همهٔ تنظیمات قبلی', act: 'reset-all', kind: 'plain', size: 'sm' })], 'is-center'), 'is-welcome');
}

function gtCodePanel(p, adding) {
    const U = GTUI;
    const guide = `<ol class="gt-guide">
        <li>این خطا مربوط به صفحهٔ «تأیید دستگاه» خودِ گیت‌هاب است و ربطی به MLMVPN ندارد. اول ایمیل خود را باز کنید؛ گیت‌هاب یک کد تأیید فرستاده است.</li>
        <li>آدرس <span class="mv-tech">github.com/sessions/verified-device</span> را دستی باز کنید و آن کد را وارد کنید.</li>
        <li>اگر باز هم نشد، همین صفحه را در یک مرورگر دیگر یا پنجرهٔ ناشناس باز کنید.</li>
        <li>اگر با «ورود با گوگل» خطای <span class="mv-tech">Looks like something went wrong</span> گرفتید، آن روش را رها کنید: در گیت‌هاب کاملاً خارج شوید و با <b>نام‌کاربری و رمز عبور</b> وارد شوید. ورود با گوگل در این مسیر پایدار نیست.</li>
        <li>کد بالا تا وقتی این پنجره باز است معتبر می‌ماند؛ لازم نیست از اول شروع کنید.</li>
      </ol>`;
    return U.panel(`
        <div class="gt-panel-head">${GT_GITHUB_TILE}
          <div><h2>${adding ? 'افزودن حساب گیت‌هاب' : 'اتصال به گیت‌هاب'}</h2>
            <p>این کد را در صفحهٔ گیت‌هاب وارد کنید. تا وقتی این پنجره باز است معتبر می‌ماند.</p></div>
        </div>
        <div class="gt-code">
          <div class="gt-code-value">${U.esc(p.userCode)}</div>
          ${U.actions([
              U.button({ text: 'کپی کد', icon: 'ph-bold ph-copy', act: 'signin-copy-code', size: 'sm' }),
              U.button({ text: 'باز کردن مرورگر', icon: 'ph-bold ph-arrow-square-out', act: 'signin-open', kind: 'primary', size: 'sm' }),
              U.button({ text: 'کپی آدرس', icon: 'ph-bold ph-link', act: 'signin-copy-url', size: 'sm' }),
          ], 'is-center')}
          <div class="gt-code-url">${U.esc(p.verificationUri)}</div>
          <span class="gt-wait">${U.spin()} در انتظار تأیید…</span>
        </div>
        <div class="mv-form-group">
          ${adding ? U.callout({ tone: 'warn', text: 'گیت‌هاب همان حسابی را تأیید می‌کند که <b>در مرورگر وارد شده است</b>. اگر الان با حساب قبلی لاگین هستید، همان دوباره ثبت می‌شود و حساب تازه‌ای اضافه نمی‌شود. برای حساب دوم: آدرس بالا را در پنجرهٔ <b>ناشناس (Incognito)</b> باز کنید و با حساب دوم وارد شوید.' }) : ''}
          ${U.disclosure({ key: 'gh-404', icon: 'ph-fill ph-lifebuoy', tint: 'var(--mv-orange)', title: 'صفحهٔ گیت‌هاب خطا داد یا ۴۰۴ شد؟', body: guide })}
        </div>
        ${adding ? U.actions([
            `<span class="gt-note">برای اینکه مقدار دقیق سهمیه نشان داده شود، هنگام تأیید همهٔ دسترسی‌های خواسته‌شده را قبول کنید.</span>`,
            U.grow,
            U.button({ text: 'انصراف', act: 'signin-cancel', kind: 'plain', size: 'sm' }),
        ]) : ''}`);
}

// ── one account ──────────────────────────────────────────────────────────────────

function gtAvatar(a) {
    const initial = GTUI.esc(String(a.login || '?').slice(0, 1).toUpperCase());
    return `<span class="gt-avatar">${a.avatarUrl ? `<img src="${GTUI.esc(a.avatarUrl)}" alt="" onerror="this.remove()">` : ''}${a.avatarUrl ? '' : initial}</span>`;
}

function gtAccountStateText(a) {
    const st = GT_ACCOUNT_STATE[a.health] || GT_ACCOUNT_STATE.UNKNOWN;
    const cooling = a.cooldownRemainingMs > 0;
    return `<span class="gt-state is-${st.tone}"><i></i>${GTUI.esc(st.label)}${cooling ? ` — ${GTUI.fa(Math.ceil(a.cooldownRemainingMs / 60000))} دقیقه دیگر` : ''}</span>`;
}

/**
 * The one line that says how much capacity this account has.
 *
 * Measured and estimated numbers are NEVER formatted the same way. An estimate is a floor
 * on spend with no allowance to compare against, and showing it in the same shape as a real
 * remaining balance would invite the user to plan around a number that does not mean what
 * it looks like.
 */
function gtQuotaLine(a) {
    const U = GTUI;
    const q = a.quota || {};
    if (q.source === 'measured' && q.includedMinutes != null) {
        const remaining = q.remainingMinutes != null ? q.remainingMinutes : Math.max(0, q.includedMinutes - q.usedMinutes);
        const pct = q.includedMinutes ? Math.min(100, Math.round((q.usedMinutes / q.includedMinutes) * 100)) : 0;
        const tone = remaining <= 0 ? 'var(--mv-red)' : (pct >= 80 ? 'var(--mv-orange)' : 'var(--mv-green)');
        return `<div class="gt-meter" style="--gt-meter:${tone}"><i style="width:${pct}%"></i></div>
            <span class="gt-meter-line"><span>${U.fa(remaining)} از ${U.fa(q.includedMinutes)} دقیقه باقی مانده</span><span>${U.fa(pct)}٪ مصرف</span></span>
            ${q.paidMinutesUsed > 0 ? '<small class="gt-acc-note">این حساب از اعتبار پولی هم استفاده می‌کند، پس با تمام شدن سهم رایگان متوقف نمی‌شود.</small>' : ''}`;
    }
    if (q.source === 'estimated') {
        return `<small class="gt-acc-note">حدود ${U.fa(q.usedMinutes || 0)} دقیقه مصرف شده — <b>تخمینی</b>. فقط اجراهای همین برنامه شمرده می‌شود، پس مصرف واقعی می‌تواند بیشتر باشد؛ برای عدد دقیق، این حساب را دوباره متصل کنید.</small>`;
    }
    // "نامشخص" on its own is the least useful thing this panel can say: the user cannot tell
    // whether something is broken, whether the account is usable, or what to do. There are
    // only two real causes and each has a different answer, so name the one that applies.
    if (!a.repository) {
        return '<small class="gt-acc-note">هنوز با این حساب نشستی ساخته نشده، پس چیزی برای شمردن نیست. بعد از اولین نشست، مصرف اینجا نشان داده می‌شود.</small>';
    }
    if (a.canReadBilling === false) {
        return '<small class="gt-acc-note">مقدار سهمیه خوانده نشد چون هنگام اتصال اجازهٔ خواندن اطلاعات حساب داده نشده است. برای عدد دقیق، این حساب را حذف و دوباره متصل کنید و همهٔ دسترسی‌ها را تأیید کنید.</small>';
    }
    return `<small class="gt-acc-note">مقدار سهمیه فعلاً خوانده نشد${(a.quota && a.quota.note) ? ` — ${U.esc(a.quota.note)}` : '. «بررسی دوبارهٔ سهمیه‌ها» را بزنید.'} این حساب همچنان قابل استفاده است.</small>`;
}

function gtAccountItem(a, currentId) {
    const U = GTUI;
    const isCurrent = a.id === currentId;
    const cooling = a.cooldownRemainingMs > 0;
    const badge = a.disabled ? U.pill('غیرفعال')
        : isCurrent ? U.pill('در حال استفاده', 'ok', true)
            : a.activeSessionId ? U.pill('نشست فعال', 'ok') : '';
    const arg = `${a.id}|${a.login}`;
    const tools = [
        a.health === 'AUTH_REQUIRED'
            ? U.button({ text: 'اتصال دوباره', act: 'account-reauth', kind: 'primary', size: 'sm' })
            : (cooling || a.consecutiveFailures) ? U.button({ icon: 'ph-bold ph-arrow-clockwise', title: 'تلاش دوباره', act: 'account-retry', arg: a.id, size: 'sm' }) : '',
        U.button({ icon: a.disabled ? 'ph-bold ph-play' : 'ph-bold ph-pause', title: a.disabled ? 'فعال کردن' : 'غیرفعال کردن', act: 'account-toggle', arg: `${a.id}|${a.disabled ? 'on' : 'off'}`, size: 'sm' }),
        U.button({ icon: 'ph-bold ph-trash', title: 'حذف حساب', act: 'account-remove', arg, size: 'sm', kind: 'danger' }),
    ];
    return `<div class="mv-li gt-acc${a.disabled ? ' is-off' : ''}${isCurrent ? ' is-sel' : ''}">
        <span class="mv-li-lead">${gtAvatar(a)}</span>
        <span class="mv-li-text">
          <span class="gt-acc-name"><b>@${U.esc(a.login)}</b>${badge}</span>
          <small>${gtAccountStateText(a)}</small>
          ${gtQuotaLine(a)}
          ${a.healthReason && a.health !== 'OK' ? `<small class="gt-acc-note" dir="ltr">${U.esc(String(a.healthReason).slice(0, 160))}</small>` : ''}
        </span>
        <span class="gt-acc-end">${tools.filter(Boolean).join('')}</span>
      </div>`;
}

// ── the card and the section ─────────────────────────────────────────────────────

function gtAccountsCard() {
    const U = GTUI;
    const list = gtAccountList();
    const ready = list.filter((a) => !a.disabled && a.health !== 'AUTH_REQUIRED' && a.cooldownRemainingMs <= 0).length;
    const needsAuth = list.filter((a) => a.health === 'AUTH_REQUIRED').length;
    const exhausted = list.filter((a) => a.health === 'EXHAUSTED').length;
    const currentId = gtState.accounts && gtState.accounts.currentAccountId;
    return U.card({
        tint: 'var(--mv-gray)', icon: 'ph-fill ph-github-logo', title: 'حساب‌های گیت‌هاب', go: 'accounts',
        end: list.length ? `<span class="gt-count-num">${U.fa(list.length)}</span>` : '—',
        side: U.cardAct({ act: 'account-add', icon: 'ph-bold ph-plus', title: 'افزودن حساب گیت‌هاب' }),
        body: list.length
            ? `<div class="gt-mini-list">${list.slice(0, 3).map((a) => `
                <div class="gt-mini">${gtAvatar(a)}<b>@${U.esc(a.login)}</b>${a.id === currentId ? U.pill('در حال استفاده', 'ok') : gtAccountStateText(a)}</div>`).join('')}
               ${list.length > 3 ? `<div class="gt-note">و ${U.fa(list.length - 3)} حساب دیگر</div>` : ''}</div>`
            : '<div class="gt-note">هنوز حسابی اضافه نشده.</div>',
        foot: list.length
            ? `${U.fa(ready)} آماده${exhausted ? ` · ${U.fa(exhausted)} سهمیه تمام` : ''}${needsAuth ? ` · ${U.fa(needsAuth)} نیاز به اتصال` : ''} — وقتی سهمیهٔ یکی تمام شود، خودش سراغ بعدی می‌رود.`
            : 'هر حساب گیت‌هاب یک منبع جداگانه برای اجرای نشست ابری است.',
    });
}

function gtRenderAccounts() {
    const U = GTUI;
    const list = gtAccountList();
    const currentId = gtState.accounts && gtState.accounts.currentAccountId;
    const problem = gtState.accounts && gtState.accounts.poolProblem;
    const anyEstimated = list.some((a) => a.quota && a.quota.source === 'estimated');
    const pending = gtSignInPanel(true);

    return (pending ? `<div class="gt-sec-lead">${pending}</div>` : '') + U.form([
        U.section({
            header: `حساب‌ها${list.length ? ` <span class="gt-header-count">${U.fa(list.length)}</span>` : ''}`,
            rows: [
                problem ? U.callout({ tone: 'danger', text: U.esc(problem.message) }) : '',
                list.length
                    ? `<div class="mv-list">${list.map((a) => gtAccountItem(a, currentId)).join('')}</div>`
                    : U.empty({ icon: 'ph-fill ph-github-logo', title: 'هنوز حسابی اضافه نشده', text: 'هر حساب گیت‌هاب یک منبع جداگانه برای اجرای نشست ابری است.' }),
            ],
            footer: [
                'وقتی سهمیهٔ یک حساب تمام شود، MLMVPN خودش سراغ حساب بعدی می‌رود — لازم نیست کاری کنید.',
                anyEstimated ? 'بعضی حساب‌ها هنگام اتصال اجازهٔ خواندن سهمیه را ندادند و مصرفشان تخمینی نشان داده می‌شود. برای عدد دقیق، همان حساب را دوباره متصل کنید و همهٔ دسترسی‌ها را تأیید کنید.' : '',
            ],
        }),
        U.section({
            header: 'کارها',
            rows: [
                U.actionRow({ act: 'account-add', icon: 'ph-bold ph-plus', tint: 'var(--mv-green)', title: 'افزودن حساب گیت‌هاب', sub: 'یک منبع دیگر برای نشست‌ها — همان ورود امن با کد' }),
                U.actionRow({ act: 'quota-refresh', icon: 'ph-bold ph-arrows-clockwise', tint: 'var(--mv-blue)', title: 'بررسی دوبارهٔ سهمیه‌ها', sub: 'مصرف هر حساب را همین حالا از گیت‌هاب می‌خواند', busy: gtState.busy === 'quota' }),
            ],
        }),
        U.section({
            header: 'بازنشانی',
            rows: [
                U.actionRow({ act: 'github-disconnect', icon: 'ph-bold ph-plugs', tint: 'var(--mv-red)', title: 'قطع اتصال همهٔ حساب‌ها', tone: 'danger' }),
                U.actionRow({ act: 'reset-all', icon: 'ph-bold ph-arrow-counter-clockwise', tint: 'var(--mv-red)', title: 'ریست کامل و شروع از اول', tone: 'danger' }),
            ],
            footer: '«ریست کامل» اتصال گیت‌هاب، تنظیمات سرویس شبکهٔ امن، کلیدها و همهٔ نشست‌ها را پاک می‌کند. ریپازیتوری گیت‌هاب و سرویسی که روی کلادفلر دیپلوی شده حذف نمی‌شوند.',
        }),
    ]);
}

GTUI.on({
    act: {
        signin: () => gtConnectGithub(),
        'signin-cancel': () => gtCancelAddAccount(),
        'signin-copy-code': () => { const p = gtState.githubStatus && gtState.githubStatus.pending; if (p) gtCopyText(p.userCode, 'کد کپی شد.'); },
        'signin-copy-url': () => { const p = gtState.githubStatus && gtState.githubStatus.pending; if (p) gtCopyText(p.verificationUri, 'آدرس کپی شد — در پنجرهٔ ناشناس باز کنید.'); },
        'signin-open': () => { const p = gtState.githubStatus && gtState.githubStatus.pending; if (p) gtOpenVerificationUrl(p.verificationUri); },
        'account-add': () => gtAddAccount(),
        'account-reauth': () => gtAddAccount(),
        'account-retry': (id) => gtRetryAccount(id),
        'account-toggle': (arg) => { const [id, to] = String(arg).split('|'); gtToggleAccount(id, to === 'off'); },
        'account-remove': (arg) => { const i = String(arg).indexOf('|'); gtRemoveAccount(String(arg).slice(0, i), String(arg).slice(i + 1)); },
        'quota-refresh': () => gtRefreshQuota(),
        'github-disconnect': () => gtDisconnectGithub(),
    },
});
