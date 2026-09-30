// --- گیت‌هاب تانل · سرویس شبکهٔ امن ---
// The relay on the user's own Cloudflare account (a Worker on workers.dev that reaches the cloud
// session), its optional custom domain, and «تونل پایدار» — three named tunnels reached through
// the same Worker (gt-slots.js). The Tailscale form of the first data plane is kept for the
// sessions that still use it, and so is the one step of it MLMVPN cannot do: the ACL tag.

/** The Cloudflare account the section is set to — the pop-up's choice, or the only one there is. */
function gtPickedCfAccount() {
    const accounts = gtLoadCfAccounts();
    return accounts.find((a) => a.id === gtState.ui.cfAccount) || accounts[0] || null;
}

// ── actions ──────────────────────────────────────────────────────────────────────

async function gtSlotsAction(kind) {
    const acc = gtPickedCfAccount();
    if (!acc) { gtState.slotsError = 'یک حساب کلادفلر انتخاب کنید.'; gtRender(true); return; }
    gtState.slotsBusy = kind;
    gtState.slotsError = '';
    gtRender(true);
    try {
        await gtFetch(`/api/github-tunnel/slots/${kind}`, { method: 'POST', body: JSON.stringify({ email: acc.email, token: acc.token, accountName: acc.name }) });
        gtToast(kind === 'setup' ? 'تونل پایدار آماده است — از نشست بعدی به کار می‌رود.' : 'تونل پایدار برداشته شد.');
    } catch (e) {
        gtState.slotsError = e.message;
    }
    gtState.slotsBusy = '';
    await gtRefreshBroker();
    await gtRefreshStatus();
    gtRender(true);
}

async function gtSaveBrokerUrl() {
    const el = document.getElementById('gt-broker-url');
    const url = el ? el.value : (gtState.drafts['gt-broker-url'] || '');
    try {
        await gtFetch('/api/github-tunnel/broker/url', { method: 'POST', body: JSON.stringify({ url }) });
        gtToast(url ? 'آدرس اختصاصی ثبت شد.' : 'آدرس اختصاصی حذف شد.');
        delete gtState.drafts['gt-broker-url'];
        await gtRefreshBroker();
        gtRender(true);
    } catch (e) { gtToast(e.message); }
}

async function gtForceBrokerSetup() {
    gtState.brokerError = '';
    gtState.dismissedBrokerGate = false;
    // Load the stored values FIRST, then paint once: rendering an empty form and filling
    // it a moment later is the same clobbering problem in miniature.
    await gtRefreshBroker();
    gtGoSec('broker');
}

async function gtDeployBroker() {
    const b = gtState.broker || {};
    const v2 = gtNewSessionsV2();
    // v2 hides the Tailscale fields; whatever was stored before is sent back as it was, so a
    // redeploy for the new tunnel never takes v1's key minting away behind the user's back.
    const field = (id, stored) => { const el = document.getElementById(id); return el ? el.value : (v2 ? (stored || '') : ''); };
    const tsClientId = field('gt-ts-id', b.tsClientId);
    const tsClientSecret = field('gt-ts-secret', b.tsClientSecret);
    const tsTailnet = field('gt-ts-tailnet', b.tsTailnet);

    const acc = gtPickedCfAccount();
    if (!acc) { gtState.brokerError = 'یک حساب کلادفلر انتخاب کنید.'; gtRender(true); return; }
    if (!v2 && (!tsClientId || !tsClientSecret || !tsTailnet)) { gtState.brokerError = 'همه‌ی فیلدها را پر کنید.'; gtRender(true); return; }

    gtState.brokerDeploying = true;
    gtState.brokerError = '';
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/broker/deploy', {
            method: 'POST',
            body: JSON.stringify({
                email: acc.email, token: acc.token, accountName: acc.name,
                tsClientId, tsClientSecret, tsTailnet,
            }),
        });
        gtState.brokerDeploying = false;
        ['gt-ts-id', 'gt-ts-secret', 'gt-ts-tailnet'].forEach((k) => { delete gtState.drafts[k]; });
        await gtRefreshBroker();
        await gtRefreshStatus();

        // Only chain into a full session setup when there ISN'T one already. Redeploying
        // the relay while a session is live used to restart the whole provisioning flow —
        // which, to someone who just wanted to update the relay, looks like the app
        // spontaneously throwing away a working tunnel.
        if (gtSessionLive()) {
            gtState.forceBrokerSetup = false;
            gtToast('سرویس شبکه‌ی امن به‌روزرسانی شد. نشست فعلی دست‌نخورده ماند.');
            gtRender(true);
            return;
        }
        gtToast('سرویس شبکه‌ی امن راه‌اندازی شد. در حال ادامه‌ی راه‌اندازی…');
        await gtBeginSetup();
    } catch (e) {
        gtState.brokerDeploying = false;
        gtState.brokerError = e.message;
        gtRender(true);
    }
}

