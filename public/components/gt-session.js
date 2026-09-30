// --- گیت‌هاب تانل · نشست ابری ---
// The cloud session: its card on the front page (the clock, where the server is, the seamless
// renewal, ending it early), and the setup run — while it goes, and when it stops, each stop with
// the one thing that unblocks it.

// «تونل پایدار» (gt-slots.js) on the session card: which slot, and whether the traffic is on it.
function gtSlotLine(slot) {
    const name = String(slot.name || '').toUpperCase();
    const eng = (gtState.engine && gtState.engine.engine) || {};
    const used = eng.connected && eng.slot && eng.slot.name === slot.name ? !!eng.slot.used : null;
    if (!slot.ready) return `${name} — وصل نشد؛ تونل‌های موقت`;
    if (used === false) return `${name} — جواب نداد؛ تونل‌های موقت`;
    return `${name} — فعال`;
}

// «تمدید خودکار بی‌وقفه» (routes.js › MAKE-BEFORE-BREAK), with what it is doing right now.
function gtRenewHint(short) {
    const st = gtState.status || {};
    const c = st.continuity || {};
    if (st.autoRenew === false) return 'خاموش — نشست در پایانش بسته می‌شود و اتصال قطع می‌شود.';
    if (c.phase === 'preparing') return 'نشست بعدی در حال آماده شدن و امتحان از مسیر Worker شماست — نشست فعلی همچنان وصل است…';
    if (c.phase === 'switching') return 'در حال جابه‌جایی به نشست تازه — فقط هستهٔ تونل یک بار دوباره راه می‌افتد (حدود یک ثانیه).';
    if (c.phase === 'failed') return `آخرین تلاش برای نشست بعدی ناموفق بود: ${GTUI.esc(c.error || '—')}`;
    if (c.phase === 'done') return 'آخرین جابه‌جایی بی‌وقفه موفق بود.';
    return short
        ? 'حدود ۸ دقیقه پیش از پایان، نشست بعدی آماده و بی‌وقفه جایگزین می‌شود.'
        : 'حدود ۸ دقیقه قبل از پایان، نشست بعدی (اگر بشود روی حساب دیگر) آماده و بی‌وقفه جایگزین می‌شود؛ اگر سرور ابری وسط کار از دست برود هم خودکار عوض می‌شود.';
}

async function gtSetAutoRenew(enabled) {
    gtState.busy = 'renew';
    gtRender();
    try {
        const r = await gtFetch('/api/github-tunnel/autorenew', { method: 'POST', body: JSON.stringify({ enabled }) });
        gtState.status = Object.assign({}, gtState.status, { autoRenew: r.autoRenew });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshStatus();
}

async function gtBeginSetup() {
    gtState.forceBrokerSetup = false;
    gtState.dismissedBrokerGate = false; // a fresh attempt earns a fresh look at the gate
    gtState.status = { provisioning: { state: 'SETTING_UP', log: [] }, session: null };
    // force: the broker form is still on screen at this point, and gtRender's unforced path
    // refuses to redraw while someone is typing in it — that guard exists to stop background
    // polls wiping a half-typed client secret. Without the flag the panel stayed frozen on «در
    // حال راه‌اندازی…» for the entire provisioning run: the setup really was progressing, and
    // even finished, but nothing on screen ever moved off the deploy step.
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/setup', { method: 'POST' });
        gtStartStatusPoll(true);
        await gtRefreshStatus();
    } catch (e) { gtToast(e.message); }
}

async function gtActivateAgain(force) {
    try {
        const r = await gtFetch('/api/github-tunnel/activate-again', { method: 'POST', body: JSON.stringify({ force: !!force }) });

        // The server refuses to spin up a second cloud session while one is still healthy
        // (that guard is the whole point of §14). Without asking here the click looked
        // dead, so make the choice explicit and re-issue with force when they confirm.
        if (r.existing) {
            const ok = await uiConfirm({
                title: 'نشست ابری فعلی هنوز فعال است',
                message: 'اگر نشست جدید بسازید، نشست فعلی پایان می‌یابد و کانفیگ جدید جایگزین آن می‌شود.',
                confirmLabel: 'ساخت نشست جدید',
                cancelLabel: 'استفاده از نشست فعلی',
                danger: true,
            });
            if (!ok) return;
            return gtActivateAgain(true);
        }

        gtState.status = { provisioning: { state: 'RENEWING', log: [] }, session: null };
        gtRender(true);   // same reason as gtBeginSetup: the form guard would swallow this
        gtStartStatusPoll(true);
    } catch (e) { gtToast(e.message); }
}

