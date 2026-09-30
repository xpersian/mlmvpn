// --- «اوپن‌وی‌پی‌ان» › TunnelBear، پروفایل‌های من، حساب‌ها ---
//
// The page half of openvpn-profiles.js (see its header for the import rules), mounted into the
// OpenVPN window by components/openvpn.js. Redesigned 2026-10-01 with the rest of that window
// («حساب‌ها و پروفایل‌ها خیلی UI بدی داره و اصلا هماهنگ نیست»):
//
//   • «TunnelBear» — the 47 countries as a list you CHOOSE from, like every other list in the
//     app: a row is chosen (accent), the live one is green, and the window's one connect button
//     connects. No more forty-seven blue «اتصال» buttons. The account it signs in with is the
//     strip at the top; without one, a notice that says so and adds one.
//   • «پروفایل‌های من» — the user's own .ovpn files: add (the button, or drop the files on the
//     page — several at once, with their certificates), search, star, measure, choose, delete.
//   • «حساب‌ها» — the TunnelBear accounts: which one is used, auto-switch, and add / edit in a
//     SHEET over the window. The 4-second status poll repaints the page under it; the sheet is
//     outside that repaint, so nothing typed into it can be wiped.
//
// openvpn.js calls OvProfiles.attach(bridge) once and OvProfiles.render(sec, host, bridge, live)
// on every repaint of those three sections.
(function () {
    'use strict';

    const st = {
        loaded: false, loading: false,
        profiles: [], accounts: { list: [], activeId: null, autoSwitch: true },
        connectedId: null,
        query: { tunnelbear: '', profiles: '' },
        banner: null,          // the import result on «پروفایل‌های من»: { tone, html }
        accBanner: null,       // a result on «حساب‌ها»
        measuring: '',         // '' | 'tunnelbear' | 'profiles'
        sheet: null,           // the account sheet: { id, user, pass, error, show, saving }
    };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    let bridge = null;     // { say, go, sheetHost, target, choose, connectFastest, busy, changed, loaded }
    let hostEl = null;
    let sec = '';
    let sig = '';

    /** The same SVG flag the rest of the window draws (Windows has no emoji flags). */
    function flag(code, w) {
        const width = w || 22;
        const h = Math.round(width * 0.72);
        if (!code) return `<span class="mv-flag is-none" style="width:${width}px;height:${h}px"></span>`;
        return `<span class="mv-flag" style="width:${width}px;height:${h}px">${esc(String(code).toUpperCase())}`
            + `<img src="/assets/flags/${esc(String(code).toLowerCase())}.svg" alt="" onerror="this.remove()"></span>`;
    }

    async function load() {
        if (st.loading) return;
        st.loading = true;
        try {
            const r = await fetch('/api/openvpn/profiles');
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'خطا');
            st.profiles = d.profiles || [];
            st.accounts = d.accounts || st.accounts;
            st.connectedId = d.connectedId || null;
            st.loaded = true;
        } catch (e) { st.banner = { tone: 'err', html: 'فهرست پروفایل‌ها خوانده نشد: ' + esc(e.message) }; }
        st.loading = false;
        paint(true);
        if (bridge && bridge.loaded) bridge.loaded();
    }

    // ── words ──────────────────────────────────────────────────────────────

    /** The measured delay as a pill, or what is known instead. */
    function delayPill(p) {
        const pr = p.probe;
        if (!pr) return '<span class="ov-pill">سنجیده نشده</span>';
        if (pr.millis) {
            // From Iran, Europe is 240–320 ms on a good line; a 250 ms bar painted almost every
            // TunnelBear country yellow, which says «mediocre» about the best a user can get.
            const tone = pr.millis <= 350 ? 'ok' : pr.millis <= 700 ? 'mid' : 'slow';
            return `<span class="ov-pill is-${tone} ov-num" dir="ltr">${fa(pr.millis)} ms</span>`;
        }
        if (pr.error === 'UNSUPPORTED_CONTROL_AUTH') return '<span class="ov-pill" title="پروفایل UDP با tls-auth را نمی‌شود بدون اتصال سنجید">سنجش‌پذیر نیست</span>';
        return '<span class="ov-pill is-bad">جواب نداد</span>';
    }

    /** The same fact in words, for «مقصد اتصال» on the home page. */
    function delayWords(p) {
        const pr = p && p.probe;
        if (!pr) return 'تأخیر هنوز سنجیده نشده';
        if (pr.millis) return `تأخیر <span class="ov-num">${fa(pr.millis)}ms</span>`;
        if (pr.error === 'UNSUPPORTED_CONTROL_AUTH') return 'بدون اتصال سنجش‌پذیر نیست';
        return 'به سنجش جواب نداد';
    }

    function authPill(a) {
        return a.auth === 'accepted' ? '<span class="ov-pill is-ok">پذیرفته شد</span>'
            : a.auth === 'failed' ? `<span class="ov-pill is-bad" title="${esc(a.lastError || '')}">رد شد</span>`
                : '<span class="ov-pill">هنوز آزموده نشده</span>';
    }

    function when(ts) {
        try { return new Date(ts).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; }
    }

    const target = () => (bridge && bridge.target && bridge.target()) || { kind: 'gate', id: null };
    const isChosen = (kind, id) => { const t = target(); return t.kind === kind && t.id === id; };
    const busy = () => !!(bridge && bridge.busy && bridge.busy());

    function rowsOf(kind) {
        const q = (st.query[kind === 'bear' ? 'tunnelbear' : 'profiles'] || '').trim().toLowerCase();
        const rows = st.profiles.filter((p) => (kind === 'bear' ? p.tunnelbear : !p.tunnelbear))
            .filter((p) => !q || (p.name + ' ' + ((p.place && p.place.name) || '') + ' ' + ((p.remotes[0] || {}).host || '')).toLowerCase().includes(q));
        const score = (p) => (p.probe && p.probe.millis ? p.probe.millis : 1e9);
        return rows.sort((a, b) => (b.favorite - a.favorite) || (score(a) - score(b))
            || String((a.place && a.place.name) || a.name).localeCompare(String((b.place && b.place.name) || b.name), 'fa'));
    }

    // ── «TunnelBear» ───────────────────────────────────────────────────────

    function accountStrip() {
        const A = st.accounts;
        const active = A.list.find((a) => a.id === A.activeId) || A.list[0] || null;
        if (!active) {
            return `
    <div class="mv-form-group ovp-strip">
      <div class="mv-form-row mv-callout is-warn">
        <i class="ph-fill ph-warning-circle"></i>
        <span class="ovp-strip-text">سرورهای TunnelBear فقط با <b>حساب TunnelBear خودتان</b> وصل می‌شوند (ساخت حساب در سایت tunnelbear.com). بدون حساب می‌توانید فهرست را ببینید و تأخیر را بسنجید، ولی اتصال نمی‌گیرد.</span>
        <button type="button" class="mv-btn mv-btn--primary mv-btn--sm" data-ovp="acc-add"><i class="ph-bold ph-plus"></i>افزودن حساب</button>
      </div>
    </div>`;
        }
        return `
    <div class="mv-form-group ovp-strip">
      <div class="mv-status-head">
        <span class="mv-side-tile" style="--tint:var(--mv-orange)"><i class="ph-fill ph-paw-print"></i></span>
        <div class="mv-sh-text">
          <h2><bdi dir="ltr">${esc(active.username)}</bdi></h2>
          <p>${authPill(active)} ${A.list.length > 1 ? `· ${fa(A.list.length)} حساب${A.autoSwitch ? '، با تعویض خودکار' : ''}` : '· حساب TunnelBear'}</p>
        </div>
        <div class="mv-sh-end"><button type="button" class="mv-btn mv-btn--sm" data-ovp="go-accounts">مدیریت حساب‌ها</button></div>
      </div>
    </div>`;
    }

    function renderTunnelBear() {
        const all = st.profiles.filter((p) => p.tunnelbear);
        const measured = all.filter((p) => p.probe && p.probe.millis).length;
        return `
<div class="ovp-page">
  ${accountStrip()}
  <div class="ov-toolbar">
    <div class="ov-bar1">
      <label class="mv-search">
        <i class="ph ph-magnifying-glass"></i>
        <input type="search" class="mv-field" id="ovp-q-tunnelbear" data-ovp-q="tunnelbear" placeholder="جست‌وجوی کشور" spellcheck="false" value="${esc(st.query.tunnelbear)}">
      </label>
      <div class="ov-tb">
        <button type="button" data-ovp="measure" data-kind="tunnelbear" ${st.measuring ? 'disabled' : ''} title="تا ۶ سرور هر کشور را با هم می‌سنجد">
          <i class="${st.measuring === 'tunnelbear' ? 'mv-spin-ring' : 'ph-bold ph-gauge'}"></i>${st.measuring === 'tunnelbear' ? 'در حال سنجش…' : 'سنجش تأخیر همه'}</button>
        <button type="button" data-ovp="fastest" class="is-go" ${busy() || !st.accounts.list.length ? 'disabled' : ''}
                title="${st.accounts.list.length ? 'اتصال به کم‌تأخیرترین سروری که در ده دقیقهٔ گذشته سنجیده شده' : 'اول یک حساب TunnelBear اضافه کنید'}">
          <i class="ph-bold ph-lightning"></i>اتصال به سریع‌ترین</button>
      </div>
    </div>
    <div class="ov-summary">${fa(all.length)} کشور · ${measured ? fa(measured) + ' کشور سنجیده شده' : 'هنوز سنجیده نشده'} · علاقه‌مندی‌ها بالا، بعد کم‌تأخیرترها</div>
  </div>
  <div class="mv-form-group"><div class="ovp-grid" id="ovp-list-tunnelbear" role="listbox" aria-label="کشورهای TunnelBear"></div></div>
  <div class="mv-form-footer">روی یک کشور بزنید تا مقصد اتصال شود (دوبار زدن: اتصال). سرورهای TunnelBear از ایران روی UDP بسته‌اند؛ برنامه آن‌ها را از راه TCP 7011 و یک رلهٔ محلی وصل می‌کند که شکل بسته‌های اول را برای فیلتر ناخوانا می‌کند. هر کشور حدود ۲۰ سرور دارد؛ «سنجش تأخیر» تا ۶ سرور هر کشور را با هم می‌سنجد و سالم‌ها به ترتیب سرعت امتحان می‌شوند.</div>
</div>`;
    }

    function starBtn(p) {
        return `<button type="button" class="ovp-star${p.favorite ? ' is-on' : ''}" data-ovp="star" data-id="${esc(p.id)}"
                  aria-pressed="${!!p.favorite}" title="${p.favorite ? 'برداشتن از علاقه‌مندی‌ها' : 'افزودن به علاقه‌مندی‌ها'}"><i class="ph-${p.favorite ? 'fill' : 'bold'} ph-star"></i></button>`;
    }

    function bearRows() {
        const rows = rowsOf('bear');
        if (!rows.length) {
            return st.loaded ? `<div class="mv-empty"><i class="ph ph-magnifying-glass mv-empty-ic"></i><b>کشوری پیدا نشد</b><p>جست‌وجو را پاک کنید.</p></div>`
                : '<div class="mv-empty"><i class="mv-spin-ring mv-empty-ic"></i><p>در حال خواندن…</p></div>';
        }
        return rows.map((p) => {
            const live = st.connectedId === p.id;
            const sel = isChosen('bear', p.id);
            return `
      <div class="mv-li ovp-li${live ? ' is-on' : sel ? ' is-sel' : ''}" role="option" tabindex="0" aria-selected="${sel}" data-ovp-pick="bear" data-id="${esc(p.id)}">
        <span class="mv-li-lead">${flag(p.place && p.place.code, 24)}</span>
        <span class="mv-li-text"><b>${esc((p.place && p.place.name) || p.name)}</b>${live ? '<small class="is-live">همین حالا وصل است</small>' : sel ? '<small>مقصد اتصال</small>' : ''}</span>
        <span class="ovp-num">${delayPill(p)}</span>
        ${starBtn(p)}
      </div>`;
        }).join('');
    }

    // ── «پروفایل‌های من» ───────────────────────────────────────────────────

    function bannerHtml(b) {
        if (!b) return '';
        const icon = b.tone === 'ok' ? 'ph-check-circle' : b.tone === 'warn' ? 'ph-warning-circle' : 'ph-x-circle';
        return `
    <div class="mv-form-group ovp-strip">
      <div class="mv-form-row mv-callout${b.tone === 'err' ? ' is-danger' : b.tone === 'warn' ? ' is-warn' : ' is-ok'}">
        <i class="ph-fill ${icon}"></i>
        <span class="ovp-strip-text">${b.html}</span>
        <button type="button" class="mv-btn mv-btn--icon mv-btn--sm" data-ovp="banner-x" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
      </div>
    </div>`;
    }

    // Only .ovpn files are profiles (openvpn-profiles.js › importFiles); everything else picked with
    // them is a companion — a certificate or key the profile names.
    const fileInput = () => '<input type="file" data-ovp-file multiple accept=".ovpn,.txt,.crt,.pem,.key,.cer">';

    function renderOwn() {
        const mine = st.profiles.filter((p) => !p.tunnelbear);
        return `
<div class="ovp-page" data-ovp-drop>
  ${bannerHtml(st.banner)}
  <div class="ov-toolbar">
    <div class="ov-bar1">
      <label class="mv-search">
        <i class="ph ph-magnifying-glass"></i>
        <input type="search" class="mv-field" id="ovp-q-profiles" data-ovp-q="profiles" placeholder="جست‌وجوی نام یا سرور" spellcheck="false" value="${esc(st.query.profiles)}">
      </label>
      <div class="ov-tb">
        <label class="is-go" title="یک یا چند فایل .ovpn، همراه با گواهی و کلیدشان"><i class="ph-bold ph-plus"></i>افزودن پروفایل${fileInput()}</label>
        <button type="button" data-ovp="measure" data-kind="profiles" ${st.measuring || !mine.length ? 'disabled' : ''}>
          <i class="${st.measuring === 'profiles' ? 'mv-spin-ring' : 'ph-bold ph-gauge'}"></i>${st.measuring === 'profiles' ? 'در حال سنجش…' : 'سنجش تأخیر'}</button>
      </div>
    </div>
    ${mine.length ? `<div class="ov-summary">${fa(mine.length)} پروفایل · علاقه‌مندی‌ها بالا، بعد کم‌تأخیرترها · فایل‌ها را روی همین صفحه رها کنید تا اضافه شوند</div>` : ''}
  </div>
  <div class="mv-form-group ovp-dropzone" id="ovp-list-profiles"></div>
  <div class="mv-form-footer">می‌توانید چند پروفایل را هم‌زمان با فایل‌های همراهشان (گواهی CA، کلید و…) انتخاب کنید؛ فایل‌های همراه با <b>نام فایل</b> پیدا می‌شوند و برای پروفایل‌های بعدی هم نگه داشته می‌شوند. برای امنیت فقط دستورهای شناخته‌شدهٔ OpenVPN پذیرفته می‌شوند — هیچ اسکریپتی اجرا نمی‌شود.</div>
</div>`;
    }

    function ownRows() {
        const all = st.profiles.filter((p) => !p.tunnelbear);
        if (!all.length) {
            return st.loaded ? `
      <div class="mv-empty ovp-empty">
        <i class="ph ph-file-arrow-down mv-empty-ic"></i>
        <b>هنوز پروفایلی اضافه نکرده‌اید</b>
        <p>فایل .ovpn را روی همین‌جا رها کنید، یا دکمهٔ زیر را بزنید. گواهی و کلید همراهش را هم با آن انتخاب کنید.</p>
        <label class="mv-btn mv-btn--primary ovp-filebtn"><i class="ph-bold ph-plus"></i>افزودن پروفایل…${fileInput()}</label>
      </div>` : '<div class="mv-empty"><i class="mv-spin-ring mv-empty-ic"></i><p>در حال خواندن…</p></div>';
        }
        const rows = rowsOf('own');
        if (!rows.length) return `<div class="mv-empty"><i class="ph ph-magnifying-glass mv-empty-ic"></i><b>چیزی پیدا نشد</b><p>جست‌وجو را پاک کنید.</p></div>`;
        return '<div class="mv-list" role="listbox" aria-label="پروفایل‌های من">' + rows.map((p) => {
            const live = st.connectedId === p.id;
            const sel = isChosen('own', p.id);
            const r = p.remotes[0] || {};
            const where = `${r.host || ''}${r.port ? ':' + r.port : ''}${r.protocol ? ' · ' + String(r.protocol).replace(/-client$/, '').toUpperCase() : ''}`;
            const title = (p.place && p.place.code && p.place.name && p.place.name !== p.name) ? p.place.name : p.name;
            return `
      <div class="mv-li ovp-li${live ? ' is-on' : sel ? ' is-sel' : ''}" role="option" tabindex="0" aria-selected="${sel}" data-ovp-pick="own" data-id="${esc(p.id)}">
        <span class="mv-li-lead">${p.place && p.place.code ? flag(p.place.code, 24) : '<span class="ovp-file-ic"><i class="ph-fill ph-file-text"></i></span>'}</span>
        <span class="mv-li-text"><b>${esc(title)}${title !== p.name ? ` <span class="ovp-sub-name">${esc(p.name)}</span>` : ''}</b>
          <small${live ? ' class="is-live"' : ''}>${live ? 'همین حالا وصل است' : `<bdi dir="ltr">${esc(where)}</bdi>${sel ? ' · مقصد اتصال' : ''}`}</small></span>
        <span class="ovp-num">${delayPill(p)}</span>
        ${starBtn(p)}
        <button type="button" class="mv-btn mv-btn--icon mv-btn--sm" data-ovp="delete" data-id="${esc(p.id)}" title="${live ? 'پروفایلی که با آن وصل هستید حذف نمی‌شود' : 'حذف این پروفایل'}" aria-label="حذف" ${live ? 'disabled' : ''}><i class="ph-bold ph-trash"></i></button>
      </div>`;
        }).join('') + '</div>';
    }

    // ── «حساب‌ها» ──────────────────────────────────────────────────────────

    function renderAccounts() {
        const A = st.accounts;
        return `
<div class="mv-form">
  <div class="mv-form-section">
    <div class="mv-form-header">حساب‌های TunnelBear</div>
    ${bannerHtml(st.accBanner)}
    <div class="mv-form-group">
      ${A.list.length ? `<div class="mv-list" role="radiogroup" aria-label="حسابی که با آن وصل می‌شود">${A.list.map((a) => {
            const on = A.activeId === a.id;
            return `
        <div class="mv-li ovp-acc${on ? ' is-sel' : ''}" role="radio" tabindex="0" aria-checked="${on}" data-ovp-active="${esc(a.id)}">
          <span class="mv-li-lead"><span class="ov-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span></span>
          <span class="mv-li-text"><b><bdi dir="ltr">${esc(a.username)}</bdi></b>
            <small>${a.lastConnected ? 'آخرین اتصال ' + esc(when(a.lastConnected)) : on ? 'حسابی که با آن وصل می‌شود' : 'روی ردیف بزنید تا این حساب استفاده شود'}${a.auth === 'failed' && a.lastError ? ' · ' + esc(a.lastError) : ''}</small></span>
          ${authPill(a)}
          <button type="button" class="mv-btn mv-btn--sm" data-ovp="edit" data-id="${esc(a.id)}">ویرایش</button>
          <button type="button" class="mv-btn mv-btn--icon mv-btn--sm" data-ovp="acc-delete" data-id="${esc(a.id)}" title="حذف این حساب" aria-label="حذف"><i class="ph-bold ph-trash"></i></button>
        </div>`;
        }).join('')}</div>` : `
      <div class="mv-empty"><i class="ph ph-user-circle-plus mv-empty-ic"></i><b>هنوز حسابی ندارید</b><p>حساب TunnelBear خودتان را اضافه کنید تا سرورهای TunnelBear وصل شوند.</p></div>`}
      <button type="button" class="mv-form-row is-action ovp-add" data-ovp="acc-add">
        <span class="mv-row-mark"><i class="ph-fill ph-plus-circle"></i></span>
        <span class="mv-form-label">افزودن حساب…</span>
      </button>
    </div>
    <div class="mv-form-footer">حساب انتخاب‌شده (آبی) همان است که اتصال‌های TunnelBear با آن انجام می‌شود. حسابی که همین حالا با آن وصل هستید حذف یا ویرایش نمی‌شود.</div>
  </div>

  <div class="mv-form-section">
    <div class="mv-form-header">رفتار</div>
    <div class="mv-form-group">
      <div class="mv-form-row">
        <span class="mv-form-label">تعویض خودکار<small>اگر سرور حساب انتخاب‌شده را نپذیرفت، اتصال بعدی با حساب بعدی انجام می‌شود</small></span>
        <span class="mv-form-control"><button type="button" class="mv-switch" role="switch" aria-checked="${!!A.autoSwitch}" aria-label="تعویض خودکار" data-ovp-switch="auto"></button></span>
      </div>
    </div>
    <div class="mv-form-header ovp-gap">رمزها کجا می‌مانند</div>
    <div class="mv-form-group">
      <div class="mv-form-row is-stack"><span class="mv-form-label">فقط روی همین کامپیوتر<small>رمز جدا از فهرست حساب‌ها و رمزگذاری‌شده با کلید ویندوزِ همین کاربر نگه داشته می‌شود و در هیچ فایل یا گزارشی نوشته نمی‌شود. TunnelBear راهی عمومی برای خواندن حجم باقی‌مانده ندارد؛ برای همین فقط آخرین وضعیت ورود با زمانش نشان داده می‌شود.</small></span></div>
    </div>
  </div>
</div>`;
    }

    // ── the account sheet ──────────────────────────────────────────────────

    function openSheet(acc) {
        st.sheet = { id: acc ? acc.id : null, user: acc ? acc.username : '', pass: '', error: '', show: false, saving: false };
        drawSheet();
        const f = document.getElementById(acc ? 'ovp-pass' : 'ovp-user');
        if (f) setTimeout(() => f.focus(), 30);
    }

    function closeSheet() {
        st.sheet = null;
        const host = bridge && bridge.sheetHost && bridge.sheetHost();
        if (host) host.innerHTML = '';
    }

    function drawSheet() {
        const host = bridge && bridge.sheetHost && bridge.sheetHost();
        const s = st.sheet;
        if (!host || !s) return;
        const edit = !!s.id;
        host.innerHTML = `
  <div class="ov-scrim" data-ovp-scrim>
    <div class="mv-sheet" role="dialog" aria-modal="true" aria-labelledby="ovp-sheet-title">
      <div class="mv-sheet-bar">
        <h3 id="ovp-sheet-title">${edit ? 'ویرایش حساب TunnelBear' : 'افزودن حساب TunnelBear'}</h3>
        <button type="button" class="mv-sheet-close" data-ovp-sheet="close" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
      </div>
      <div class="mv-sheet-body">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="ovp-sheet-ic"><span class="mv-side-tile" style="--tint:var(--mv-orange)"><i class="ph-fill ph-paw-print"></i></span></div>
            <div class="mv-form-group">
              <div class="mv-form-row">
                <label class="mv-form-label" for="ovp-user">ایمیل حساب</label>
                <span class="mv-form-control"><input type="text" class="mv-field mv-field--tech ovp-field" id="ovp-user" dir="ltr" maxlength="320"
                  autocomplete="off" spellcheck="false" placeholder="name@example.com" value="${esc(s.user)}"></span>
              </div>
              <div class="mv-form-row">
                <label class="mv-form-label" for="ovp-pass">رمز</label>
                <span class="mv-form-control ovp-pass">
                  <input type="${s.show ? 'text' : 'password'}" class="mv-field mv-field--tech ovp-field" id="ovp-pass" dir="ltr" maxlength="4096"
                    autocomplete="new-password" placeholder="${edit ? 'رمز تازه' : ''}" value="${esc(s.pass)}">
                  <button type="button" class="mv-btn mv-btn--icon mv-btn--sm" data-ovp-sheet="peek" aria-pressed="${s.show}" title="${s.show ? 'پنهان کردن رمز' : 'نمایش رمز'}"><i class="ph-bold ${s.show ? 'ph-eye-slash' : 'ph-eye'}"></i></button>
                </span>
              </div>
            </div>
            <div id="ovp-sheet-err">${s.error ? sheetError(s.error) : ''}</div>
            <div class="mv-form-footer">${edit ? 'برای ویرایش، رمز را دوباره وارد کنید؛ رمز قبلی هرگز به این صفحه برنمی‌گردد.' : 'حساب TunnelBear خودتان (سایت tunnelbear.com). رمز رمزگذاری‌شده روی همین کامپیوتر می‌ماند.'}</div>
          </div>
        </div>
      </div>
      <div class="mv-sheet-foot">
        <button type="button" class="mv-btn" data-ovp-sheet="close">انصراف</button>
        <button type="button" class="mv-btn mv-btn--primary" data-ovp-sheet="save" ${s.saving ? 'disabled' : ''}>${s.saving ? 'در حال ذخیره…' : edit ? 'ذخیره' : 'افزودن'}</button>
      </div>
    </div>
  </div>`;
        wireSheet(host);
    }

    const sheetError = (text) => `<div class="mv-form-group ovp-strip" style="margin-top:10px"><div class="mv-form-row mv-callout is-danger"><i class="ph-fill ph-x-circle"></i><span>${esc(text)}</span></div></div>`;

    function wireSheet(host) {
        const u = host.querySelector('#ovp-user');
        const p = host.querySelector('#ovp-pass');
        if (u) u.oninput = () => { st.sheet.user = u.value; };
        if (p) p.oninput = () => { st.sheet.pass = p.value; };
        host.querySelectorAll('.ovp-field').forEach((f) => {
            f.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSheet(); } };
        });
        const scrim = host.querySelector('[data-ovp-scrim]');
        if (scrim) scrim.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); } };
        host.querySelectorAll('[data-ovp-sheet]').forEach((b) => {
            b.onclick = () => {
                const k = b.getAttribute('data-ovp-sheet');
                if (k === 'close') closeSheet();
                else if (k === 'save') saveSheet();
                else if (k === 'peek') {
                    st.sheet.show = !st.sheet.show;
                    const at = p ? [p.selectionStart, p.selectionEnd] : null;
                    drawSheet();
                    const np = document.getElementById('ovp-pass');
                    if (np) { np.focus(); try { if (at) np.setSelectionRange(at[0], at[1]); } catch (e) { /* not a text field */ } }
                }
            };
        });
    }

    async function saveSheet() {
        const s = st.sheet;
        if (!s || s.saving) return;
        const username = String(s.user || '').trim();
        const password = s.pass || '';
        const errBox = document.getElementById('ovp-sheet-err');
        if (!username || !password) {
            s.error = !username ? 'ایمیل حساب TunnelBear را وارد کنید.' : 'رمز حساب را وارد کنید.';
            if (errBox) errBox.innerHTML = sheetError(s.error);
            const f = document.getElementById(!username ? 'ovp-user' : 'ovp-pass');
            if (f) { f.classList.add('is-error'); f.focus(); }
            return;
        }
        s.saving = true;
        const btn = document.querySelector('[data-ovp-sheet="save"]');
        if (btn) { btn.disabled = true; btn.textContent = 'در حال ذخیره…'; }
        try {
            const r = await post('/api/openvpn/accounts/save', { id: s.id, username, password });
            st.accounts = r.accounts;
            const wasEdit = !!s.id;
            closeSheet();
            st.accBanner = { tone: 'ok', html: wasEdit ? 'حساب ذخیره شد.' : `حساب <bdi dir="ltr">${esc(username)}</bdi> اضافه شد. اتصال‌های TunnelBear حالا با آن انجام می‌شود.` };
            if (bridge && bridge.say) bridge.say(wasEdit ? 'حساب ذخیره شد' : 'حساب اضافه شد');
            paint(true);
            if (bridge && bridge.changed) bridge.changed();
        } catch (e) {
            s.saving = false;
            s.error = e.message;
            if (errBox) errBox.innerHTML = sheetError(s.error);
            if (btn) { btn.disabled = false; btn.textContent = s.id ? 'ذخیره' : 'افزودن'; }
        }
    }

    // ── painting ───────────────────────────────────────────────────────────

    /** The list of the section on screen — the only part a search or a measurement changes. */
    function paintList() {
        if (!hostEl) return;
        if (sec === 'tunnelbear') { const l = hostEl.querySelector('#ovp-list-tunnelbear'); if (l) l.innerHTML = bearRows(); }
        if (sec === 'profiles') { const l = hostEl.querySelector('#ovp-list-profiles'); if (l) l.innerHTML = ownRows(); }
        wire();
    }

    function paint(force) {
        if (!hostEl || !document.body.contains(hostEl)) return;
        // Whatever field has the focus keeps it, with its caret, across the redraw.
        const a = document.activeElement;
        const focus = a && hostEl.contains(a) && a.id ? a.id : null;
        let caret = null;
        try { caret = focus ? [a.selectionStart, a.selectionEnd] : null; } catch (e) { caret = null; }
        const sc = document.getElementById('ov-scroll');
        const top = sc ? sc.scrollTop : 0;
        hostEl.innerHTML = sec === 'accounts' ? renderAccounts() : sec === 'tunnelbear' ? renderTunnelBear() : renderOwn();
        paintList();
        if (sc && !force) sc.scrollTop = top;
        if (focus) {
            const el = document.getElementById(focus);
            if (el) { el.focus(); try { if (caret && caret[0] != null) el.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } }
        }
    }

    async function post(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || ('خطای ' + r.status));
        return j;
    }

    function readFiles(list) {
        return Promise.all(Array.from(list).map((f) => new Promise((resolve) => {
            if (f.size > 1048576) return resolve({ name: f.name, text: '', tooBig: true });
            const rd = new FileReader();
            rd.onload = () => resolve({ name: f.name, text: String(rd.result || '') });
            rd.onerror = () => resolve({ name: f.name, text: '' });
            rd.readAsText(f);
        })));
    }

    async function importFiles(fileList) {
        const files = await readFiles(fileList || []);
        if (!files.length) return;
        try {
            const r = await post('/api/openvpn/profiles/import', { files });
            const parts = [];
            if (r.added.length) parts.push(`${fa(r.added.length)} پروفایل اضافه شد`);
            if (r.duplicates.length) parts.push(`${fa(r.duplicates.length)} تکراری بود`);
            const errs = (r.errors || []).map((x) => `<b dir="ltr">${esc(x.file)}</b>: ${esc(x.error)}${x.missing ? ' — فایل <bdi dir="ltr">' + esc(x.missing) + '</bdi> را هم با آن انتخاب کنید' : ''}`);
            st.banner = { tone: errs.length ? (r.added.length ? 'warn' : 'err') : 'ok', html: (parts.join('، ') || 'چیزی اضافه نشد') + (errs.length ? '<br>' + errs.join('<br>') : '') };
            await load();
            // One new profile and nothing chosen yet: it is the obvious destination. The server
            // answers with the profiles' NAMES, so it is found by name among the user's own.
            if (r.added.length === 1 && target().kind === 'own' && !target().id && bridge && bridge.choose) {
                const p = st.profiles.find((x) => !x.tunnelbear && x.name === r.added[0]);
                if (p) bridge.choose('own', p.id);
            }
        } catch (e) { st.banner = { tone: 'err', html: 'افزودن نشد: ' + esc(e.message) }; paint(); }
    }

    async function measure(kind) {
        const ids = st.profiles.filter((p) => (kind === 'tunnelbear' ? p.tunnelbear : !p.tunnelbear)).map((p) => p.id);
        if (!ids.length) return;
        st.measuring = kind; paint();
        try { const r = await post('/api/openvpn/profiles/measure', { ids }); st.profiles = r.profiles || st.profiles; }
        catch (e) { if (bridge && bridge.say) bridge.say('سنجش نشد: ' + e.message); }
        st.measuring = '';
        paint();
    }

    function confirm(title, message, label) {
        if (window.uiModal && uiModal.confirm) {
            return uiModal.confirm({ title, message, confirmLabel: label, cancelLabel: 'انصراف', danger: true });
        }
        return Promise.resolve(window.confirm(title + '\n\n' + message));
    }

    function wire() {
        const root = hostEl;
        if (!root) return;
        root.querySelectorAll('[data-ovp-q]').forEach((q) => {
            q.oninput = () => {
                st.query[q.getAttribute('data-ovp-q')] = q.value;
                // The list only: rebuilding the toolbar would replace the field being typed in.
                paintList();
            };
        });
        root.querySelectorAll('input[data-ovp-file]').forEach((f) => {
            f.onchange = () => { const list = f.files; importFiles(list).then(() => { f.value = ''; }); };
        });

        // Drop .ovpn files anywhere on «پروفایل‌های من».
        const drop = root.querySelector('[data-ovp-drop]');
        if (drop && !drop.dataset.wired) {
            drop.dataset.wired = '1';
            const zone = () => root.querySelector('.ovp-dropzone');
            drop.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); const z = zone(); if (z) z.classList.add('is-drop'); } });
            drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) { const z = zone(); if (z) z.classList.remove('is-drop'); } });
            drop.addEventListener('drop', (e) => {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                e.preventDefault();
                const z = zone(); if (z) z.classList.remove('is-drop');
                importFiles(e.dataTransfer.files);
            });
        }

        // Choosing a row: one click chooses, a double click connects — on a row, never on its buttons.
        root.querySelectorAll('[data-ovp-pick]').forEach((row) => {
            const kind = row.getAttribute('data-ovp-pick');
            const id = row.getAttribute('data-id');
            const pick = () => { if (!busy() && bridge && bridge.choose) bridge.choose(kind, id); };
            row.onclick = (e) => { if (e.target.closest('button')) return; pick(); };
            row.ondblclick = (e) => { if (e.target.closest('button') || busy()) return; if (bridge && bridge.connectChosen) bridge.connectChosen(); };
            row.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); pick(); } };
        });

        root.querySelectorAll('[data-ovp-active]').forEach((row) => {
            const id = row.getAttribute('data-ovp-active');
            const on = async () => {
                if (st.accounts.activeId === id) return;
                try { const r = await post('/api/openvpn/accounts/prefs', { activeId: id }); st.accounts = r.accounts; paint(); if (bridge && bridge.changed) bridge.changed(); }
                catch (err) { st.accBanner = { tone: 'err', html: esc(err.message) }; paint(); }
            };
            row.onclick = (e) => { if (e.target.closest('button')) return; on(); };
            row.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); on(); } };
        });

        root.querySelectorAll('[data-ovp-switch="auto"]').forEach((sw) => {
            sw.addEventListener('mv-change', async (e) => {
                try { const r = await post('/api/openvpn/accounts/prefs', { autoSwitch: !!(e.detail && e.detail.checked) }); st.accounts = r.accounts; }
                catch (err) { st.accBanner = { tone: 'err', html: esc(err.message) }; paint(); }
            });
        });

        root.querySelectorAll('[data-ovp]').forEach((b) => {
            const k = b.getAttribute('data-ovp');
            const id = b.getAttribute('data-id');
            b.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    if (k === 'banner-x') { if (sec === 'accounts') st.accBanner = null; else st.banner = null; paint(); }
                    else if (k === 'go-accounts') { if (bridge && bridge.go) bridge.go('accounts'); }
                    else if (k === 'acc-add') { if (sec !== 'accounts' && bridge && bridge.go) bridge.go('accounts'); openSheet(null); }
                    else if (k === 'edit') openSheet(st.accounts.list.find((a) => a.id === id) || null);
                    else if (k === 'star') {
                        const p = st.profiles.find((x) => x.id === id);
                        if (p) { p.favorite = !p.favorite; paintList(); }
                        await post('/api/openvpn/profiles/favorite', { id, favorite: !!(p && p.favorite) });
                    } else if (k === 'delete') {
                        const p = st.profiles.find((x) => x.id === id);
                        const yes = await confirm('حذف پروفایل؟', `«${(p && p.name) || ''}» از فهرست پروفایل‌های شما پاک می‌شود. فایل اصلی روی کامپیوترتان دست نمی‌خورد.`, 'حذف');
                        if (!yes) return;
                        await post('/api/openvpn/profiles/delete', { id });
                        st.banner = { tone: 'ok', html: 'پروفایل حذف شد.' };
                        await load();
                    } else if (k === 'acc-delete') {
                        const a = st.accounts.list.find((x) => x.id === id);
                        const yes = await confirm('حذف حساب؟', `حساب ${a ? a.username : ''} و رمزش از این کامپیوتر پاک می‌شود.`, 'حذف');
                        if (!yes) return;
                        const r = await post('/api/openvpn/accounts/delete', { id });
                        st.accounts = r.accounts;
                        st.accBanner = { tone: 'ok', html: 'حساب حذف شد.' };
                        paint();
                        if (bridge && bridge.changed) bridge.changed();
                    } else if (k === 'fastest') { if (bridge && bridge.connectFastest) await bridge.connectFastest(); }
                    else if (k === 'measure') await measure(b.getAttribute('data-kind'));
                } catch (err) {
                    if (sec === 'accounts') st.accBanner = { tone: 'err', html: esc(err.message) };
                    else st.banner = { tone: 'err', html: esc(err.message) };
                    paint();
                }
            };
        });
    }

    window.OvProfiles = {
        /** Called once by openvpn.js when its frame is built. */
        attach(b) { bridge = b || bridge; if (!st.loaded) load(); },

        /** Draw section `which` ('tunnelbear' | 'profiles' | 'accounts') into `el`. */
        render(which, el, b, live) {
            bridge = b || bridge;
            const liveId = live && live.profileId !== undefined ? (live.profileId || null) : st.connectedId;
            if (liveId !== st.connectedId) { st.connectedId = liveId; load(); }
            const t = target();
            // Called on every repaint of the window (every 4 s). Redraw only when something this
            // page shows has changed — never under the user's fingers for nothing.
            const next = [which, liveId, t.kind, t.id, busy(), st.accounts.list.length].join('|');
            const fresh = el !== hostEl || which !== sec || !(el && el.firstChild);
            sec = which; hostEl = el;
            if (!st.loaded && !st.loading) load();
            if (fresh || next !== sig) { sig = next; paint(fresh); }
        },
        refresh: load,
        data() { return { loaded: st.loaded, profiles: st.profiles, accounts: st.accounts, connectedId: st.connectedId }; },
        delayWords,
        openAccountSheet() { openSheet(null); },
        onEvent(d) {
            if (d && d.profileProbe) {
                const p = st.profiles.find((x) => x.id === d.profileProbe.id);
                if (p) { p.probe = d.profileProbe.probe; if (hostEl && document.body.contains(hostEl)) paintList(); }
            }
        },
        get connectedId() { return st.connectedId; },
    };

    const css = document.createElement('style');
    css.id = 'ovp-css';
    css.textContent = `
#ov-wrap .ovp-page { display:flex; flex-direction:column; gap:0; }
#ov-wrap .ovp-strip { margin-bottom:12px; }
#ov-wrap .ovp-strip .mv-callout { align-items:center; }
#ov-wrap .ovp-strip .mv-callout.is-ok { --tone: var(--mv-green); --tone-ink: var(--mv-green-ink); }
#ov-wrap .ovp-strip-text { flex:1; min-width:0; }
#ov-wrap .ovp-strip .mv-status-head { padding:10px 14px; }
#ov-wrap .ovp-strip .mv-status-head h2 { margin:0; font-size:14px; font-weight:700; }
#ov-wrap .ovp-strip .mv-status-head p { margin:3px 0 0; font-size:11.5px; color:var(--mv-label-2); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#ov-wrap .ovp-strip .mv-status-head > .mv-side-tile { width:34px; height:34px; font-size:18px; }
#ov-wrap .ovp-strip .mv-sh-end { margin-inline-start:auto; }

/* TunnelBear: a list that flows into columns on a wide window */
#ov-wrap .ovp-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:2px; padding:4px; }
#ov-wrap .ovp-grid > .mv-li { border-radius:10px; min-height:50px; padding-inline:10px 6px; }
#ov-wrap .ovp-grid > .mv-li::before { content:none; }
#ov-wrap .ovp-grid > .mv-empty { grid-column:1 / -1; }
#ov-wrap .ovp-li { cursor:default; }
#ov-wrap .ovp-li:hover { background:var(--mv-fill); }
#ov-wrap .ovp-li.is-sel { background:color-mix(in srgb, var(--mv-accent) 13%, transparent); }
#ov-wrap .ovp-li.is-on { background:color-mix(in srgb, var(--mv-green) 12%, transparent); }
#ov-wrap .ovp-li:focus-visible { outline:2px solid var(--mv-accent); outline-offset:-2px; }
#ov-wrap .ovp-li .mv-li-text > small.is-live { color:var(--mv-green-ink); font-weight:600; }
#ov-wrap .ovp-li.is-sel .mv-li-text > small { color:var(--mv-accent); }
#ov-wrap .ovp-li.is-on .mv-li-text > small { color:var(--mv-green-ink); }
#ov-wrap .ovp-num { flex:none; }
#ov-wrap .ovp-sub-name { font-weight:400; font-size:11px; color:var(--mv-label-3); }
#ov-wrap .ovp-file-ic { width:26px; height:26px; border-radius:7px; display:grid; place-items:center; font-size:15px; color:#fff; background:var(--mv-teal-fill, var(--mv-teal)); }

#ov-wrap .ovp-star { flex:none; width:26px; height:26px; display:grid; place-items:center; border:0; border-radius:50%; background:none;
  color:var(--mv-label-3); cursor:pointer; font-size:15px; }
#ov-wrap .ovp-star:hover { background:var(--mv-fill-2); color:var(--mv-label-2); }
#ov-wrap .ovp-star.is-on { color:var(--mv-yellow); }

/* «پروفایل‌های من»: the whole list is a drop target */
#ov-wrap .ovp-dropzone { transition:box-shadow var(--mv-d-1) var(--mv-ease-out), background var(--mv-d-1) var(--mv-ease-out); }
#ov-wrap .ovp-dropzone.is-drop { box-shadow:inset 0 0 0 2px var(--mv-accent); background:color-mix(in srgb, var(--mv-accent) 8%, var(--mv-group)); }
#ov-wrap .ovp-empty { padding:34px 20px; }
#ov-wrap .ovp-empty > p { max-width:360px; }
#ov-wrap .ovp-filebtn { position:relative; overflow:hidden; margin-top:6px; }
#ov-wrap .ovp-filebtn > input[type=file] { position:absolute; inset:0; opacity:0; cursor:pointer; }

/* «حساب‌ها» */
#ov-wrap .ovp-acc { cursor:default; gap:10px; }
#ov-wrap .ovp-acc:hover { background:var(--mv-fill); }
#ov-wrap .ovp-acc.is-sel { background:color-mix(in srgb, var(--mv-accent) 12%, transparent); }
#ov-wrap .ovp-acc:focus-visible { outline:2px solid var(--mv-accent); outline-offset:-2px; }
#ov-wrap .ovp-add .mv-row-mark > i { color:var(--mv-accent); font-size:18px; }
#ov-wrap .ovp-add .mv-form-label { color:var(--mv-accent); }
#ov-wrap .ovp-gap { margin-top:18px; }

/* the sheet */
#ov-wrap .ovp-sheet-ic { display:flex; justify-content:center; margin:0 0 12px; }
#ov-wrap .ovp-sheet-ic > .mv-side-tile { width:46px; height:46px; border-radius:12px; font-size:24px; }
#ov-wrap .ovp-field { width:min(250px, 46vw); }
#ov-wrap .ovp-pass { display:flex; align-items:center; gap:4px; }
`;
    document.head.appendChild(css);
})();