function gtOpenCloud() {
    if (window.MV && MV.wm && document.documentElement.classList.contains('mv-shell')) MV.wm.open('cloud');
    else if (typeof toggleLeftSidebar === 'function') toggleLeftSidebar('cloud');
}

// ── the ACL step (the first data plane only) ────────────────────────────────────
// The ACL edit is the one setup step MLMVPN cannot do on the user's behalf: Tailscale will
// not mint a key for a tag its own policy file has never heard of. It must therefore be
// sayable in two different places — inside the relay guide, and again on its own when the
// failure happens later — so it lives in one place and is rendered into both.
const GT_ACL_TEXT = `"tagOwners": {
  "tag:mlmvpn-gt": ["autogroup:admin"],
},
"autoApprovers": {
  "exitNode": ["tag:mlmvpn-gt"],
},`;

function gtCopyAcl() {
    gtCopyText(GT_ACL_TEXT, 'کپی شد — در فایل ACL جای‌گذاری کنید.');
}

function gtLink(text, url) {
    return `<button type="button" class="mv-link"${GTUI.act('open-url', url)}>${GTUI.esc(text)}</button>`;
}

function gtAclBlock() {
    const U = GTUI;
    return `به ${gtLink('صفحهٔ Access Controls', 'https://login.tailscale.com/admin/acls/file')} بروید و این دو بلوک را داخل فایل (بین همان آکولادهای بیرونی، کنار بقیهٔ بخش‌ها) اضافه کنید، بعد <b>Save</b> بزنید:
        <pre class="gt-pre">${U.esc(GT_ACL_TEXT)}</pre>
        ${U.actions([U.button({ text: 'کپی این متن', icon: 'ph-bold ph-copy', act: 'acl-copy', size: 'sm' })])}`;
}

/** Shown when Tailscale itself rejected the tag. Nothing else in the app can fix this, so
 *  the panel stops and says exactly which edit is missing rather than reporting a 400. */
function gtAclFixPanel(prov) {
    const U = GTUI;
    return U.panel(`
        <div class="gt-panel-head">${U.tile('ph-fill ph-key', 'var(--mv-orange)')}
          <div><h2>یک مرحله باقی مانده است</h2>
            <p>حساب Tailscale شما هنوز تگ دسترسی <span class="mv-tech">tag:mlmvpn-gt</span> را نمی‌شناسد، برای همین اجازهٔ ساخت کلید را نداد. این تنها کاری است که MLMVPN نمی‌تواند به‌جای شما انجام دهد — یک‌بار انجامش دهید و دیگر لازم نیست تکرارش کنید.</p></div>
        </div>
        <div class="mv-form-group">${U.stack(`<div class="gt-disc-body">${gtAclBlock()}</div>`)}</div>
        <p class="gt-note">اگر هنگام ساخت OAuth client هم تگی انتخاب نکرده بودید، بعد از Save کردن ACL یک‌بار به بخش «سرویس شبکهٔ امن» بروید و client را با انتخاب همین تگ دوباره بسازید.</p>
        ${U.actions([
            U.button({ text: 'انجام دادم — تلاش دوباره', act: 'setup', kind: 'primary', size: 'sm' }),
            U.button({ text: 'تنظیمات سرویس شبکهٔ امن', act: 'broker-setup', size: 'sm' }),
        ])}
        ${prov && prov.error ? `<code class="gt-observed" dir="ltr">${U.esc(prov.error)}</code>` : ''}`);
}