/**
 * The control that actually stops the meter.
 *
 * Disconnecting only takes the tunnel down on this machine; the cloud session keeps running
 * to its own limit and keeps spending the GitHub account's monthly minutes the entire time.
 * Someone who needed an hour and walked away pays for the remaining hours either way unless
 * they press this. It asks for confirmation, because it is the irreversible one: ending frees
 * the allowance but the next use has to provision a fresh machine from scratch.
 */
async function gtEndSession() {
    const ok = await uiConfirm({
        title: 'نشست ابری پایان یابد؟',
        message: 'مصرف سهمیه‌ی گیت‌هاب از همین لحظه متوقف می‌شود. برای استفاده‌ی بعدی یک نشست تازه ساخته می‌شود که چند دقیقه راه‌اندازی می‌خواهد.',
        confirmLabel: 'پایان نشست',
        cancelLabel: 'ادامه‌ی نشست',
    });
    if (!ok) return;
    gtState.busy = 'end';
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/session/end', { method: 'POST' });
        gtToast('نشست پایان یافت — مصرف دقیقه‌ها متوقف شد.');
    } catch (e) {
        gtToast(e.message || 'پایان نشست ناموفق بود.');
    } finally {
        gtState.busy = '';
        await gtRefreshStatus();
        await gtRefreshEngine();
        gtRender(true);
    }
}

/** The row that ends the session, wherever the session is shown. '' when there is none. */
function gtEndSessionRow(short) {
    if (!gtSessionLive()) return '';
    return GTUI.actionRow({ act: 'end-session', icon: 'ph-fill ph-stop-circle', tint: 'var(--mv-orange)',
        title: 'پایان نشست و ذخیرهٔ سهمیه',
        sub: short ? '' : 'اگر تا مدتی به تونل نیاز ندارید — مصرف دقیقه‌ها همین حالا متوقف می‌شود.',
        busy: gtState.busy === 'end', disabled: !!gtState.busy });
}

// ── the card ─────────────────────────────────────────────────────────────────────

function gtSessionCard(v) {
    const U = GTUI;
    if (!v.live) {
        return U.card({
            tint: 'var(--mv-green)', icon: 'ph-fill ph-cloud', title: 'نشست ابری', end: U.pill('ندارید'),
            body: '<div class="gt-note">هنوز نشستی ساخته نشده — دکمهٔ بالا یکی می‌سازد.</div>',
            foot: 'ساخت نشست چند دقیقه طول می‌کشد و از سهمیهٔ ماهانهٔ حساب گیت‌هاب برداشت می‌شود.',
        });
    }
    const session = v.session;
    const expiring = session.status === 'EXPIRING_SOON';
    const v2 = gtSessionV2(session);
    const r = session.runner || {};
    const where = [r.country ? `${U.flag(r.country, 16)}${U.esc(gtCountryFa(r.country))}` : '', r.city ? U.esc(r.city) : '']
        .filter(Boolean).join(' — ');
    const busy = gtBusy();

    const facts = v2 ? [
        (r.country || r.city) && { k: 'محل سرور', v: where, html: true },
        { k: 'تونل‌های کلادفلر', v: U.fa(session.tunnels || 0) },
        session.slot && { k: 'تونل پایدار', v: gtSlotLine(session.slot) },
        session.accountLogin && { k: 'روی حساب', v: '@' + session.accountLogin, ltr: true },
    ] : [
        { k: 'آدرس نشست', v: session.tailscaleIp || '—', ltr: true },
        session.accountLogin && { k: 'روی حساب', v: '@' + session.accountLogin, ltr: true },
    ];

    return U.card({
        tint: 'var(--mv-green)', icon: 'ph-fill ph-cloud', title: 'نشست ابری',
        end: expiring ? U.pill('به‌زودی پایان', 'warn', true) : U.pill('فعال', 'ok', true),
        side: U.cardAct({ act: 'renew', icon: 'ph-bold ph-arrows-clockwise', title: 'تمدید — یک نشست تازه به‌جای این', disabled: !!gtState.busy }),
        body: `<div class="gt-clock${expiring ? ' is-soon' : ''}"><b id="gt-countdown">${gtFmtCountdown(session.remainingMs || 0)}</b><small>زمان باقی‌ماندهٔ نشست ابری</small></div>`
            + U.facts(facts)
            + U.rows([
                v2 && U.switchRow({ name: 'autorenew', title: 'تمدید خودکار بی‌وقفه', sub: gtRenewHint(true),
                    on: (gtState.status || {}).autoRenew !== false, disabled: !!busy, busy: busy === 'renew' }),
                gtEndSessionRow(true),
            ]),
        foot: '«قطع اتصال» فقط تونل را روی این کامپیوتر می‌بندد؛ نشست ابری تا پایان وقتش سهمیه مصرف می‌کند، مگر پایانش دهید.',
    });
}

