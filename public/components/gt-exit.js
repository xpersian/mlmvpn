// --- گیت‌هاب تانل · کشور خروجی (P4) ---
// The country is chosen ON THE SERVER (runner/exits.mjs): the runner brings an exit up, and this
// PC moves its ONE tunnel onto that exit's user. VPN Gate carries TCP and UDP; Psiphon only TCP.
// Per-site rules send named sites through another country while everything else keeps the
// default; a vless link hands the same exit to the user's own phone.

const GT_EXIT_FALLBACK = ['JP', 'KR', 'US', 'DE', 'NL', 'GB', 'FR', 'SG', 'CA', 'SE', 'CH', 'TH', 'VN'];
const GT_EXIT_MAX_RULES = 5;

function gtCountryFa(cc) {
    try { return new Intl.DisplayNames(['fa'], { type: 'region' }).of(cc) || cc; } catch (e) { return cc; }
}

/** Every country the runner could bring up, one line each, sorted by its Persian name. */
function gtExitOptions(catalog) {
    const vg = (catalog && catalog.vpngate) || {};
    const psi = (catalog && Array.isArray(catalog.psiphon) && catalog.psiphon.length) ? catalog.psiphon : GT_EXIT_FALLBACK;
    const all = [...new Set([...Object.keys(vg), ...psi])].filter((c) => /^[A-Z]{2}$/.test(c));
    return all.map((cc) => ({ cc, name: gtCountryFa(cc), vg: vg[cc] || 0, psiphon: psi.includes(cc) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fa'));
}

function gtExitPrefs() {
    const choice = (gtState.status && gtState.status.exitChoice) || {};
    return choice.prefs || { country: '', provider: '', rules: [] };
}
function gtExitJob() {
    return ((gtState.status && gtState.status.exitChoice) || {}).job || { phase: 'idle' };
}
function gtExitEngine() { return (gtState.engine && gtState.engine.engine) || {}; }

const GT_PROVIDER_FA = { vpngate: 'VPN Gate', psiphon: 'Psiphon' };

/** One line on what a country offers: which providers, how many servers, what they carry. */
function gtExitOfferLine(o) {
    if (!o) return '';
    if (o.vg && o.psiphon) return `VPN Gate · ${GTUI.fa(o.vg)} سرور — Psiphon هم هست`;
    if (o.vg) return `VPN Gate · ${GTUI.fa(o.vg)} سرور · TCP و UDP`;
    return 'Psiphon — فقط TCP';
}

// ── actions ──────────────────────────────────────────────────────────────────────

async function gtSetExit(country, provider) {
    gtState.busy = 'exit';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/exit', { method: 'POST', body: JSON.stringify({ country: country || '', provider: provider || '' }) });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshStatus();
}

async function gtSaveExitRules(rules) {
    gtState.busy = 'exit';
    gtRender();
    let ok = true;
    try {
        await gtFetch('/api/github-tunnel/exit/rules', { method: 'POST', body: JSON.stringify({ rules }) });
    } catch (e) { ok = false; gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshStatus();
    return ok;
}

async function gtAddExitRule() {
    const box = document.getElementById('gt-exit-rule-domains');
    const text = box ? box.value : (gtState.drafts['gt-exit-rule-domains'] || '');
    const domains = String(text).split(/[\s,،]+/).map((d) => d.trim()).filter(Boolean);
    const country = gtState.ui.ruleCc;
    if (!domains.length || !country) { gtToast('نام سایت‌ها و کشورشان را بنویسید.'); return; }
    const prefs = gtExitPrefs();
    const ok = await gtSaveExitRules([...(prefs.rules || []), { country, provider: '', domains }]);
    if (ok) {
        delete gtState.drafts['gt-exit-rule-domains'];
        gtState.ui.ruleCc = '';
        gtRender(true);
    }
}

function gtRemoveExitRule(i) {
    const prefs = gtExitPrefs();
    gtSaveExitRules((prefs.rules || []).filter((_, n) => n !== i));
}

async function gtCopyExitLink(id) {
    try {
        const r = await gtFetch('/api/github-tunnel/exit/link', { method: 'POST', body: JSON.stringify({ id }) });
        gtCopyText(r.link, 'لینک کپی شد — تا پایان همین نشست ابری کار می‌کند.');
    } catch (e) { gtToast(e.message); }
}

// ── the country picker ───────────────────────────────────────────────────────────
// This page's own control, not a <select>: an option cannot carry a flag, and the menu a select
// opens belongs to the operating system — on this page it looks like a piece of another program.
// Collapsed it is one row; open, a searchable list in the same shape as every other row. The same
// picker serves three places, each by its key: the front card, the section, and a new site rule.

/** What each picker was last drawn with, so typing in its search redraws only its rows. */
const gtCcCfg = {};

function gtCcRow(key, o, cfg) {
    const U = GTUI;
    const on = (o ? o.cc : '') === (cfg.value || '');
    const ready = o && cfg.ready && cfg.ready.has(o.cc);
    return `
        <button type="button" class="mv-eng-cc-row${on ? ' is-on' : ''}"${U.act('cc-pick', `${key}|${o ? o.cc : ''}`)}${cfg.disabled ? ' disabled' : ''} role="option" aria-selected="${on}">
          ${o ? U.flag(o.cc, 19) : '<span class="mv-flag is-none" style="width:19px;height:14px"></span>'}
          <span class="mv-eng-cc-text"><b>${U.esc(o ? o.name : cfg.autoTitle)}</b><small>${U.esc(o ? gtExitOfferLine(o) : cfg.autoSub)}</small></span>
          ${ready ? '<span class="fr-cc-res is-good">آماده روی سرور</span>' : ''}
          ${on ? '<i class="ph-fill ph-check-circle" aria-hidden="true"></i>' : ''}
        </button>`;
}

function gtCcRowsHtml(key) {
    const cfg = gtCcCfg[key];
    if (!cfg) return '';
    const q = String(gtState.ui.ccQuery[key] || '').trim().toLowerCase();
    const matches = cfg.options.filter((o) => !q || o.cc.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
    return (cfg.autoTitle && !q ? gtCcRow(key, null, cfg) : '')
        + matches.map((o) => gtCcRow(key, o, cfg)).join('')
        + (!matches.length && q ? '<div class="mv-eng-cc-empty">کشوری با این نام در فهرست سرور نیست.</div>' : '');
}

/**
 * cfg: { value, options, expanded, disabled, autoTitle, autoSub, curSub, ready:Set, label }.
 * `expanded` draws the list open with no collapsed row (the section); otherwise the collapsed row
 * opens and closes it (gtState.ui.cc[key]).
 */
function gtCcPicker(key, cfg) {
    const U = GTUI;
    gtCcCfg[key] = cfg;
    const open = cfg.expanded || !!gtState.ui.cc[key];
    const cur = cfg.options.find((o) => o.cc === cfg.value);
    return `<div class="gt-cc" data-gt-cc="${U.esc(key)}">
        ${cfg.expanded ? '' : `
        <button type="button" class="mv-eng-cc-cur"${U.act('cc-toggle', key)}${cfg.disabled ? ' disabled' : ''} aria-expanded="${open}"${cfg.label ? ` aria-label="${U.esc(cfg.label)}"` : ''}>
          ${cur ? U.flag(cur.cc, 19) : '<span class="mv-flag is-none" style="width:19px;height:14px"></span>'}
          <span class="mv-eng-cc-text"><b>${U.esc(cur ? cur.name : (cfg.autoTitle || 'یک کشور انتخاب کنید'))}</b>
            <small>${U.esc(cfg.curSub != null ? cfg.curSub : (cur ? gtExitOfferLine(cur) : (cfg.autoSub || '')))}</small></span>
          <i class="ph-bold ${open ? 'ph-caret-up' : 'ph-caret-down'}" aria-hidden="true"></i>
        </button>`}
        <div class="mv-eng-cc-list"${open ? '' : ' hidden'}>
          ${cfg.options.length > 7 ? `
          <label class="mv-eng-cc-search">
            <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
            <input type="search" placeholder="جست‌وجوی کشور…" spellcheck="false" value="${U.esc(gtState.ui.ccQuery[key] || '')}" data-gt-input="cc-search" data-arg="${U.esc(key)}" aria-label="جست‌وجوی کشور">
          </label>` : ''}
          <div class="mv-eng-cc-rows" role="listbox" data-gt-cc-rows="${U.esc(key)}">${gtCcRowsHtml(key)}</div>
        </div>
      </div>`;
}

/** Exits already up on the server, by country — the picker marks them «آماده». */
function gtExitReadySet() {
    const exits = Array.isArray(gtExitEngine().exits) ? gtExitEngine().exits : [];
    return new Set(exits.filter((x) => x.state === 'ready').map((x) => x.country));
}

/** The picker for the default exit, on the card (collapsed) or in the section (open). */
function gtExitPicker(key, expanded) {
    const prefs = gtExitPrefs();
    const eng = gtExitEngine();
    const seen = eng.connected && eng.exit ? eng.exit.country : '';
    const options = gtExitOptions(eng.catalog);
    const cur = options.find((o) => o.cc === prefs.country);
    const curSub = seen && seen !== prefs.country && prefs.country
        ? `هم‌اکنون از ${gtCountryFa(seen)}`
        : cur ? `${prefs.provider ? GT_PROVIDER_FA[prefs.provider] : 'خودکار'} — ${gtExitOfferLine(cur)}` : null;
    return gtCcPicker(key, {
        value: prefs.country, options, expanded, disabled: !!gtState.busy,
        autoTitle: 'حداکثر سرعت', autoSub: 'آدرس خود سرور ابری — بدون واسطه',
        curSub, ready: gtExitReadySet(), label: 'کشور خروجی',
    });
}

// ── what is happening now ────────────────────────────────────────────────────────

/** The job's state as a callout — while it works, and when part of it did not come up. */
function gtExitJobRow() {
    const U = GTUI;
    const job = gtExitJob();
    const prefs = gtExitPrefs();
    if (job.phase === 'preparing' || job.phase === 'switching') {
        return U.callout({ spin: true, text: job.phase === 'switching'
            ? 'در حال جابه‌جایی روی خروجی تازه…'
            : `سرور ابری در حال آماده کردن ${U.esc(gtCountryFa(job.country || prefs.country))} است — تا آماده شود، ترافیک از آدرس خود سرور می‌رود.` });
    }
    if (job.phase === 'partial' || job.phase === 'failed') {
        return U.callout({ tone: 'warn', title: 'خروجی آماده نشد', text: `${U.esc(job.error || '—')} — ترافیکش از آدرس خود سرور ابری می‌رود.` });
    }
    return '';
}

/** «آدرسی که سایت‌ها می‌بینند»: the exit the far end reported, with its flag and address. */
function gtExitSeen() {
    const U = GTUI;
    const eng = gtExitEngine();
    const seen = eng.connected && eng.exit;
    if (!seen) return '';
    return `<div class="gt-exit-now">
        ${U.flag(seen.country, 24)}
        <span class="gt-exit-now-text"><b>${U.esc(gtCountryFa(seen.country || ''))}${seen.city ? ` — ${U.esc(seen.city)}` : ''}</b><small>${U.esc(seen.ip || '')}</small></span>
        <span class="gt-exit-now-k">آدرسی که سایت‌ها می‌بینند</span>
      </div>`;
}

// ── the card ─────────────────────────────────────────────────────────────────────

function gtExitCard() {
    const U = GTUI;
    const prefs = gtExitPrefs();
    const job = gtExitJob();
    const eng = gtExitEngine();
    const connected = !!eng.connected;
    const working = job.phase === 'preparing' || job.phase === 'switching';
    const rules = prefs.rules || [];
    const plan = eng.exitPlan || { use: 'direct', rules: [] };
    const end = working ? U.pill('در حال آماده‌سازی…', 'warn')
        : prefs.country ? `${U.flag(prefs.country, 16)}<span>${U.esc(gtCountryFa(prefs.country))}</span>`
            : '<span>حداکثر سرعت</span>';
    return U.card({
        id: 'gt-exit-card', tint: 'var(--mv-teal)', icon: 'ph-fill ph-globe-hemisphere-east', title: 'کشور خروجی', go: 'exit', end,
        body: gtExitPicker('home', false)
            + (gtExitJobRow() ? `<div class="mv-form-group">${gtExitJobRow()}</div>` : '')
            + gtExitSeen()
            + U.rows([
                U.actionRow({ go: 'exit', icon: 'ph-fill ph-signpost', tint: 'var(--mv-indigo)', title: 'این سایت‌ها از کشور دیگر',
                    value: rules.length ? `${U.fa(rules.length)} قانون` : 'هیچ' }),
                connected ? U.actionRow({ act: 'exit-link', arg: plan.use || 'direct', icon: 'ph-fill ph-device-mobile', tint: 'var(--mv-green)',
                    title: 'لینک همین خروجی برای گوشی', value: 'کپی' }) : '',
            ]),
        foot: 'کشور روی خود سرور ابری انتخاب می‌شود؛ روی کامپیوتر شما همیشه فقط یک تونل هست. تمدید بی‌وقفه، کشور را پیش از جابه‌جایی روی نشست تازه آماده می‌کند.',
    });
}

// ── the section ──────────────────────────────────────────────────────────────────

function gtRenderExit() {
    const U = GTUI;
    if (!gtSessionV2(gtState.status && gtState.status.session) && !gtNewSessionsV2()) {
        return U.form([U.section({ rows: [U.empty({ icon: 'ph-fill ph-globe-hemisphere-east', title: 'کشور خروجی با تونل جدید کار می‌کند',
            text: 'این انتخاب روی خود سرور ابری انجام می‌شود و فقط نشست‌های تونل جدید (از مسیر Worker شما) آن را دارند.' })] })]);
    }
    const prefs = gtExitPrefs();
    const eng = gtExitEngine();
    const connected = !!eng.connected;
    const busy = !!gtState.busy;
    const options = gtExitOptions(eng.catalog);
    const cur = options.find((o) => o.cc === prefs.country);
    const exits = Array.isArray(eng.exits) ? eng.exits : [];
    const rules = prefs.rules || [];
    const plan = eng.exitPlan || { use: 'direct', rules: [] };

    // Which exits the tunnel is on right now: the default, and the ones a site rule names.
    const inUse = new Set([plan.use, ...((plan.rules || []).map((r) => r.id))].filter((id) => id && id !== 'direct'));
    const exitRow = (x) => {
        const using = x.state === 'ready' && inUse.has(x.id);
        const tone = x.state === 'ready' ? 'ok' : x.state === 'failed' ? 'bad' : 'warn';
        const word = using ? (x.id === plan.use ? 'پیش‌فرض' : 'قانون سایت‌ها') : x.state === 'ready' ? 'آماده' : x.state === 'failed' ? 'ناموفق' : 'در حال آماده‌سازی';
        const facts = [GT_PROVIDER_FA[x.provider] || x.provider, x.provider === 'psiphon' ? 'فقط TCP' : 'TCP و UDP',
            x.mbps ? `${U.fa(x.mbps)} مگابیت روی سرور` : '', x.rttMs ? `${U.fa(x.rttMs)} میلی‌ثانیه` : ''].filter(Boolean).join(' · ');
        return `<div class="mv-li${using ? ' is-on' : ''}">
            <span class="mv-li-lead">${U.flag(x.country, 22)}</span>
            <span class="mv-li-text"><b>${U.esc(gtCountryFa(x.country))}${x.city ? ` — ${U.esc(x.city)}` : ''}</b><small>${U.esc(facts)}</small>
              ${x.state === 'failed' && x.error ? `<small class="gt-acc-note" dir="ltr">${U.esc(x.error)}</small>` : ''}</span>
            <span class="mv-li-end">${U.pill(word, tone, x.state !== 'failed')}</span>
          </div>`;
    };

    const ruleRow = (r, i) => `<div class="mv-li">
          <span class="mv-li-lead">${U.flag(r.country, 22)}</span>
          <span class="mv-li-text"><b>${U.esc(gtCountryFa(r.country))}${r.provider ? ` · ${U.esc(GT_PROVIDER_FA[r.provider] || r.provider)}` : ''}</b>
            <small class="gt-rule-domains">${U.esc(r.domains.join(', '))}</small></span>
          <span class="mv-li-end">${U.button({ icon: 'ph-bold ph-trash', title: 'برداشتن این قانون', act: 'exit-rule-remove', arg: i, size: 'sm', kind: 'danger', disabled: busy })}</span>
        </div>`;

    return U.form([
        U.section({
            header: 'کشور پیش‌فرض',
            rows: [gtExitJobRow(), U.stack(gtExitPicker('sec', true))],
            footer: 'هر کشور از فهرست خود سرور ابری است. «حداکثر سرعت» یعنی بدون واسطه، از آدرس خود سرور — سریع‌ترین حالت.',
        }),
        U.section({
            header: 'ارائه‌دهنده',
            rows: [
                U.row({ title: 'از کدام راه به آن کشور برسد',
                    sub: cur ? gtExitOfferLine(cur) : 'اول یک کشور انتخاب کنید',
                    end: U.seg({ act: 'exit-provider', value: prefs.provider || '', disabled: busy || !prefs.country, label: 'ارائه‌دهنده', items: [
                        { value: '', text: 'خودکار' },
                        { value: 'vpngate', text: 'VPN Gate', disabled: !cur || !cur.vg },
                        { value: 'psiphon', text: 'Psiphon', disabled: !cur || !cur.psiphon },
                    ] }) }),
            ],
            footer: '«خودکار» اول VPN Gate را امتحان می‌کند — TCP و UDP، و بین چند سرور سریع‌ترین را نگه می‌دارد — و اگر نشد، Psiphon (فقط TCP؛ UDP از آدرس خود سرور می‌رود).',
        }),
        U.section({
            header: 'وضعیت روی سرور',
            rows: [
                connected && eng.exit ? U.valueRow({ icon: 'ph-fill ph-eye', tint: 'var(--mv-teal)', title: 'آدرسی که سایت‌ها می‌بینند',
                    sub: `${U.flag(eng.exit.country, 16)} ${U.esc(gtCountryFa(eng.exit.country || ''))}${eng.exit.city ? ` — ${U.esc(eng.exit.city)}` : ''}`,
                    value: eng.exit.ip || '', ltr: true, copy: eng.exit.ip || '' }) : '',
                exits.length ? `<div class="mv-list">${exits.map(exitRow).join('')}</div>`
                    : U.empty({ icon: 'ph-fill ph-hard-drives', title: connected ? 'هنوز خروجی‌ای روی سرور بالا نیامده' : 'تونل وصل نیست',
                        text: connected ? 'با انتخاب یک کشور، سرور ابری آن را آماده می‌کند.' : 'خروجی‌ها روی نشست در حال اجرا ساخته می‌شوند.' }),
            ],
            footer: 'هر نشست تازه، کشور را از نو روی سرورش آماده می‌کند — تمدید بی‌وقفه این کار را پیش از جابه‌جایی انجام می‌دهد.',
        }),
        U.section({
            header: 'این سایت‌ها از کشور دیگر',
            rows: [
                rules.length ? `<div class="mv-list">${rules.map(ruleRow).join('')}</div>` : '',
                rules.length < GT_EXIT_MAX_RULES
                    ? U.stack(`<div class="gt-rule-add">
                        ${U.field({ id: 'gt-exit-rule-domains', rows: 2, ltr: true, placeholder: 'mexc.com, binance.com', label: 'نام سایت‌ها' })}
                        ${gtCcPicker('rule', { value: gtState.ui.ruleCc, options: gtExitOptions(eng.catalog), disabled: busy,
                            autoTitle: '', curSub: gtState.ui.ruleCc ? null : 'کشوری که این سایت‌ها از آن باز شوند', label: 'کشور این سایت‌ها' })}
                        ${U.actions([U.button({ text: 'افزودن قانون', icon: 'ph-bold ph-plus', act: 'exit-rule-add', kind: 'primary', size: 'sm', disabled: busy })])}
                      </div>`)
                    : U.callout({ text: `حداکثر ${U.fa(GT_EXIT_MAX_RULES)} قانون — برای قانون تازه، یکی را بردارید.` }),
            ],
            footer: 'مثلاً صرافی‌ای که آمریکا را محدود کرده از ژاپن، و بقیه با حداکثر سرعت. زیردامنه‌ها هم شامل می‌شوند.',
        }),
        U.section({
            header: 'روی گوشی',
            rows: [
                U.row({ icon: 'ph-fill ph-device-mobile', tint: 'var(--mv-green)', title: 'لینک همین خروجی',
                    sub: connected ? 'یک لینک vless برای برنامهٔ گوشی خودتان، از همین نشست و همین کشور.' : 'اول تونل را وصل کنید — لینک از نشست در حال اجرا ساخته می‌شود.',
                    end: U.button({ text: 'کپی لینک', icon: 'ph-bold ph-copy', act: 'exit-link', arg: plan.use || 'direct', size: 'sm', disabled: !connected }) }),
            ],
            footer: 'لینک تا پایان همین نشست ابری کار می‌کند؛ با نشست تازه، لینک تازه بگیرید.',
        }),
    ]);
}

GTUI.on({
    act: {
        'cc-toggle': (key) => {
            gtState.ui.cc[key] = !gtState.ui.cc[key];
            if (!gtState.ui.cc[key]) gtState.ui.ccQuery[key] = '';
            gtRender(true);
            // Opened: straight into the search, so typing a name is the next thing that works.
            if (gtState.ui.cc[key]) {
                const box = document.querySelector(`#gt-wrapper [data-gt-cc="${key}"] input[data-gt-input="cc-search"]`);
                if (box) box.focus();
            }
        },
        'cc-pick': (arg) => {
            const [key, cc] = String(arg).split('|');
            gtState.ui.cc[key] = false;
            gtState.ui.ccQuery[key] = '';
            if (key === 'rule') { gtState.ui.ruleCc = cc; gtRender(true); return; }
            const prefs = gtExitPrefs();
            // A new country starts on «خودکار»; the same country keeps the provider chosen for it.
            gtSetExit(cc, cc && cc === prefs.country ? prefs.provider : '');
        },
        'exit-provider': (provider) => {
            const prefs = gtExitPrefs();
            if (prefs.country) gtSetExit(prefs.country, provider || '');
        },
        'exit-rule-add': () => gtAddExitRule(),
        'exit-rule-remove': (i) => gtRemoveExitRule(Number(i)),
        'exit-link': (id) => gtCopyExitLink(id || 'direct'),
    },
    input: {
        'cc-search': (value, el) => {
            const key = el.getAttribute('data-arg');
            gtState.ui.ccQuery[key] = value;
            const host = document.querySelector(`#gt-wrapper [data-gt-cc-rows="${key}"]`);
            if (host) host.innerHTML = gtCcRowsHtml(key);
        },
    },
});