/** The run stopped before a runner was dispatched: the relay is missing or out of date. */
function gtBrokerGatePanel(update) {
    const U = GTUI;
    return update
        ? U.notice({ tone: 'warn', title: 'سرویس شبکهٔ امن یک به‌روزرسانی لازم دارد',
            // Checked before a runner is dispatched, so nothing was spent — say that too.
            text: 'تونل جدید از مسیری در همین سرویس به سرور ابری می‌رسد که نسخهٔ فعلی‌اش ندارد. یک‌بار به‌روزش کنید — چند ثانیه طول می‌کشد، روی حساب کلادفلر خودتان است، و از سهمیهٔ گیت‌هاب هم چیزی کم نشده.',
            actions: [U.button({ text: 'به‌روزرسانی سرویس شبکهٔ امن', go: 'broker', kind: 'primary', size: 'sm' })] })
        : U.notice({ title: 'سرویس شبکهٔ امن هنوز راه‌اندازی نشده',
            text: 'این یک‌بار انجام می‌شود و روی حساب کلادفلر خودتان نصب می‌شود. تا قبل از آن، نشست ابری نمی‌تواند به شبکهٔ شما وصل شود.',
            actions: [U.button({ text: 'راه‌اندازی سرویس شبکهٔ امن', go: 'broker', kind: 'primary', size: 'sm' })] });
}

// ── the card ─────────────────────────────────────────────────────────────────────

function gtBrokerState(b) {
    if (b.needsRedeploy) return { word: 'نیاز به بروزرسانی', tone: 'warn' };
    if (b.deployed) return { word: 'راه‌اندازی شده', tone: 'ok' };
    return { word: 'راه‌اندازی نشده', tone: '' };
}

function gtSlotsState() {
    const st = (gtState.status && gtState.status.slots) || {};
    const on = !!st.enabled;
    const bound = Array.isArray(st.slotsBound) && st.slotsBound.length >= 3;
    return { st, on, bound, word: on && bound ? 'روشن' : on ? 'نیمه‌کاره' : 'خاموش', tone: on && bound ? 'ok' : on ? 'warn' : '' };
}