// ── the setup run ────────────────────────────────────────────────────────────────

/** A run that is going, or one that stopped — each with the thing that unblocks it. Or ''. */
function gtRunPanel() {
    const prov = gtState.status && gtState.status.provisioning;
    if (!prov) return '';
    if (prov.state === 'FAILED') {
        if (prov.errorCode === 'ACL_TAG_NOT_PERMITTED') return gtAclFixPanel(prov);
        if (prov.errorCode === 'BROKER_NOT_DEPLOYED') return gtBrokerGatePanel(false);
        if (prov.errorCode === 'BROKER_NEEDS_UPDATE') return gtBrokerGatePanel(true);
        return gtFailedPanel(prov);
    }
    if (prov.state !== 'READY') return gtProgressPanel(prov);
    return '';
}

function gtProgressPanel(prov) {
    const U = GTUI;
    const labels = {
        SETTING_UP: 'اتصال گیت‌هاب برقرار شد',
        STARTING: 'زیرساخت ابری آماده شد',
        INSTALLING: 'در حال راه‌اندازی سرور ابری',
        CONNECTING_NETWORK: 'در حال برقراری شبکه‌ی امن',
        READY: 'در حال ساخت کانفیگ',
        RENEWING: 'در حال ساخت نشست تازه',
    };
    // The stages themselves are the line above the cards (gtRenderFlow) — drawing them a
    // second time here was the same five rows twice on one screen. What this card is FOR is
    // the raw log: the only place that says what the runner is actually doing right now.
    const log = ((prov && prov.log) || []).slice(-6).map((l) => U.esc(l)).join('\n');
    return U.panel(`
        <div class="gt-panel-head">${U.tile('ph-fill ph-cloud-arrow-up', 'var(--mv-blue)')}
          <div><h2>${U.esc(labels[prov.state] || 'در حال آماده‌سازی')}</h2>
            <p>یک سرور ابری روی سهمیهٔ حساب گیت‌هاب شما بالا می‌آید. این چند دقیقه طول می‌کشد و اگر پنجره را ببندید هم ادامه پیدا می‌کند.</p></div>
        </div>
        ${log ? `<pre class="gt-log">${log}</pre>` : ''}`);
}

function gtFailedPanel(prov) {
    const U = GTUI;
    return U.notice({
        tone: 'danger',
        title: 'نتوانستیم تونل ابری شما را راه‌اندازی کنیم.',
        observed: prov && prov.error,
        actions: [
            U.button({ text: 'تلاش دوباره', act: 'setup', kind: 'primary', size: 'sm' }),
            U.button({ text: 'به‌روزرسانی سرویس شبکهٔ امن', act: 'broker-setup', size: 'sm' }),
            U.grow,
            U.button({ text: 'ریست کامل و شروع از اول', act: 'reset-all', kind: 'danger', size: 'sm' }),
        ],
    });
}

GTUI.on({
    act: {
        setup: () => gtBeginSetup(),
        renew: () => {
            const s = gtState.status && gtState.status.session;
            gtActivateAgain(!!s && s.status === 'EXPIRING_SOON');
        },
        'end-session': () => gtEndSession(),
    },
    switch: {
        autorenew: (on) => gtSetAutoRenew(on),
    },
});