function gtBrokerCard() {
    const U = GTUI;
    const b = gtState.broker || {};
    const bs = gtBrokerState(b);
    const slots = gtSlotsState();
    const facts = U.facts([
        b.effectiveUrl && { k: 'آدرس', v: String(b.effectiveUrl).replace(/^https?:\/\//, ''), ltr: true },
        b.tsTailnet && { k: 'Tailnet', v: b.tsTailnet, ltr: true },
        gtNewSessionsV2() && { k: 'تونل پایدار', v: slots.on && slots.bound ? 'روشن — سه تونل ثابت' : slots.word },
    ]);
    return U.card({
        tint: 'var(--mv-indigo)', icon: 'ph-fill ph-cloud-check', title: 'سرویس شبکهٔ امن', go: 'broker',
        end: U.pill(bs.word, bs.tone),
        body: facts || '<div class="gt-note">یک‌بار راه‌اندازی می‌شود و روی حساب کلادفلر خودتان می‌نشیند.</div>',
        foot: b.needsRedeploy
            ? (b.redeployReason === 'feature'
                ? 'برای تونل جدید، این سرویس یک مسیر تازه لازم دارد — یک‌بار «به‌روزرسانی و ادامه» را بزنید؛ نشست فعلی دست‌نخورده می‌ماند.'
                : 'این سرویس با نسخهٔ قدیمی راه‌اندازی شده و از نظر امنیتی باز است — یک‌بار «به‌روزرسانی و ادامه» را بزنید؛ نشست فعلی دست‌نخورده می‌ماند.')
            : 'مسیری که اتصال شما از آن به سرور ابری می‌رسد. روی حساب کلادفلر خودتان است، نه سرور ما.',
    });
}

// ── the section ──────────────────────────────────────────────────────────────────

/** The Cloudflare account row: a pop-up when there is a choice, the name when there is not. */
function gtCfAccountRow(accounts) {
    const U = GTUI;
    const picked = gtPickedCfAccount();
    if (accounts.length > 1) {
        return U.row({ icon: 'ph-fill ph-user-circle', tint: 'var(--mv-orange)', title: 'حساب کلادفلر',
            end: U.popup({ id: 'gt-broker-account', change: 'cf-account', label: 'حساب کلادفلر', value: picked && picked.id,
                options: accounts.map((a) => ({ value: a.id, text: a.name })) }) });
    }
    return U.valueRow({ icon: 'ph-fill ph-user-circle', tint: 'var(--mv-orange)', title: 'حساب کلادفلر', value: accounts[0].name });
}

/** «دامنهٔ اختصاصی»: the same in both data planes. */
function gtCustomDomainSection(placeholder, footer) {
    const U = GTUI;
    const b = gtState.broker || {};
    return U.section({
        header: 'دامنهٔ اختصاصی (اختیاری)',
        rows: [
            U.stack(`<div class="gt-field-line">
                ${U.field({ id: 'gt-broker-url', value: b.customUrl || '', ltr: true, placeholder, label: 'آدرس اختصاصی', enter: 'broker-url-save' })}
                ${U.button({ text: 'ذخیره', act: 'broker-url-save', size: 'sm' })}
              </div>`),
            b.effectiveUrl ? U.valueRow({ title: 'در حال استفاده', value: b.effectiveUrl, ltr: true, copy: b.effectiveUrl }) : '',
        ],
        footer,
    });
}

function gtSlotsSection() {
    const U = GTUI;
    const b = gtState.broker || {};
    const s = gtSlotsState();
    const busy = gtState.slotsBusy || '';
    return U.section({
        header: 'تونل پایدار',
        rows: [
            U.row({ icon: 'ph-fill ph-infinity', tint: 'var(--mv-green)', title: 'سه تونل ثابت کلادفلر',
                sub: 'روی حساب خودتان، که <b>فقط از راه همین Worker</b> به آن‌ها می‌رسید — بدون نیاز به دامنه.',
                end: U.pill(s.word, s.tone, s.on) }),
            s.on ? U.valueRow({ title: 'تونل‌ها', value: Object.keys(s.st.slots || {}).map((k) => k.toUpperCase()).join('، ') || '—' }) : '',
            s.on ? U.valueRow({ title: 'کلیدها روی حساب‌های گیت‌هاب', value: `${U.fa(s.st.accountsReady || 0)} از ${U.fa(s.st.accountsTotal || 0)}` }) : '',
            s.on && !s.bound ? U.callout({ tone: 'warn', text: 'Worker هنوز به تونل‌ها وصل نیست — «راه‌اندازی دوباره» را بزنید.' }) : '',
            !b.deployed && !s.on ? U.callout({ text: 'سرویس شبکهٔ امن هم همراهش راه‌اندازی می‌شود.' }) : '',
            gtState.slotsError ? U.callout({ tone: 'danger', text: U.esc(gtState.slotsError) }) : '',
            U.stack(U.actions([
                U.button({ text: s.on ? 'راه‌اندازی دوباره' : 'راه‌اندازی تونل پایدار', act: 'slots-setup', kind: 'primary', size: 'sm',
                    busy: busy === 'setup', busyText: 'در حال راه‌اندازی…', disabled: !!busy }),
                s.on ? U.button({ text: 'برداشتن', act: 'slots-remove', size: 'sm', kind: 'danger',
                    busy: busy === 'remove', busyText: 'در حال برداشتن…', disabled: !!busy }) : '',
            ])),
        ],
        footer: [
            'برخلاف تونل‌های موقت، سقف ۲۰۰ درخواست هم‌زمان ندارند و سرویس آزمایشی نیستند؛ تونل‌های موقت کنارشان پشتیبان می‌مانند. هر نشست یکی از تونل‌ها را می‌گیرد و نشست بعدی (تمدید بی‌وقفه) دیگری را. روی خط واقعی ایران: <b>۹۰٪ سرعت خط</b>.',
            'از قابلیت Workers VPC کلادفلر استفاده می‌کند که فعلاً آزمایشی (بتا) و برای همهٔ حساب‌ها رایگان است. راه‌اندازی، Worker را یک بار دوباره منتشر می‌کند؛ نشستِ در حال اجرا دست نمی‌خورد و از نشست بعدی به کار می‌رود.',
        ],
    });
}

function gtRenderBroker() {
    const U = GTUI;
    const accounts = gtLoadCfAccounts();
    if (!accounts.length) {
        return U.form([U.section({ rows: [U.empty({
            icon: 'ph-fill ph-cloud-slash', title: 'اول یک حساب کلادفلر وصل کنید',
            text: 'سرویس شبکهٔ امن روی حساب کلادفلر خودتان نصب می‌شود. حساب را در «زیرساخت ابری» اضافه کنید — مراحلی که تا الان طی کرده‌اید (اتصال گیت‌هاب) از دست نمی‌رود.',
            actions: [
                U.button({ text: 'رفتن به زیرساخت ابری', act: 'open-cloud', kind: 'primary', size: 'sm' }),
                U.button({ text: 'بررسی دوباره', act: 'broker-recheck', size: 'sm' }),
            ],
        })] })]);
    }

    const b = gtState.broker || {};
    const bs = gtBrokerState(b);
    const deploying = gtState.brokerDeploying;
    const deployBtn = (text) => U.button({ text, act: 'broker-deploy', kind: 'primary', size: 'sm', busy: deploying, busyText: 'در حال راه‌اندازی…' });

    // The new tunnel needs nothing but the Cloudflare account: no Tailscale, no ACL, no keys.
    // Beside it, «تونل پایدار» (gt-slots.js) — the same account, one more button.
    if (gtNewSessionsV2()) {
        return U.form([
            U.section({
                header: 'Worker کلادفلر',
                rows: [
                    U.row({ icon: 'ph-fill ph-cloud-check', tint: 'var(--mv-indigo)', title: 'سرویس شبکهٔ امن',
                        sub: 'مسیری که اتصال شما از آن به سرور ابری می‌رسد', end: U.pill(bs.word, bs.tone, !!b.deployed) }),
                    gtCfAccountRow(accounts),
                    b.effectiveUrl ? U.valueRow({ title: 'آدرس', value: String(b.effectiveUrl).replace(/^https?:\/\//, ''), ltr: true, copy: b.effectiveUrl }) : '',
                    b.needsRedeploy ? U.callout({ tone: 'warn', text: b.redeployReason === 'feature'
                        ? 'برای تونل جدید، این سرویس یک مسیر تازه لازم دارد — یک‌بار به‌روزش کنید؛ نشست فعلی دست‌نخورده می‌ماند.'
                        : 'این سرویس با نسخهٔ قدیمی راه‌اندازی شده و از نظر امنیتی باز است — یک‌بار به‌روزش کنید؛ نشست فعلی دست‌نخورده می‌ماند.' }) : '',
                    gtState.brokerError ? U.callout({ tone: 'danger', text: U.esc(gtState.brokerError) }) : '',
                    U.stack(U.actions([deployBtn(b.deployed ? 'به‌روزرسانی و ادامه' : 'راه‌اندازی و ادامه')])),
                ],
                footer: `یک Worker کوچک روی حساب کلادفلر خودتان. نشانی مستقیم سرورهای ابری (<span class="mv-tech">trycloudflare.com</span>) در ایران بسته است؛ این Worker روی <span class="mv-tech">workers.dev</span> است که با آی‌پی تمیز باز می‌شود، و فقط اتصالی را می‌پذیرد که برگهٔ امضاشدهٔ همین نصبِ برنامه را داشته باشد.`,
            }),
            gtSlotsSection(),
            gtCustomDomainSection('https://edge.yourdomain.com',
                `اگر دامنه‌ای در همین حساب کلادفلر دارید، در داشبورد یک Route به این سرویس بدهید و آدرسش را اینجا بگذارید. دامنهٔ خودتان را کمتر از <span class="mv-tech">workers.dev</span> مشترک فیلتر می‌کنند.`),
        ]);
    }

    // The first data plane: the Tailscale client, pre-filled from what was used last time — plain
    // editable fields, because the operator may well need to rotate the client, and a locked field
    // would force them out to the console for something this form is the right place for.
    const guide = `<ol class="gt-guide">
        <li><b>اول این را انجام دهید</b> — تگ باید قبل از ساخت OAuth client وجود داشته باشد، وگرنه در مرحلهٔ بعد نمی‌توانید انتخابش کنید.<br>${gtAclBlock()}</li>
        <li>وارد ${gtLink('login.tailscale.com/admin/settings/oauth', 'https://login.tailscale.com/admin/settings/oauth')} شوید (اگر حساب Tailscale ندارید، همان‌جا رایگان بسازید).</li>
        <li>روی «Generate OAuth client» بزنید. در بخش Scopes فقط <span class="mv-tech">Devices: Write</span> را تیک بزنید، و در کادر tags که ظاهر می‌شود <span class="mv-tech">tag:mlmvpn-gt</span> را انتخاب کنید.</li>
        <li>مقدار «Client ID» و «Client Secret» را در دو فیلد پایین کپی کنید (Secret فقط یک‌بار نشان داده می‌شود).</li>
        <li>برای «Tailnet»: بالای همان صفحه، کنار نام حسابتان (مثلاً <span class="mv-tech">you@gmail.com</span>) — دقیقاً همان متن را کپی کنید. با دامنهٔ سازمانی: <span class="mv-tech">example.com</span>؛ اگر هیچ‌کدام معلوم نبود: <span class="mv-tech">-</span> (یعنی tailnet پیش‌فرض).</li>
      </ol>`;
    return U.form([
        U.section({
            header: 'راه‌اندازی سرویس شبکهٔ امن',
            rows: [
                U.disclosure({ key: 'ts-guide', icon: 'ph-fill ph-book-open', tint: 'var(--mv-blue)',
                    title: b.tsClientId ? 'راهنما (در صورت نیاز به تغییر)' : 'راهنمای گرفتن این سه مقدار', body: guide }),
                gtCfAccountRow(accounts),
                U.stack(U.field({ id: 'gt-ts-id', value: b.tsClientId || '', ltr: true, placeholder: 'Tailscale OAuth Client ID', label: 'Client ID' })),
                U.stack(U.field({ id: 'gt-ts-secret', type: 'password', value: b.tsClientSecret || '', ltr: true, placeholder: 'Tailscale OAuth Client Secret', label: 'Client Secret' })),
                U.stack(U.field({ id: 'gt-ts-tailnet', value: b.tsTailnet || '', ltr: true, placeholder: 'Tailnet (مثلاً example.com)', label: 'Tailnet' })),
                gtState.brokerError ? U.callout({ tone: 'danger', text: U.esc(gtState.brokerError) }) : '',
                U.stack(U.actions([deployBtn('به‌روزرسانی و ادامه')])),
            ],
            footer: 'این مقادیر فقط به کلادفلر فرستاده می‌شوند و در MLMVPN ذخیره نمی‌گردند؛ فقط همین یک بار واردشان می‌کنید.',
        }),
        gtCustomDomainSection('https://broker.yourdomain.com',
            `آدرس پیش‌فرض روی <span class="mv-tech">workers.dev</span> است که یک دامنهٔ مشترک و شناخته‌شده است و ممکن است یک‌جا فیلتر شود. اگر دامنه‌ای در همین حساب کلادفلر دارید، در داشبورد یک Route به این سرویس بدهید و آدرسش را اینجا بگذارید.`),
    ]);
}

GTUI.on({
    act: {
        'broker-setup': () => gtForceBrokerSetup(),
        'broker-deploy': () => gtDeployBroker(),
        'broker-url-save': () => gtSaveBrokerUrl(),
        'broker-recheck': () => gtRender(true),
        'slots-setup': () => gtSlotsAction('setup'),
        'slots-remove': () => gtSlotsAction('remove'),
        'acl-copy': () => gtCopyAcl(),
        'open-url': (url) => gtOpenVerificationUrl(url),
        'open-cloud': () => gtOpenCloud(),
    },
    change: {
        'cf-account': (id) => { gtState.ui.cfAccount = id; },
    },
});
