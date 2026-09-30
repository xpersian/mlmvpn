// --- «اوپن‌وی‌پی‌ان» panel ---
//
// The SAME window «گیت‌وی MLM» is, on a different engine. The user asked for exactly that —
// *«این بخش باید دقیقا همون امکانات گیت وی رو داشته باشه، همون سرورها و دقیقا تمام امکاناتش،
// فقط با موتور OPENVPN سرورهاش باید وصل بشه»* — so every capability of that window lives here too,
// and tests/openvpn/parity.test.js is where a missing one fails.
//
// REDESIGNED 2026-10-01 («کلا سیستم OPEN VPN باید از اول UIش طراحی بشه، هماهنگ با مک او اس جدید»).
// The window had grown three sources of servers — the public VPN Gate relays, TunnelBear's 47
// countries, and the user's own .ovpn files — and each had its own idea of how to connect: the
// power button only knew VPN Gate, and the other two pages were walls of blue «اتصال» buttons.
// Now there is ONE model for all three:
//
//   * CHOOSE, THEN CONNECT. A row in any of the three lists is chosen (accent, like a selected
//     item in Finder); the power button on «اتصال» — or the compact one in the title band on
//     every other page — connects to whatever is chosen. «مقصد اتصال» on the home page says which
//     source and which server that is, and switches source in one click.
//   * The live connection is GREEN, the chosen row is ACCENT — never the same look (page kit K3).
//   * VPN Gate is a real macOS table (K4): sortable columns, the chosen row highlighted, the
//     columns that matter least folding away on a narrow window.
//   * Accounts are added and edited in a SHEET over the window (K8), not in fields that the
//     4-second status poll could wipe.
//
// What is genuinely this engine's own, and why (unchanged):
//
//   * ONE ARCHIVE, TWO CURATIONS. The relay rows come from the gateway's archive; «فهرست من», the
//     deletions, the selection and every measurement are this engine's own, because the two
//     protocols disagree about the same relay.
//   * «تست واقعی» IS A REAL OPENVPN CONNECTION, to «Initialization Sequence Completed», on a
//     throwaway adapter.
//   * DIRECT, ALWAYS (the user's rule, 2026-09-30 — «مانند اندروید»). A TCP relay is dialled through
//     a local split relay that connects to it directly and breaks the first records into uneven
//     pieces (openvpn-manager › directPath). There is no front and no picker.
//
// Renders into #ls-openvpn. Talks to /api/openvpn/*. The TunnelBear, own-profile and account pages
// are components/openvpn-profiles.js (window.OvProfiles), mounted into this frame.

(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    /** The relay's own name, short enough to sit on a row. */
    function shortName(host) { return String(host || '').replace(/\.opengw\.net$/i, ''); }

    /**
     * The country's name in Persian, from the system's own data.
     *
     * A hand-written table covers the two dozen countries someone thought of and prints bare codes
     * for the rest — and this list reaches ninety. Intl has all of them and is already in Electron.
     */
    let REGION_NAMES = null;
    function countryName(cc) {
        const code = String(cc || '').toUpperCase();
        if (!code) return '';
        try {
            if (!REGION_NAMES) REGION_NAMES = new Intl.DisplayNames(['fa'], { type: 'region' });
            const n = REGION_NAMES.of(code);
            if (n && n !== code) return n;
        } catch (e) { /* no Intl data: the code itself is the honest answer */ }
        return code;
    }

    /**
     * Flags as SVG, never as emoji.
     *
     * Windows ships no glyphs for regional-indicator pairs, so an emoji flag renders as two boxed
     * letters — on exactly the rows whose job is to show a flag. The code sits behind the image,
     * so a country we have no file for reads as «PT» rather than as a hole.
     */
    function flag(cc, w) {
        const width = w || 19;
        const h = Math.round(width * 0.72);
        if (!cc) return `<span class="mv-flag is-none" style="width:${width}px;height:${h}px"></span>`;
        const code = String(cc).toLowerCase();
        return `<span class="mv-flag" style="width:${width}px;height:${h}px">${esc(String(cc).toUpperCase())}`
            + `<img src="/assets/flags/${esc(code)}.svg" alt="" onerror="this.remove()"></span>`;
    }

    /**
     * How long ago, in the unit a person would use.
     *
     * «۲ روز پیش» is what matters; the exact minute of a fetch two days old is noise.
     */
    function ago(ts) {
        if (!ts) return 'نامشخص';
        const ms = Date.now() - ts;
        if (ms < 0) return 'همین الان';
        const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (m < 2) return 'همین الان';
        if (m < 60) return fa(m) + ' دقیقه پیش';
        if (h < 24) return fa(h) + ' ساعت پیش';
        if (d < 30) return fa(d) + ' روز پیش';
        return fa(Math.floor(d / 30)) + ' ماه پیش';
    }

    /** Past this, VPN Gate has rotated enough of the list that most of it will not answer. */
    const STALE_MS = 3 * 86400000;
    const isStale = (ts) => !!ts && (Date.now() - ts) > STALE_MS;

    function duration(ms) {
        const t = Math.max(0, Math.floor(ms / 1000));
        const p = (n) => String(n).padStart(2, '0');
        return fa(`${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`);
    }

    /** A byte count in the unit a person reads: کیلوبایت up to a megabyte, then مگابایت, then گیگابایت. */
    function bytesText(n) {
        const b = Number(n) || 0;
        if (b < 1048576) return fa(Math.round(b / 1024)) + ' کیلوبایت';
        if (b < 1073741824) return fa((b / 1048576).toFixed(1).replace(/\.0$/, '')) + ' مگابایت';
        return fa((b / 1073741824).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')) + ' گیگابایت';
    }

    /** VPN Gate publishes uptime in milliseconds. Days is the only useful unit. */
    function uptimeText(ms) {
        if (!ms) return 'نامشخص';
        const d = Math.floor(ms / 86400000);
        if (d >= 1) return fa(d) + ' روز';
        return fa(Math.max(1, Math.floor(ms / 3600000))) + ' ساعت';
    }

    const LOG_POLICY = {
        '2weeks': 'دو هفته نگه می‌دارد',
        '1month': 'یک ماه نگه می‌دارد',
        '3months': 'سه ماه نگه می‌دارد',
        'no': 'بدون لاگ',
    };
    const logPolicy = (t) => LOG_POLICY[String(t || '').toLowerCase()] || (t ? esc(t) : 'اعلام نشده');

    /**
     * Why a real test failed, in the user's words — what openvpn.exe can actually report.
     *
     * These are the engine's own outcomes, not the gateway probe's: there is no «سافت‌اتر نیست»
     * here, and `timeout` means something specific and worth saying plainly. On this line a raw
     * dial times out with the server's certificate already verified, which is not «the relay is
     * down» — it is the handshake being cut. So the word points at the path, not at the relay.
     */
    const PROBE_FAIL = {
        timeout: 'دست‌دادن نیمه‌کاره ماند',
        'tls-cut': 'دست‌دادن قطع شد',
        unreachable: 'در دسترس نیست',
        auth: 'نام/رمز را نپذیرفت',
        'probe-url': 'پروفایل ساخته نشد',
        'core-missing': 'هستهٔ OpenVPN نیست',
        ENOENT: 'هستهٔ OpenVPN نیست',
    };

    /**
     * The real test's number, in words.
     *
     * Android shows «سریع / متوسط / کند» rather than milliseconds, and it is right to: a handshake
     * time is four seconds either way on this path and the exact figure invites a comparison the
     * measurement cannot support. The number itself is on the server's own page.
     */
    function probeBand(ms) {
        if (ms <= 2500) return { word: 'سریع', tone: 'ok' };
        if (ms <= 6000) return { word: 'متوسط', tone: 'mid' };
        return { word: 'کند', tone: 'slow' };
    }

    // ── sorting ────────────────────────────────────────────────────────────
    //
    // The same seven modes as Android, with the same descriptions — a user who learned this
    // screen on their phone must not have to learn it again here. Five of them are also the
    // table's column headers: a click there is the same choice as a row on «مرتب‌سازی».

    const SORTS = [
        { id: 'verified', label: 'تست‌شده‌ها اول', detail: 'سرورهایی که «تست واقعی» را رد کرده‌اند بالا می‌آیند. تست‌نشده‌ها بالاتر از ردشده‌ها می‌مانند — نبودِ تست یک خبر بد نیست.' },
        { id: 'official', label: 'رسمی‌ها اول', detail: 'سرورهایی که روی زیرساخت خود سرویس اجرا می‌شوند. معمولاً پایدارترند و پورتشان کمتر بسته می‌شود.' },
        { id: 'ping', label: 'سریع‌ترین', detail: 'کم‌ترین تأخیر اندازه‌گیری‌شده از خط اینترنت خودتان. تست‌نشده‌ها و بی‌پاسخ‌ها ته فهرست می‌روند.' },
        { id: 'score', label: 'امتیاز', detail: 'امتیازی که خود VPN Gate بر اساس پایداری و سابقهٔ سرور می‌دهد.' },
        { id: 'speed', label: 'پهنای باند', detail: 'سرعت اعلامی سرور. توجه: این عدد را VPN Gate از ژاپن اندازه گرفته، نه از ایران.' },
        { id: 'sessions', label: 'کاربران', detail: 'تعداد نشست‌های فعال. شلوغ‌تر یعنی محبوب‌تر، ولی گاهی هم یعنی کندتر.' },
        { id: 'country', label: 'کشور', detail: 'الفبایی بر اساس کد کشور، و در هر کشور بر اساس امتیاز.' },
    ];

    function sorter(mode) {
        const pr = (h) => st.probes[h];
        const pg = (h) => st.pings[h];
        switch (mode) {
            // Proven first, fastest of those on top. Untested rank above failed — a failure is
            // information, an absent test is not.
            case 'verified': return (a, b) => rankVerified(a) - rankVerified(b);
            case 'official': return (a, b) => (b.official - a.official) || (b.score - a.score);
            // Untested and unreachable sink, rather than masquerading as instant.
            case 'ping': return (a, b) => rankPing(a) - rankPing(b);
            case 'score': return (a, b) => b.score - a.score;
            case 'speed': return (a, b) => b.speedMbps - a.speedMbps;
            case 'sessions': return (a, b) => b.sessions - a.sessions;
            case 'country': return (a, b) => String(a.cc).localeCompare(String(b.cc)) || (b.score - a.score);
            default: return () => 0;
        }
        function rankVerified(r) {
            const p = pr(r.host);
            if (p && p.ok) return p.ms;
            if (!p) return 1e6;
            return 2e6;
        }
        function rankPing(r) {
            const v = pg(r.host);
            if (v === undefined) return 2147483646;
            return v > 0 ? v : 2147483647;
        }
    }

    // ── state ──────────────────────────────────────────────────────────────

    const st = {
        payload: null,
        mine: [], archive: [],
        kept: [], hidden: [],
        pings: {},           // host -> ms, 0 when it did not answer
        probes: {},          // host -> { ok, ms, reason, at }
        selected: null,      // the chosen VPN Gate relay (remembered by the server)
        suggested: null,

        // What the power button connects to: a VPN Gate relay (its host is `selected`), a
        // TunnelBear country, or one of the user's own profiles (a profile id).
        target: loadTarget(),

        scope: 'mine',       // 'mine' | 'archive'
        sort: 'verified',
        countries: [],       // empty = every country
        query: '',
        selecting: false,
        checked: [],
        detailHost: null,

        busy: false,
        confirm: null,       // { hosts, scope }
        snack: '',
        snackAt: 0,
        log: [],
    };

    const $ = (id) => document.getElementById(id);
    const has = (arr, v) => arr.indexOf(v) >= 0;
    const without = (arr, v) => arr.filter(x => x !== v);
    const status = () => (st.payload && st.payload.status) || {};

    function loadTarget() {
        try {
            const raw = (window.PersistentStorage || localStorage).getItem('ov-target');
            const t = raw ? JSON.parse(raw) : null;
            if (t && (t.kind === 'gate' || t.kind === 'bear' || t.kind === 'own')) return { kind: t.kind, id: t.id || null };
        } catch (e) { /* the default below */ }
        return { kind: 'gate', id: null };
    }
    function saveTarget() {
        try { (window.PersistentStorage || localStorage).setItem('ov-target', JSON.stringify(st.target)); } catch (e) { /* this session only */ }
    }

    // ── style ──────────────────────────────────────────────────────────────

    const CSS = `
<style id="ov-css">
  /* NO z-index HERE, and that is the whole of a bug the user reported as «دکمهٔ برگشت
     کار نمیکند».

     In a split window the title band is .mv-win.is-split .mv-win-bar — transparent,
     position:absolute, spanning the whole top, z-index:5 — and it lies OVER the pane's own
     bar so the empty parts of that band still drag the window. page-kit pokes the two
     interactive islands back through it with .mv-pane-nav { z-index:6 }.

     position:relative WITH a z-index (even 0) makes this wrapper a stacking context, and a
     stacking context is a ceiling: the nav's 6 is then 6 *inside a box whose own level is 0*,
     which loses to the window bar's 5. The button paints normally and every real click lands on
     the drag strip instead — document.elementFromPoint over it returned mv-win-bar.
     A scripted .click() still worked, which is why it passed review.

     position:relative alone creates no stacking context, so the nav competes with the bar
     directly and wins. The snack and the sheet below are positioned against this element. */
  #ov-wrap { position:relative; flex:1 1 auto; min-height:0; color:var(--mv-label); }
  #ov-wrap code, #ov-wrap .ov-host { font-family:var(--mv-font-tech); font-size:.92em; direction:ltr; unicode-bidi:isolate; }
  #ov-wrap .ov-num { font-family:var(--mv-font-tech); font-variant-numeric:tabular-nums; }
  #ov-wrap .ov-dim { color:var(--mv-label-2); }
  /* A hairline around every flag: on a light row Japan's white field vanished and the flag read
     as a bare red dot. */
  #ov-wrap .mv-flag { box-shadow:0 0 0 .5px color-mix(in srgb, var(--mv-label) 22%, transparent); }

  /* the sidebar: a count at the end of three items. A <b>, and the label keeps its ellipsis
     through :last-of-type — page-kit clips «the last child span», which the label no longer is. */
  #ov-wrap .mv-side-item > span:last-of-type:not(.mv-side-tile) { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  #ov-wrap .ov-count { flex:none; margin-inline-start:auto; font-size:11px; font-weight:600; color:var(--mv-label-3); font-family:var(--mv-font-tech); }
  #ov-wrap .mv-side-item.active .ov-count { color:inherit; opacity:.75; }

  /* ── status pills ── */
  #ov-wrap .ov-pill { display:inline-flex; align-items:center; height:20px; padding-inline:8px; border-radius:999px;
    font-size:11px; font-weight:600; white-space:nowrap; background:var(--mv-fill-2); color:var(--mv-label-2); }
  #ov-wrap .ov-pill.is-ok { background:color-mix(in srgb, var(--mv-green) 16%, transparent); color:var(--mv-green-ink); }
  #ov-wrap .ov-pill.is-mid { background:color-mix(in srgb, var(--mv-yellow) 22%, transparent); color:var(--mv-orange-ink); }
  #ov-wrap .ov-pill.is-slow { background:color-mix(in srgb, var(--mv-orange) 17%, transparent); color:var(--mv-orange-ink); }
  #ov-wrap .ov-pill.is-bad { background:color-mix(in srgb, var(--mv-red) 14%, transparent); color:var(--mv-red-ink); }
  #ov-wrap .ov-pill.is-tag { height:17px; padding-inline:6px; font-size:10px; }

  /* ── the page's own toolbar band: search + scope on one line, the actions under it ── */
  #ov-wrap .ov-toolbar { display:flex; flex-direction:column; gap:10px; margin:0 0 12px; }
  #ov-wrap .ov-bar1 { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  #ov-wrap .ov-bar1 > .mv-search { flex:1 1 240px; min-width:200px; }
  #ov-wrap .ov-bar1 > .mv-search > .mv-field { width:100%; padding-inline-end:30px; }
  #ov-wrap .ov-bar1 > .mv-search > button { position:absolute; inset-inline-end:6px; width:20px; height:20px; border:0; border-radius:50%;
    display:grid; place-items:center; background:var(--mv-fill-2); color:var(--mv-label-2); font-size:10px; cursor:pointer; }
  #ov-wrap .ov-tb { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  #ov-wrap .ov-tb > button, #ov-wrap .ov-tb > label {
    position:relative; height:28px; display:inline-flex; align-items:center; gap:6px; padding:0 12px;
    border:0; border-radius:999px; background:var(--mv-glass-btn); box-shadow:var(--mv-glass-btn-edge);
    color:var(--mv-label); font:inherit; font-size:12.5px; white-space:nowrap; cursor:default;
    transition:background var(--mv-d-1) var(--mv-ease-out); }
  #ov-wrap .ov-tb > button > i, #ov-wrap .ov-tb > label > i { font-size:14px; color:var(--mv-label-2); }
  #ov-wrap .ov-tb > button:hover:not(:disabled), #ov-wrap .ov-tb > label:hover { background:var(--mv-fill-2); }
  #ov-wrap .ov-tb > button[aria-pressed="true"] { background:var(--mv-control); box-shadow:var(--mv-control-hair); font-weight:600; }
  #ov-wrap .ov-tb > button[aria-pressed="true"] > i { color:var(--mv-accent); }
  #ov-wrap .ov-tb > button:disabled { opacity:.42; }
  #ov-wrap .ov-tb > .is-go { background:var(--mv-accent); color:var(--mv-on-accent); box-shadow:none; font-weight:600; }
  #ov-wrap .ov-tb > .is-go > i { color:inherit; }
  #ov-wrap .ov-tb > .is-go:hover:not(:disabled) { background:var(--mv-accent-2, var(--mv-accent)); }
  #ov-wrap .ov-tb > .is-bad { color:var(--mv-red-ink); }
  #ov-wrap .ov-tb > .is-bad > i { color:var(--mv-red); }
  #ov-wrap .ov-tb > .is-stop { color:var(--mv-red-ink); background:color-mix(in srgb, var(--mv-red) 14%, transparent); box-shadow:none; }
  #ov-wrap .ov-tb > .is-stop > i { color:var(--mv-red); }
  #ov-wrap .ov-tb > .ov-tb-sep { width:1px; height:18px; margin:0 4px; background:var(--mv-sep); }
  #ov-wrap .ov-tb > label > input[type=file] { position:absolute; inset:0; opacity:0; cursor:pointer; }

  /* the sweep's progress */
  #ov-wrap .ov-sweep { display:flex; align-items:center; gap:10px; padding:9px 14px; border-radius:12px;
    background:var(--mv-group); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); font-size:12px; color:var(--mv-label-2); }
  #ov-wrap .ov-sweep > .mv-spin-ring { font-size:13px; color:var(--mv-accent); }
  #ov-wrap .ov-sweep .ov-bar { flex:1 1 auto; height:6px; border-radius:3px; background:var(--mv-fill-2); overflow:hidden; }
  #ov-wrap .ov-sweep .ov-bar > i { display:block; height:100%; border-radius:3px; background:var(--mv-accent); transition:width .25s ease-out; }

  /* «انتخاب»: the bulk bar */
  #ov-wrap .ov-bulk { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 8px 8px 14px; border-radius:12px;
    background:color-mix(in srgb, var(--mv-accent) 10%, transparent); font-size:12.5px; }
  #ov-wrap .ov-bulk > b { font-weight:700; }
  #ov-wrap .ov-bulk > .ov-tb { margin-inline-start:auto; }

  #ov-wrap .ov-summary { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:0 4px; font-size:11.5px; color:var(--mv-label-2); }
  #ov-wrap .ov-summary > button { border:0; border-radius:999px; padding:2px 9px; cursor:pointer; font:inherit; font-size:11px;
    background:var(--mv-fill-2); color:var(--mv-label); }
  #ov-wrap .ov-summary > button > i { font-size:10px; }

  /* ── the VPN Gate table ── */
  #ov-wrap .ov-tgroup { overflow:hidden; }
  #ov-wrap .ov-table { table-layout:auto; }
  #ov-wrap .ov-table th { position:sticky; top:0; background:var(--mv-group); z-index:1; }
  #ov-wrap .ov-table th[data-sortcol] { cursor:pointer; }
  #ov-wrap .ov-table th[data-sortcol]:hover { color:var(--mv-label); }
  #ov-wrap .ov-table th.is-sorted { color:var(--mv-accent); }
  #ov-wrap .ov-table th .ov-arrow { font-size:9px; margin-inline-start:3px; }
  #ov-wrap .ov-table td { padding-block:7px; vertical-align:middle; }
  #ov-wrap .ov-table td.ov-c-mark { width:22px; padding-inline:12px 0; }
  #ov-wrap .ov-table td.ov-c-num { font-family:var(--mv-font-tech); font-variant-numeric:tabular-nums; color:var(--mv-label-2); }
  #ov-wrap .ov-table td.ov-c-act { width:30px; padding-inline:0 8px; }
  #ov-wrap .ov-table tr.ov-tr { cursor:default; }
  #ov-wrap .ov-table tr.ov-tr:hover > td { background:var(--mv-fill); }
  #ov-wrap .ov-table tr.ov-tr.is-sel > td { background:color-mix(in srgb, var(--mv-accent) 13%, transparent); }
  #ov-wrap .ov-table tr.ov-tr.is-on > td { background:color-mix(in srgb, var(--mv-green) 12%, transparent); }
  #ov-wrap .ov-table tr.ov-tr.is-locked { opacity:.55; }
  #ov-wrap .ov-table tr.ov-tr:focus-visible { outline:2px solid var(--mv-accent); outline-offset:-2px; }
  #ov-wrap .ov-mark { display:grid; place-items:center; font-size:16px; color:var(--mv-label-3); }
  #ov-wrap .ov-mark.is-on { color:var(--mv-accent); }
  #ov-wrap .ov-mark.is-live { color:var(--mv-green); }
  #ov-wrap .ov-srv { display:flex; align-items:center; gap:10px; min-width:0; }
  #ov-wrap .ov-srv-t { display:flex; flex-direction:column; min-width:0; line-height:1.45; }
  #ov-wrap .ov-srv-t > b { font-size:12.5px; font-weight:600; display:flex; align-items:center; gap:6px; }
  #ov-wrap .ov-srv-t > small { font-size:11px; color:var(--mv-label-3); font-family:var(--mv-font-tech); text-align:start; }
  #ov-wrap .ov-srv-t > small.is-live { color:var(--mv-green-ink); font-family:inherit; }
  /* a narrow window drops the columns that matter least, rather than scrolling sideways */
  @container (max-width: 660px) { #ov-wrap .ov-c-score, #ov-wrap .ov-c-sess { display:none; } }
  @container (max-width: 520px) { #ov-wrap .ov-c-speed { display:none; } }

  /* ── «اتصال»: where the button goes ── */
  #ov-wrap .ov-dest { margin-top:14px; border-radius:14px; background:var(--mv-group);
    box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); overflow:hidden; }
  #ov-wrap .ov-dest-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 14px 10px; }
  #ov-wrap .ov-dest-head > h3 { margin:0; font-size:13px; font-weight:700; }
  #ov-wrap .ov-dest-head > .mv-seg { margin-inline-start:auto; }
  #ov-wrap .ov-dest .mv-li { min-height:58px; padding-inline:14px; }
  #ov-wrap .ov-dest .mv-li + .mv-li::before { inset-inline-start:14px; }
  #ov-wrap .ov-dest .mv-li-end { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--mv-accent); }
  #ov-wrap .ov-dest .mv-li-lead > .ov-src { width:30px; height:30px; border-radius:8px; display:grid; place-items:center;
    font-size:16px; color:#fff; background:var(--tint); }
  #ov-wrap .ov-dest-foot { padding:0 14px 12px; font-size:11.5px; line-height:1.75; color:var(--mv-label-2); }

  /* the home page's cards */
  #ov-wrap .ov-kv { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:5px 13px;
    font-size:12px; color:var(--mv-label-2); }
  #ov-wrap .ov-kv > span { flex:none; white-space:nowrap; }
  #ov-wrap .ov-kv > b { font-weight:600; color:var(--mv-label); text-align:end; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #ov-wrap .ov-card-act { display:flex; gap:6px; flex-wrap:wrap; padding:6px 13px 2px; }
  #ov-wrap .ov-card-line { padding:6px 13px 0; font-size:12px; line-height:1.75; color:var(--mv-label-2); }
  #ov-wrap .ov-card-line b { color:var(--mv-label); font-weight:600; }
  #ov-wrap .ov-card-line.is-warn b { color:var(--mv-orange-ink); }

  /* countries */
  #ov-wrap .ov-cgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:2px; padding:4px; }
  #ov-wrap .ov-cgrid > .mv-li { border-radius:9px; min-height:40px; padding-inline:10px; }
  #ov-wrap .ov-cgrid > .mv-li::before { content:none; }
  #ov-wrap .ov-cgrid > .mv-li.is-sel { background:color-mix(in srgb, var(--mv-accent) 12%, transparent); }

  /* one server's page */
  #ov-wrap .ov-dhead { display:flex; align-items:center; gap:14px; padding:4px 4px 16px; }
  #ov-wrap .ov-dhead > .mv-flag { border-radius:6px; }
  #ov-wrap .ov-dhead h2 { margin:0; font-size:20px; font-weight:740; }
  #ov-wrap .ov-dhead p { margin:3px 0 0; font-size:12px; color:var(--mv-label-2); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #ov-wrap .ov-dhead .ov-dhead-act { margin-inline-start:auto; display:flex; gap:8px; flex-wrap:wrap; }
  #ov-wrap .ov-val { margin-inline-start:auto; min-width:0; font-size:12.5px; text-align:end; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  #ov-wrap .ov-log { margin:0; width:100%; max-height:none; min-height:280px; overflow:auto;
    font-family:var(--mv-font-mono); font-size:11.5px; line-height:1.75; white-space:pre-wrap; word-break:break-word;
    text-align:left; color:var(--mv-label-2); }

  #ov-wrap .ov-snack { position:absolute; inset-inline:0; bottom:48px; display:flex; justify-content:center; pointer-events:none; z-index:3; }
  #ov-wrap .ov-snack > span { background:var(--mv-fill-2); -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px);
    border-radius:11px; padding:8px 15px; font-size:12px; box-shadow:0 6px 20px rgba(0,0,0,.28); }

  /* the sheet: over the window, under its title band (whose traffic lights must stay usable) */
  #ov-wrap .ov-scrim { position:absolute; inset:0; z-index:4; display:flex; align-items:flex-start; justify-content:center;
    padding:56px 20px 20px; background:color-mix(in srgb, #000 30%, transparent); animation:ov-fade .16s ease-out; }
  #ov-wrap .ov-scrim > .mv-sheet { width:min(460px, 100%); animation:ov-drop .22s cubic-bezier(.2, .8, .2, 1); }
  @keyframes ov-fade { from { opacity:0; } }
  @keyframes ov-drop { from { opacity:0; transform:translateY(-12px); } }
  html[data-motion="reduced"] #ov-wrap .ov-scrim, html[data-motion="reduced"] #ov-wrap .ov-scrim > .mv-sheet { animation:none; }
</style>`;

    // ── the page ───────────────────────────────────────────────────────────

    const OV_SECTIONS = [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'servers', label: 'سرورهای عمومی', icon: 'ph-fill ph-globe-hemisphere-west', tint: 'var(--mv-indigo)', group: 'src' },
        // TunnelBear's 47 countries, the user's own .ovpn profiles and the accounts they sign in
        // with are components/openvpn-profiles.js.
        { id: 'tunnelbear', label: 'TunnelBear', icon: 'ph-fill ph-paw-print', tint: 'var(--mv-orange)', group: 'src' },
        { id: 'profiles', label: 'پروفایل‌های من', icon: 'ph-fill ph-file-text', tint: 'var(--mv-teal)', group: 'src' },
        { id: 'accounts', label: 'حساب‌ها', icon: 'ph-fill ph-user-circle', tint: 'var(--mv-blue)', group: 'more' },
        { id: 'guide', label: 'راهنما', icon: 'ph-fill ph-book-open', tint: 'var(--mv-purple)', group: 'more' },
        { id: 'log', label: 'گزارش', icon: 'ph-fill ph-terminal-window', tint: 'var(--mv-gray)', group: 'more' },
    ];
    const SECTION_OF = Object.fromEntries(OV_SECTIONS.map((x) => [x.id, x]));

    /**
     * Pages reachable only from «سرورهای عمومی», which is where they belong: a country filter and a
     * sort order are decisions ABOUT the list, not siblings of it. The back button returns to the
     * list, exactly as the Android page stack does.
     */
    const SUB = { countries: 'کشورها', sort: 'مرتب‌سازی', detail: 'سرور' };

    /** The three places a server can come from, as «مقصد اتصال» names them. */
    const SOURCES = [
        { kind: 'gate', sec: 'servers', label: 'سرورهای عمومی', icon: 'ph-fill ph-globe-hemisphere-west', tint: 'var(--mv-indigo)' },
        { kind: 'bear', sec: 'tunnelbear', label: 'TunnelBear', icon: 'ph-fill ph-paw-print', tint: 'var(--mv-orange)' },
        { kind: 'own', sec: 'profiles', label: 'پروفایل‌های من', icon: 'ph-fill ph-file-text', tint: 'var(--mv-teal)' },
    ];
    const SOURCE_OF = Object.fromEntries(SOURCES.map((x) => [x.kind, x]));

    let ovSec = 'connect';

    function sideItem(x) {
        return `
        <button type="button" class="mv-side-item" data-ov-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span><b class="ov-count" data-count="${x.id}"></b>
        </button>`;
    }

    function template() {
        return CSS + `
<div id="ov-wrap" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های اوپن‌وی‌پی‌ان">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="ov-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">${sideItem(SECTION_OF.connect)}</div>
      <div class="mv-side-group">
        <div class="mv-side-head">سرورها</div>
        ${OV_SECTIONS.filter((x) => x.group === 'src').map(sideItem).join('')}
      </div>
      <div class="mv-side-group">${OV_SECTIONS.filter((x) => x.group === 'more').map(sideItem).join('')}</div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" data-ov-store="1" title="هستهٔ اوپن‌وی‌پی‌ان در ام‌ال‌ام استور">
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
        <button type="button" id="ov-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="ov-pane-title">اتصال</h1>
      <div class="mv-eng-bar-action" id="ov-bar-action"></div>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="ov-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="ov-stage" style="--tint:var(--mv-orange)"></div>
        <div class="ov-dest" id="ov-dest"></div>
        <div class="mv-eng-grid" id="ov-cards"></div>
      </div>

      <div class="mv-eng-sec" data-sec="servers">
        <div class="ov-toolbar" id="ov-tools"></div>
        <div class="mv-form-group ov-tgroup" id="ov-servers"></div>
        <div class="mv-form-footer" id="ov-list-note"></div>
      </div>

      <div class="mv-eng-sec" data-sec="countries">
        <div class="ov-toolbar" id="ov-country-tools"></div>
        <div class="mv-form-group"><div class="ov-cgrid" id="ov-countries"></div></div>
        <div class="mv-form-footer">فهرست را به یک یا چند کشور محدود می‌کند. بدون فیلتر، همهٔ سرورهای این فهرست نمایش داده می‌شوند. می‌توانید چند کشور را با هم انتخاب کنید — مثلاً برای اینکه یک قاره را یک‌جا تست بگیرید.</div>
      </div>

      <div class="mv-eng-sec" data-sec="sort">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">مرتب‌سازی</div>
            <div class="mv-form-group" id="ov-sorts" role="radiogroup"></div>
            <div class="mv-form-footer">ترتیب فقط روی نمایش اثر دارد؛ هیچ سروری با آن حذف یا اضافه نمی‌شود. پیش‌فرض روی «تست‌شده‌ها اول» است. سرستون‌های جدول سرورها هم همین کار را می‌کنند.</div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="detail"><div id="ov-detail"></div></div>
      <div class="mv-eng-sec" data-sec="tunnelbear"><div id="ov-tunnelbear"></div></div>
      <div class="mv-eng-sec" data-sec="profiles"><div id="ov-profiles"></div></div>
      <div class="mv-eng-sec" data-sec="accounts"><div id="ov-accounts"></div></div>
      <div class="mv-eng-sec" data-sec="guide"><div id="ov-guide"></div></div>

      <div class="mv-eng-sec" data-sec="log">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">گزارش زنده — خط‌به‌خط، از خود موتور</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack"><pre class="ov-log" id="ov-log" dir="ltr"></pre></div>
            </div>
            <div class="mv-form-footer">وقتی اتصال نگیرد، این تنها جایی است که می‌گوید دقیقاً کجا ایستاد.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="mv-eng-foot" id="ov-foot"></div>
    <div class="ov-snack" id="ov-snack" hidden></div>
  </section>
  <div id="ov-sheet-host"></div>
</div>`;
    }

    function ovDot(tone) {
        return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
    }

    // ── what the power button is aimed at ───────────────────────────────────

    function selectedRow() {
        return st.mine.find(r => r.host === st.selected)
            || st.archive.find(r => r.host === st.selected) || null;
    }

    /** openvpn-profiles.js's data: TunnelBear, the user's own profiles, the accounts. */
    function prof() {
        return (window.OvProfiles && OvProfiles.data()) || { loaded: false, profiles: [], accounts: { list: [] } };
    }

    /**
     * The chosen destination, whichever source it is in — or `{ ok:false }` with the reason the
     * button cannot act on it yet.
     */
    function targetInfo() {
        const t = st.target;
        const src = SOURCE_OF[t.kind] || SOURCES[0];
        if (t.kind === 'gate') {
            const r = selectedRow();
            if (!r) return { kind: 'gate', src, ok: false, why: 'هنوز سروری انتخاب نشده' };
            return {
                kind: 'gate', src, ok: true, id: r.host, cc: r.cc,
                name: (countryName(r.cc) || r.country) + (r.official ? ' · رسمی' : ''),
                host: shortName(r.host),
                sub: resultWords(r.host) || `${fa(r.speedMbps)} مگابیت آگهی‌شده`,
            };
        }
        const P = prof();
        const p = P.profiles.find((x) => x.id === t.id && (t.kind === 'bear' ? x.tunnelbear : !x.tunnelbear));
        if (!p) {
            return { kind: t.kind, src, ok: false,
                why: t.kind === 'bear' ? 'هنوز کشوری انتخاب نشده' : (P.profiles.some((x) => !x.tunnelbear) ? 'هنوز پروفایلی انتخاب نشده' : 'هنوز پروفایلی اضافه نکرده‌اید') };
        }
        const needsAccount = t.kind === 'bear' && !(P.accounts && P.accounts.list && P.accounts.list.length);
        return {
            kind: t.kind, src, ok: !needsAccount, id: p.id, cc: p.place && p.place.code,
            name: (p.place && p.place.name) || p.name,
            host: t.kind === 'own' ? p.name : '',
            sub: needsAccount ? 'اول یک حساب TunnelBear اضافه کنید' : (window.OvProfiles ? OvProfiles.delayWords(p) : ''),
            why: needsAccount ? 'برای TunnelBear یک حساب لازم است' : '',
        };
    }

    /** Is this destination the one carrying traffic right now? */
    function isLive(kind, id) {
        const s = status();
        if (!s.connected) return false;
        return kind === 'gate' ? (!s.profileId && s.host === id) : s.profileId === id;
    }

    /** The live connection's own name, from whichever source it came. */
    function liveName() {
        const s = status();
        if (s.profileId) {
            const p = prof().profiles.find((x) => x.id === s.profileId);
            const n = (p && p.place && p.place.name) || s.label || (p && p.name) || '';
            return { name: n, word: p && p.tunnelbear ? 'TunnelBear' : 'پروفایل شما', cc: p && p.place && p.place.code };
        }
        const r = st.mine.find((x) => x.host === s.host) || st.archive.find((x) => x.host === s.host);
        return { name: r ? (countryName(r.cc) || r.country) : (s.label || shortName(s.host)), word: 'سرور عمومی', cc: r && r.cc, host: shortName(s.host) };
    }

    // ── what the hero says ─────────────────────────────────────────────────

    function ovView() {
        const p = st.payload || {}, s = p.status || {};
        const base = { s, p };

        if (!s.installed) {
            return Object.assign(base, { tone: 'off', act: '',
                head: 'هستهٔ OpenVPN روی این سیستم نیست',
                line: 'این بخش هستهٔ رسمی OpenVPN را راه می‌اندازد و خودش مدیریتش می‌کند. یک بار از «استور» نصبش کنید و بعد از آن همه چیز از همین پنجره انجام می‌شود.' });
        }
        if (s.connected) {
            const ln = liveName();
            const bits = [];
            if (s.localIp) bits.push(`آدرس <code>${esc(s.localIp)}</code>`);
            bits.push(s.path === 'split' ? 'مستقیم، از رلهٔ محلی' : 'مستقیم');
            if (s.since) bits.push(`<span class="ov-num" dir="ltr">${duration(Date.now() - s.since)}</span>`);
            return Object.assign(base, { tone: 'on', act: 'off',
                head: 'وصل است',
                line: `همهٔ ترافیک سیستم از <b>${esc(ln.name)}</b> (${esc(ln.word)}) رد می‌شود. ` + bits.join(' · ') });
        }
        if (s.connecting) {
            return Object.assign(base, { tone: 'busy', act: 'off',
                head: 'در حال اتصال…',
                line: esc(s.detail || '') || 'نشست در حال برقراری… همین دکمه لغو می‌کند.' });
        }
        const t = targetInfo();
        if (s.error) {
            return Object.assign(base, { tone: 'off', act: t.ok ? 'on' : '',
                head: 'وصل نشد',
                line: esc(s.error) + ' — بخش «گزارش» خط‌به‌خط می‌گوید کجا ایستاد.' });
        }
        if (!t.ok) {
            return Object.assign(base, { tone: 'off', act: '',
                head: t.kind === 'bear' && t.why ? 'حساب TunnelBear لازم است' : 'مقصدی انتخاب نشده',
                line: t.kind === 'bear' && t.why && t.id
                    ? 'سرورهای TunnelBear فقط با حساب خودتان وصل می‌شوند. در «حساب‌ها» یکی اضافه کنید.'
                    : 'سه جا سرور دارد: <b>سرورهای عمومی</b> (هزاران سرور داوطلبانه، بدون حساب)، <b>TunnelBear</b> با حساب خودتان، و <b>پروفایل‌های من</b> از فایل‌های .ovpn خودتان. از «مقصد اتصال» پایین یکی را انتخاب کنید.' });
        }
        const lines = {
            gate: 'هستهٔ رسمی OpenVPN آداپتور TUN خودش را باز می‌کند، پس تونل کامل سیستم را خودش برقرار می‌کند. اتصال <b>مستقیم</b> است — بدون سایفون یا هیچ موتور دیگری.',
            bear: 'سرورهای TunnelBear از ایران روی UDP بسته‌اند؛ اتصال از راه TCP و یک رلهٔ محلی برقرار می‌شود که شکل بسته‌های اول را برای فیلتر ناخوانا می‌کند. <b>مستقیم</b> است — بدون هیچ موتور دیگری.',
            own: 'پروفایل خودتان، همان‌طور که فایلش می‌گوید — فقط دستورهای شناخته‌شدهٔ OpenVPN، بدون هیچ اسکریپتی. تونل کامل سیستم را خود هستهٔ OpenVPN برقرار می‌کند.',
        };
        return Object.assign(base, { tone: 'off', act: 'on', head: 'آمادهٔ اتصال', line: lines[t.kind] });
    }

    function renderIdent() {
        const host = $('ov-ident');
        if (!host) return;
        const v = ovView();
        const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('openvpn');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-orange)"><svg aria-hidden="true"><use href="#g-server"/></svg></span>';
        const html = `${icon}
      <b>اوپن‌وی‌پی‌ان</b>
      <small>${ovDot(v.tone)}${word}</small>`;
        // Rebuilt only when it changes: the icon is an image, and replacing it flickers.
        if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
    }

    /** The counts at the end of the three source items. */
    function renderSideCounts() {
        const wrap = $('ov-wrap');
        if (!wrap) return;
        const P = prof();
        // Nothing, rather than «۰»: a Persian zero is a dot, and a dot at the end of a sidebar item
        // reads as a status lamp.
        const n = (x) => (x ? fa(x) : '');
        const counts = {
            servers: n(st.mine.length),
            tunnelbear: P.loaded ? n(P.profiles.filter((x) => x.tunnelbear).length) : '',
            profiles: P.loaded ? n(P.profiles.filter((x) => !x.tunnelbear).length) : '',
            accounts: P.loaded ? n(P.accounts.list.length) : '',
        };
        wrap.querySelectorAll('[data-count]').forEach((b) => { b.textContent = counts[b.getAttribute('data-count')] || ''; });
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function renderHero() {
        const host = $('ov-stage');
        if (!host) return;
        const v = ovView();

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-ov-act="power" data-part="power">
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
        btn.disabled = !v.act || st.busy;
        // «قطع» while connected, «اتصال» while not. The word on the control must be what the
        // control does, not what the engine is.
        const aria = v.act === 'off' ? (v.s.connecting ? 'لغو' : 'قطع') : 'اتصال';
        btn.setAttribute('aria-label', aria);
        btn.title = v.act ? aria : (!v.s.installed ? 'هستهٔ OpenVPN نصب نیست' : (targetInfo().why || 'اول یک مقصد انتخاب کنید'));
        const glyph = (v.tone === 'busy' || st.busy) ? 'mv-spin-ring'
            : v.tone === 'on' ? 'ph-fill ph-power' : 'ph-bold ph-power';
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const el = q('live');
        if (el && window.MVEngineLive) MVEngineLive.mount(el);
    }

    /**
     * «مقصد اتصال»: which of the three sources the button uses, and what is chosen in it.
     *
     * The segmented control switches source; the row under it is the chosen server of that
     * source and opens its list. So the whole decision is readable on the page the button is on.
     */
    function renderDest() {
        const host = $('ov-dest');
        if (!host) return;
        const t = targetInfo();
        const s = status();
        const live = t.ok && isLive(t.kind, t.id);
        const lead = t.ok && (t.cc || t.kind === 'gate')
            ? flag(t.cc, 26)
            : `<span class="ov-src" style="--tint:${t.src.tint}"><i class="${t.src.icon}"></i></span>`;
        const foot = {
            gate: 'سرورهای داوطلبانهٔ VPN Gate — بدون حساب و بدون هزینه. «تست واقعی» در همان صفحه، سرورهایی را که روی خط شما واقعاً وصل می‌شوند پیدا می‌کند.',
            bear: 'چهل‌وهفت کشور TunnelBear، با حساب خودتان. «سنجش تأخیر» در همان صفحه سالم‌ترین سرور هر کشور را پیدا می‌کند.',
            own: 'فایل‌های .ovpn خودتان — از سرور خودتان یا هر سرویسی که پروفایل OpenVPN می‌دهد.',
        }[t.kind];
        host.innerHTML = `
      <div class="ov-dest-head">
        <h3>مقصد اتصال</h3>
        <div class="mv-seg" role="tablist" aria-label="منبع سرور">
          ${SOURCES.map((x) => `<button type="button" role="tab" data-ov-kind="${x.kind}" aria-pressed="${st.target.kind === x.kind}"${s.connecting || st.busy ? ' disabled' : ''}>${x.label}</button>`).join('')}
        </div>
      </div>
      <div class="mv-list">
        <button type="button" class="mv-li${live ? ' is-on' : t.ok ? ' is-sel' : ''}" data-ov-go="${t.src.sec}">
          <span class="mv-li-lead">${lead}</span>
          <span class="mv-li-text">
            <b>${t.ok || t.id ? esc(t.name) + (t.host ? ` <code>${esc(t.host)}</code>` : '') : esc(t.why)}</b>
            <small>${live ? 'همین حالا وصل است' : t.ok || t.id ? t.sub : 'از فهرست «' + esc(t.src.label) + '» یکی را انتخاب کنید'}</small>
          </span>
          <span class="mv-li-end">${t.ok || t.id ? 'تغییر' : 'انتخاب'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
      </div>
      <div class="ov-dest-foot">${foot}</div>`;
    }

    // ── the connect page's cards ───────────────────────────────────────────

    function renderCards() {
        const host = $('ov-cards');
        if (!host) return;
        const p = st.payload || {}, s = p.status || {};
        const proven = Object.values(st.probes).filter(x => x && x.ok).length;
        const lastLog = st.log.length ? st.log[st.log.length - 1] : '';
        const stale = isStale(p.fetchedAt);
        const P = prof();
        const accs = (P.accounts && P.accounts.list) || [];
        const active = accs.find((a) => a.id === P.accounts.activeId) || accs[0] || null;
        const own = P.profiles.filter((x) => !x.tunnelbear).length;

        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-plugs-connected"></i></span>
          <h3>نشست</h3>
          <span class="mv-eng-card2-end">${s.connected ? 'برقرار' : s.connecting ? 'در حال برقراری' : 'ندارید'}</span>
        </div>
        <div class="mv-eng-card2-body">
          ${s.connected ? `
          <div class="ov-kv"><span>آدرس در شبکه</span><b dir="ltr">${esc(s.localIp || '—')}</b></div>
          <div class="ov-kv"><span>مدت اتصال</span><b dir="ltr" class="ov-num">${s.since ? duration(Date.now() - s.since) : '—'}</b></div>
          <div class="ov-kv"><span>مسیر داده</span><b>${s.path === 'split' ? 'مستقیم — رلهٔ محلی (TCP)' : 'مستقیم'}</b></div>
          <div class="ov-kv"><span>دریافت / ارسال</span><b>${bytesText(s.bytesIn)} / ${bytesText(s.bytesOut)}</b></div>
          <div class="ov-kv"><span>آداپتور</span><b dir="ltr">${esc(s.adapter || '—')}${s.adapterDriver ? ' · ' + esc(s.adapterDriver) : ''}</b></div>`
            : '<div class="ov-card-line">این موتور آداپتور TUN خودش را باز می‌کند، پس تونل کامل سیستم را خودش برقرار می‌کند — نه پروکسی، نه تنظیمی در ویندوز.</div>'}
        </div>
        <div class="mv-eng-card2-foot">اتصال همیشه مستقیم است؛ سرورهای TCP از یک رلهٔ محلی وصل می‌شوند که خودش مستقیم به سرور وصل می‌شود.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-ov-go="servers">
            <span class="mv-eng-glyph"><i class="ph-fill ph-globe-hemisphere-west"></i></span>
            <h3>سرورهای عمومی</h3>
            <span class="mv-eng-card2-end">${fa(st.mine.length)}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-ov-act="refresh"
                  title="به‌روزرسانی فهرست" aria-label="به‌روزرسانی فهرست" ${st.busy || sweep() ? 'disabled' : ''}>
            <i class="${st.busy ? 'mv-spin-ring' : 'ph-bold ph-arrows-clockwise'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          <div class="ov-kv"><span>فهرست من / آرشیو</span><b>${fa(st.mine.length)} / ${fa(st.archive.length)}</b></div>
          <div class="ov-kv"><span>آخرین به‌روزرسانی</span><b${stale ? ' style="color:var(--mv-orange-ink)"' : ''}>${p.fetchedAt ? esc(ago(p.fetchedAt)) : (p.source === 'bundled' ? 'فهرست همراه برنامه' : 'هنوز نه')}</b></div>
          <div class="ov-kv"><span>تأییدشده با «تست واقعی»</span><b>${proven ? fa(proven) + ' سرور' : 'هنوز هیچ'}</b></div>
          ${st.hidden.length ? `
          <div class="ov-card-act">
            <button type="button" class="mv-btn mv-btn--sm" data-ov-act="restore" title="سرورهایی که حذف کرده‌اید دیگر در فهرست ظاهر نمی‌شوند، حتی اگر VPN Gate دوباره منتشرشان کند. این دکمه همهٔ آن‌ها را یک‌جا برمی‌گرداند.">
              <i class="ph-bold ph-arrow-counter-clockwise"></i>بازگرداندن ${fa(st.hidden.length)} سرور حذف‌شده</button>
          </div>` : ''}
        </div>
        <div class="mv-eng-card2-foot">${!p.canRefresh
            ? 'سایت فهرست از ایران همیشه باز نیست. <b>برای به‌روزرسانی، یک حساب کلادفلر در بخش ابری اضافه کنید</b> (فهرست از راه ورکر خودتان گرفته می‌شود) <b>یا یکی از تونل‌های برنامه را روشن کنید</b>.'
            : stale
                ? 'فهرست شما کهنه است. VPN Gate سرورهایش را مدام عوض می‌کند، پس بیشتر این‌ها دیگر جواب نمی‌دهند.'
                : 'هر به‌روزرسانی فهرست را <b>بزرگ‌تر</b> می‌کند، نه اینکه جایش را بگیرد — سرورهای قدیمی در «آرشیو» می‌مانند.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-orange)">
        <button type="button" class="mv-eng-card2-head" data-ov-go="tunnelbear">
          <span class="mv-eng-glyph"><i class="ph-fill ph-paw-print"></i></span>
          <h3>TunnelBear و پروفایل‌ها</h3>
          <span class="mv-eng-card2-end">${P.loaded ? fa(P.profiles.length) : '—'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          <div class="ov-kv"><span>حساب TunnelBear</span><b dir="${active ? 'ltr' : 'rtl'}">${active ? esc(active.username) : 'ندارید'}</b></div>
          <div class="ov-kv"><span>پروفایل‌های خودتان</span><b>${P.loaded ? (own ? fa(own) + ' پروفایل' : 'هنوز هیچ') : '—'}</b></div>
          ${!active && P.loaded ? `
          <div class="ov-card-act"><button type="button" class="mv-btn mv-btn--sm" data-ov-act="add-account"><i class="ph-bold ph-plus"></i>افزودن حساب TunnelBear</button></div>` : ''}
        </div>
        <div class="mv-eng-card2-foot">${active && active.auth === 'failed'
            ? '<b style="color:var(--mv-red-ink)">سرور TunnelBear حساب انتخاب‌شده را نپذیرفت.</b> رمز را در «حساب‌ها» بررسی کنید.'
            : 'سرورهای TunnelBear با حساب خودتان وصل می‌شوند؛ پروفایل‌های خودتان را از «پروفایل‌های من» اضافه کنید.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-gray)">
        <button type="button" class="mv-eng-card2-head" data-ov-go="log">
          <span class="mv-eng-glyph"><i class="ph-fill ph-terminal-window"></i></span>
          <h3>گزارش</h3>
          <span class="mv-eng-card2-end">${st.log.length ? fa(st.log.length) + ' خط' : '—'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          <div class="ov-card-line" dir="ltr" style="font-family:var(--mv-font-mono);font-size:11px">${lastLog ? esc(lastLog) : '<span dir="rtl" style="font-family:var(--mv-font)">هنوز چیزی ثبت نشده.</span>'}</div>
        </div>
        <div class="mv-eng-card2-foot">وقتی اتصال نگیرد، این تنها جایی است که می‌گوید دقیقاً کجا ایستاد.</div>
      </div>`;
    }

    /** Rows we could not dial at all, because we have never seen their OpenVPN port. */
    function noPort(host) {
        const r = st.mine.find(x => x.host === host) || st.archive.find(x => x.host === host);
        return !!r && r.ovpnKnown === false;
    }

    /** The one line that says what we know about a relay, test first. */
    function resultWords(host) {
        const p = st.probes[host];
        if (p && p.ok) return `تست واقعی: ${probeBand(p.ms).word} · <span class="ov-num">${fa(p.ms)}ms</span>`;
        if (p) return `تست واقعی: ${PROBE_FAIL[p.reason] || 'رد شد'}`;
        const g = st.pings[host];
        if (g > 0) return `پینگ <span class="ov-num">${fa(g)}ms</span>`;
        if (g !== undefined) return 'بی‌پاسخ';
        if (noPort(host)) return 'پورتش را نمی‌دانیم';
        return '';
    }

    // ── the servers page ───────────────────────────────────────────────────

    const sweep = () => (st.payload && st.payload.status && st.payload.status.sweep) || null;

    /** The rows the list is showing right now, after scope, country, search and sort. */
    function visible() {
        const pool = st.scope === 'mine' ? st.mine : st.archive;
        const q = st.query.trim().toLowerCase();
        return pool.filter((r) => {
            if (st.countries.length && !has(st.countries, r.cc)) return false;
            if (!q) return true;
            // The four things people actually type on this screen: «آلمان», "Germany", "DE",
            // "vpn847263841". All four have been on the row in front of them.
            return countryName(r.cc).toLowerCase().indexOf(q) >= 0
                || String(r.country).toLowerCase().indexOf(q) >= 0
                || String(r.cc).toLowerCase().indexOf(q) >= 0
                || String(r.host).toLowerCase().indexOf(q) >= 0;
        }).sort(sorter(st.sort));
    }

    /**
     * «خراب» means a test CONDEMNED it, never merely that it is untested — otherwise the first
     * press of «حذف خراب‌ها» would wipe a fresh list. Both tests count: whichever the user ran is
     * the one holding the evidence.
     */
    function deadOf(rows) {
        return rows.filter((r) => {
            const p = st.probes[r.host];
            if (p) return p.ok === false;
            const g = st.pings[r.host];
            return g !== undefined && !(g > 0);
        }).map(r => r.host);
    }

    /** Passed the real test — or, only if nothing has been probed, answered a ping. */
    function healthyOf(rows) {
        const proven = rows.filter(r => st.probes[r.host] && st.probes[r.host].ok).map(r => r.host);
        if (proven.length) return proven;
        return rows.filter(r => (st.pings[r.host] || 0) > 0).map(r => r.host);
    }

    const summaryText = (rows) => `${fa(rows.length)} از ${fa(st.scope === 'mine' ? st.mine.length : st.archive.length)} سرور · ${(SORTS.find(x => x.id === st.sort) || {}).label || ''}`;

    function renderTools() {
        const host = $('ov-tools');
        if (!host) return;
        const p = st.payload || {};
        const sw = sweep();
        const rows = visible();
        const busy = st.busy || !!sw;
        // The relays a test has CONDEMNED — refused, unreachable, TLS blocked, timed out, or a
        // ping that came back with nothing. Counted here so the button can say how many it is
        // about to remove and disappear when there are none.
        const dead = deadOf(rows);

        host.innerHTML = `
      <div class="ov-bar1">
        <label class="mv-search">
          <i class="ph ph-magnifying-glass"></i>
          <input type="search" class="mv-field" id="ov-q" placeholder="جست‌وجوی کشور یا نام سرور" spellcheck="false" value="${esc(st.query)}">
          ${st.query ? '<button type="button" id="ov-q-clear" aria-label="پاک کردن"><i class="ph-bold ph-x"></i></button>' : ''}
        </label>
        <div class="mv-seg" role="tablist" aria-label="کدام فهرست">
          <button type="button" role="tab" data-ov-scope="mine" aria-pressed="${st.scope === 'mine'}">فهرست من · ${fa(st.mine.length)}</button>
          <button type="button" role="tab" data-ov-scope="archive" aria-pressed="${st.scope === 'archive'}">آرشیو · ${fa(st.archive.length)}</button>
        </div>
      </div>

      <div class="ov-tb">
        <button type="button" data-ov-act="refresh" ${busy ? 'disabled' : ''} title="${p.canRefresh ? 'گرفتن فهرست تازه' : 'اول یک حساب کلادفلر اضافه کنید یا یکی از تونل‌های برنامه را روشن کنید'}">
          <i class="${st.busy ? 'mv-spin-ring' : 'ph-bold ph-arrows-clockwise'}"></i>به‌روز</button>
        ${sw ? `<button type="button" data-ov-act="stop" class="is-stop"><i class="ph-bold ph-stop-circle"></i>توقف تست</button>`
            : `<button type="button" data-ov-act="ping" ${busy || !rows.length ? 'disabled' : ''} title="فقط زمان رسیدن بسته به سرور"><i class="ph-bold ph-gauge"></i>پینگ</button>
        <button type="button" data-ov-act="probe" class="is-go" ${busy || !rows.length ? 'disabled' : ''} title="یک اتصال کامل OpenVPN به هر سرور — تنها تستی که می‌گوید وصل می‌شود"><i class="ph-bold ph-pulse"></i>تست واقعی</button>`}
        <span class="ov-tb-sep"></span>
        <button type="button" data-ov-go="countries" aria-pressed="${st.countries.length > 0}"><i class="ph-bold ph-globe-hemisphere-west"></i>کشور${st.countries.length ? ' · ' + fa(st.countries.length) : ''}</button>
        <button type="button" data-ov-go="sort" aria-pressed="${st.sort !== 'verified'}"><i class="ph-bold ph-sort-ascending"></i>مرتب‌سازی</button>
        <button type="button" data-ov-act="select" aria-pressed="${st.selecting}"><i class="ph-bold ph-check-square"></i>انتخاب</button>
        ${dead.length ? `<button type="button" data-ov-act="remove-dead" class="is-bad" ${busy ? 'disabled' : ''}
                title="سرورهایی که در تست رد شدند یا جواب ندادند"><i class="ph-bold ph-trash"></i>حذف خراب‌ها · ${fa(dead.length)}</button>` : ''}
      </div>

      ${sw ? `
      <div class="ov-sweep">
        <i class="mv-spin-ring"></i>
        <span>${sw.kind === 'probe' ? 'تست واقعی' : 'پینگ'} — ${fa(sw.done)} از ${fa(sw.total)}</span>
        <span class="ov-bar"><i style="width:${sw.total ? Math.round(sw.done / sw.total * 100) : 0}%"></i></span>
        <span class="ov-num">${fa(sw.total ? Math.round(sw.done / sw.total * 100) : 0)}٪</span>
      </div>` : ''}

      ${st.selecting ? renderBulk(rows) : ''}

      <div class="ov-summary">
        <span>${summaryText(rows)}</span>
        ${dead.length ? `<span>· ${fa(dead.length)} سرور در تست رد شده</span>` : ''}
        ${st.countries.length ? `<button type="button" data-ov-act="clear-countries"><i class="ph-bold ph-x"></i> برداشتن فیلتر کشور (${fa(st.countries.length)})</button>` : ''}
      </div>`;
    }

    function renderBulk(rows) {
        const dead = deadOf(rows);
        const healthy = healthyOf(rows);
        const n = st.checked.length;
        return `
      <div class="ov-bulk">
        <b>${n ? fa(n) + ' سرور انتخاب شده' : 'روی سرورها بزنید تا تیک بخورند'}</b>
        <div class="ov-tb">
          <button type="button" data-ov-act="check-healthy" ${healthy.length ? '' : 'disabled'}><i class="ph-bold ph-check-circle"></i>سالم‌ها (${fa(healthy.length)})</button>
          ${st.scope === 'archive'
                ? `<button type="button" data-ov-act="keep" ${n ? '' : 'disabled'}><i class="ph-bold ph-bookmark-simple"></i>افزودن به فهرست من</button>`
                : `<button type="button" data-ov-act="drop" ${n ? '' : 'disabled'}><i class="ph-bold ph-bookmark-simple"></i>برداشتن از فهرست من</button>`}
          <button type="button" data-ov-act="remove-checked" class="is-bad" ${n ? '' : 'disabled'}><i class="ph-bold ph-trash"></i>حذف (${fa(n)})</button>
          <button type="button" data-ov-act="remove-dead" class="is-bad" ${dead.length ? '' : 'disabled'}>حذف سرورهای قطع (${fa(dead.length)})</button>
        </div>
      </div>`;
    }

    /** The table's sortable columns: the header a person clicks → the sort it means. */
    const COLS = { server: 'country', speed: 'speed', sess: 'sessions', score: 'score', result: 'verified' };

    function th(key, label, cls) {
        const sortId = COLS[key];
        const on = st.sort === sortId;
        return `<th class="${cls || ''}${on ? ' is-sorted' : ''}" data-sortcol="${sortId}" title="مرتب‌سازی بر اساس ${label}">${label}${on ? '<i class="ph-bold ph-caret-down ov-arrow"></i>' : ''}</th>`;
    }

    function renderServers() {
        const host = $('ov-servers');
        if (!host) return;
        const s = status();
        const rows = visible();
        const note = $('ov-list-note');

        if (note) {
            note.innerHTML = st.scope === 'mine'
                ? 'همان فهرستی که دکمهٔ اتصال از آن انتخاب می‌کند: سرورهای زندهٔ همین حالا، به‌علاوهٔ هرچه خودتان از آرشیو اضافه کرده‌اید، منهای هرچه حذف کرده‌اید. روی یک سرور بزنید تا مقصد اتصال شود.'
                : 'هر سروری که برنامه تا امروز دیده. با هر «به‌روز» بزرگ‌تر می‌شود. سروری که از اینجا انتخاب کنید خودش به «فهرست من» هم اضافه می‌شود.';
        }

        if (!rows.length) {
            host.innerHTML = `<div class="mv-empty"><i class="ph ph-globe-hemisphere-west mv-empty-ic"></i><b>${emptyTitle()}</b><p>${emptyBody()}</p></div>`;
            return;
        }

        const locked = st.busy || s.connecting;
        const aimed = st.target.kind === 'gate';
        host.innerHTML = `
      <div class="mv-table-wrap">
        <table class="mv-table ov-table">
          <thead><tr>
            <th class="ov-c-mark"></th>
            ${th('server', 'سرور')}
            ${th('speed', 'پهنای باند', 'ov-c-speed')}
            ${th('sess', 'نشست', 'ov-c-sess')}
            ${th('score', 'امتیاز', 'ov-c-score')}
            ${th('result', 'نتیجه')}
            <th class="ov-c-act"></th>
          </tr></thead>
          <tbody>${rows.map((r) => {
            const on = aimed && st.selected === r.host;
            const live = isLive('gate', r.host);
            const checked = has(st.checked, r.host);
            const mark = st.selecting
                ? `<span class="ov-mark${checked ? ' is-on' : ''}"><i class="${checked ? 'ph-fill ph-check-square' : 'ph ph-square'}"></i></span>`
                : live ? '<span class="ov-mark is-live" title="همین حالا وصل است"><i class="ph-fill ph-check-circle"></i></span>'
                    : (st.scope === 'archive' && has(st.kept, r.host))
                        ? '<span class="ov-mark is-on" title="در فهرست من"><i class="ph-fill ph-bookmark-simple"></i></span>'
                        : `<span class="ov-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>`;
            return `
            <tr class="ov-tr${live ? ' is-on' : on ? ' is-sel' : ''}${locked ? ' is-locked' : ''}" data-host="${esc(r.host)}" tabindex="0"
                role="${st.selecting ? 'checkbox' : 'radio'}" aria-checked="${st.selecting ? checked : on}">
              <td class="ov-c-mark">${mark}</td>
              <td>
                <span class="ov-srv">${flag(r.cc, 22)}
                  <span class="ov-srv-t">
                    <b>${esc(countryName(r.cc) || r.country)}${r.official ? '<span class="ov-pill is-tag">رسمی</span>' : ''}</b>
                    ${live ? '<small class="is-live">همین حالا وصل است</small>' : `<small dir="ltr">${esc(shortName(r.host))}</small>`}
                  </span>
                </span>
              </td>
              <td class="ov-c-num ov-c-speed">${fa(r.speedMbps)} مگابیت</td>
              <td class="ov-c-num ov-c-sess">${fa(r.sessions)}</td>
              <td class="ov-c-num ov-c-score">${fa(r.score)}</td>
              <td>${badgeFor(r.host)}</td>
              <td class="ov-c-act"><button type="button" class="mv-btn mv-btn--icon mv-btn--sm" data-detail="${esc(r.host)}" title="صفحهٔ این سرور" aria-label="صفحهٔ این سرور"><i class="ph-bold ph-info"></i></button></td>
            </tr>`;
        }).join('')}</tbody>
        </table>
      </div>`;
    }

    function badgeFor(host) {
        const p = st.probes[host];
        if (p && p.ok) {
            const b = probeBand(p.ms);
            return `<span class="ov-pill is-${b.tone}">${b.word}</span>`;
        }
        if (p) return `<span class="ov-pill is-bad">${PROBE_FAIL[p.reason] || 'رد شد'}</span>`;
        const g = st.pings[host];
        if (g > 0) return `<span class="ov-pill ov-num">${fa(g)}ms</span>`;
        if (g !== undefined) return '<span class="ov-pill is-bad">بی‌پاسخ</span>';
        // NOT «تست نشده» and never «رد شد»: we have no profile for this relay, so no port to
        // knock on. A guess at 443 is what made hundreds of working volunteer relays look dead.
        if (noPort(host)) return '<span class="ov-pill" title="پورت OpenVPN این سرور را نداریم. «به‌روز» پورت هر سرور را می‌آورد.">پورت نامعلوم</span>';
        return '<span class="ov-pill">تست نشده</span>';
    }

    function emptyTitle() {
        if (st.query || st.countries.length) return 'چیزی پیدا نشد';
        return st.scope === 'mine' ? 'فهرست خالی است' : 'آرشیو خالی است';
    }
    function emptyBody() {
        if (st.query) return `هیچ سروری با «${esc(st.query)}» جور در نیامد. جست‌وجو را پاک کنید یا کشور دیگری بزنید.`;
        if (st.countries.length) return 'در این کشورها سروری نیست. فیلتر کشور را بردارید، یا در «آرشیو» بگردید که ' + fa(st.archive.length) + ' سرور دارد.';
        return st.scope === 'mine'
            ? 'هنوز سروری ندارید. «به‌روز» را بزنید تا فهرست تازه گرفته شود، یا از «آرشیو» چندتا اضافه کنید.'
            : 'آرشیو با هر بار به‌روزرسانی پر می‌شود. دکمهٔ «به‌روز» بالا را بزنید.';
    }

    // ── countries ──────────────────────────────────────────────────────────

    function renderCountries() {
        const host = $('ov-countries');
        if (!host) return;
        const pool = st.scope === 'mine' ? st.mine : st.archive;
        const counts = new Map();
        for (const r of pool) counts.set(r.cc, (counts.get(r.cc) || 0) + 1);
        const list = [...counts.entries()]
            .map(([cc, n]) => ({ cc, n, name: countryName(cc) }))
            .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'fa'));

        const tools = $('ov-country-tools');
        if (tools) {
            tools.innerHTML = `
        <div class="ov-bar1">
          <div class="ov-summary" style="margin:0">${fa(list.length)} کشور در ${st.scope === 'mine' ? 'فهرست من' : 'آرشیو'} · ${st.countries.length ? fa(st.countries.length) + ' کشور انتخاب شده' : 'بدون فیلتر'}</div>
          <div class="ov-tb" style="margin-inline-start:auto">
            <button type="button" data-ov-act="clear-countries" ${st.countries.length ? '' : 'disabled'}><i class="ph-bold ph-x"></i>همهٔ کشورها</button>
            <button type="button" data-ov-go="servers" class="is-go"><i class="ph-bold ph-check"></i>نمایش سرورها</button>
          </div>
        </div>`;
        }

        host.innerHTML = list.map((c) => {
            const on = has(st.countries, c.cc);
            return `
        <button type="button" class="mv-li${on ? ' is-sel' : ''}" data-cc="${esc(c.cc)}" role="checkbox" aria-checked="${on}">
          <span class="mv-li-lead"><span class="ov-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-square' : 'ph ph-square'}"></i></span></span>
          ${flag(c.cc, 22)}
          <span class="mv-li-text"><b>${esc(c.name)}</b></span>
          <span class="mv-li-num">${fa(c.n)}</span>
        </button>`;
        }).join('');
    }

    // ── sort ───────────────────────────────────────────────────────────────

    function renderSorts() {
        const host = $('ov-sorts');
        if (!host) return;
        host.innerHTML = SORTS.map((x) => {
            const on = st.sort === x.id;
            return `
      <button type="button" class="mv-form-row is-action" data-sort="${x.id}" role="radio" aria-checked="${on}">
        <span class="mv-row-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>
        <span class="mv-form-label">${esc(x.label)}<small>${esc(x.detail)}</small></span>
      </button>`;
        }).join('');
    }

    // ── one server's page ──────────────────────────────────────────────────

    function renderDetail() {
        const host = $('ov-detail');
        if (!host) return;
        const r = st.mine.find(x => x.host === st.detailHost)
            || st.archive.find(x => x.host === st.detailHost);
        if (!r) {
            // The row it was opened from has been deleted underneath it.
            host.innerHTML = '';
            if (ovSec === 'detail') ovGoSec('servers');
            return;
        }
        const p = st.probes[r.host];
        const g = st.pings[r.host];
        const kept = has(st.kept, r.host);
        const isSel = st.target.kind === 'gate' && st.selected === r.host;
        const live = isLive('gate', r.host);

        // .mv-form-value, not .mv-row-end: the latter is the kit's 18px icon slot, and a value set in
        // it came out larger and greyer than its own label.
        const kv = (k, v) => `<div class="mv-form-row"><span class="mv-form-label">${k}</span><span class="mv-form-value ov-val" dir="auto">${v}</span></div>`;

        host.innerHTML = `
    <div class="ov-dhead">
      ${flag(r.cc, 48)}
      <div>
        <h2>${esc(countryName(r.cc) || r.country)}</h2>
        <p><code>${esc(shortName(r.host))}</code>${r.official ? '<span class="ov-pill is-tag">رسمی</span>' : '<span class="ov-pill is-tag">داوطلبانه</span>'}${badgeFor(r.host)}${live ? '<span class="ov-pill is-ok">وصل است</span>' : ''}</p>
      </div>
      <div class="ov-dhead-act">
        <button type="button" class="mv-btn${isSel ? '' : ' mv-btn--primary'}" data-ov-act="detail-select" ${isSel ? 'disabled' : ''}><i class="${isSel ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>${isSel ? 'مقصد اتصال است' : 'انتخاب برای اتصال'}</button>
        <button type="button" class="mv-btn" data-ov-act="detail-keep"><i class="${kept ? 'ph-fill' : 'ph-bold'} ph-bookmark-simple"></i>${kept ? 'برداشتن از فهرست من' : 'افزودن به فهرست من'}</button>
        <button type="button" class="mv-btn mv-btn--danger" data-ov-act="detail-remove"><i class="ph-bold ph-trash"></i>حذف این سرور</button>
      </div>
    </div>
    <div class="mv-form">
      <div class="mv-form-section">
        <div class="mv-form-header">اندازه‌گیری روی خط شما</div>
        <div class="mv-form-group">
          ${kv('پینگ', g === undefined ? 'تست نشده' : g > 0 ? `<span class="ov-num">${fa(g)}ms</span>` : '<span style="color:var(--mv-orange-ink)">بی‌پاسخ</span>')}
          ${kv('تست واقعی', !p ? 'تست نشده'
                : p.ok ? `<span style="color:var(--mv-green-ink)">${probeBand(p.ms).word} · <span class="ov-num">${fa(p.ms)}ms</span></span>`
                    : `<span style="color:var(--mv-red-ink)">${PROBE_FAIL[p.reason] || 'رد شد'}</span>`)}
          ${p && p.at ? kv('زمان تست', esc(ago(p.at))) : ''}
        </div>
        <div class="mv-form-footer">پینگ فقط می‌گوید بسته چقدر طول می‌کشد به سرور برسد. «تست واقعی» دست‌دادن کامل را با سرور انجام می‌دهد؛ نتیجهٔ سبزش یعنی این سرور روی خط اینترنت شما واقعاً وصل می‌شود.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">خود سرور</div>
        <div class="mv-form-group">
          ${kv('نوع', r.official ? 'رسمی — روی زیرساخت خود سرویس' : 'داوطلبانه — روی خط خانگی یک نفر')}
          ${kv('کشور', esc(countryName(r.cc)) + ' · <code>' + esc(r.cc) + '</code>')}
          ${kv('امتیاز VPN Gate', `<span class="ov-num">${fa(r.score)}</span>`)}
          ${kv('پهنای باند اعلامی', `<span class="ov-num">${fa(r.speedMbps)}</span> مگابیت`)}
          ${kv('مدت روشن بودن', esc(uptimeText(r.uptimeMs)))}
          ${kv('نشست‌های فعال', fa(r.sessions))}
          ${kv('سیاست نگهداری لاگ', logPolicy(r.logType))}
          ${r.operator ? kv('گردانندهٔ سرور', esc(r.operator)) : ''}
          ${kv('نام میزبان', `<code dir="ltr">${esc(r.host)}</code>`)}
          ${kv('نشانی', `<code dir="ltr">${esc(r.ip)}</code>`)}
        </div>
        <div class="mv-form-footer">${r.official
            ? 'این سرور روی زیرساخت خود سرویس اجرا می‌شود؛ معمولاً پایدارتر است و پورتش کمتر بسته می‌شود.'
            : 'این سرور را یک داوطلب روی خط خانگی‌اش به اشتراک گذاشته. ممکن است هر لحظه خاموش شود.'}</div>
      </div>

      ${r.message ? `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">پیام گردانندهٔ سرور</div>
        <div class="mv-form-group"><div class="mv-form-row is-stack"><span class="mv-form-label" dir="auto" style="white-space:pre-wrap">${esc(r.message)}</span></div></div>
      </div>` : ''}
    </div>`;
    }

    // ── the guide ──────────────────────────────────────────────────────────

    function renderGuide() {
        const host = $('ov-guide');
        if (!host || host.dataset.built === '1') return;
        host.dataset.built = '1';
        const para = (icon, tint, title, body) => `
      <div class="mv-form-row is-stack">
        <span class="mv-form-label"><span class="mv-side-tile" style="--tint:${tint};width:22px;height:22px;display:inline-grid;vertical-align:-5px;margin-inline-end:7px"><i class="${icon}"></i></span>${title}<small>${body}</small></span>
      </div>`;

        host.innerHTML = `
    <div class="mv-form">
      <div class="mv-form-section">
        <div class="mv-form-header">سه منبع، یک دکمه</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-globe-hemisphere-west', 'var(--mv-indigo)', 'سرورهای عمومی',
            'هزاران سرور داوطلبانهٔ VPN Gate، بدون حساب و بدون هزینه.')}
          ${para('ph-fill ph-paw-print', 'var(--mv-orange)', 'TunnelBear',
            'چهل‌وهفت کشور TunnelBear، با حساب خودتان (بخش «حساب‌ها»).')}
          ${para('ph-fill ph-file-text', 'var(--mv-teal)', 'پروفایل‌های من',
            'فایل‌های .ovpn خودتان، همراه با گواهی و کلیدشان.')}
        </div>
        <div class="mv-form-footer">در هر فهرست روی یک ردیف بزنید تا «مقصد اتصال» شود؛ بعد دکمهٔ بزرگ صفحهٔ «اتصال» یا دکمهٔ «اتصال» بالای هر صفحه به همان وصل می‌شود. ردیف سبز یعنی همین حالا وصل است، ردیف آبی یعنی انتخاب شده.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">دو فهرست</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-list-checks', 'var(--mv-blue)', 'فهرست من',
            'همان فهرستی است که دکمهٔ اتصال از آن انتخاب می‌کند. سروری که به آن اضافه کنید حتی بعد از اینکه VPN Gate از فهرست عمومی برش دارد هم می‌ماند.')}
          ${para('ph-fill ph-archive', 'var(--mv-indigo)', 'آرشیو',
            'برنامه هر سروری را که تا امروز دیده در یک آرشیو نگه می‌دارد، پس آرشیو شما معمولاً خیلی بزرگ‌تر از تعداد سرورهای زندهٔ همین لحظه است.')}
        </div>
        <div class="mv-form-footer">این سرورها را داوطلب‌هایی از سراسر دنیا به اشتراک می‌گذارند و مدام کم و زیاد می‌شوند.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">دو تست</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-gauge', 'var(--mv-gray)', 'پینگ',
            'فقط اندازه می‌گیرد بستهٔ شما چقدر طول می‌کشد به سرور برسد. سریع است ولی تضمین نمی‌کند اتصال برقرار شود.')}
          ${para('ph-fill ph-pulse', 'var(--mv-green)', 'تست واقعی',
            'یک اتصال <b>کاملِ OpenVPN</b> به سرور می‌زند — تا جایی که هستهٔ برنامه بگوید تونل بالا آمد — و بعد رهایش می‌کند. آداپتور شما دست نمی‌خورد و اینترنتتان قطع نمی‌شود. نتیجهٔ سبزش یعنی این سرور با <b>همین موتور</b> روی <b>همین خط</b> واقعاً وصل می‌شود؛ هیچ تست دیگری این را نمی‌گوید.')}
        </div>
        <div class="mv-form-footer">نتیجهٔ «تست واقعی» به‌صورت سریع / متوسط / کند کنار هر سرور نشان داده می‌شود. عدد دقیقش را در صفحهٔ خود سرور می‌بینید. اگر سروری پینگ خوبی می‌دهد ولی وصل نمی‌شود، این تست علتش را نشان می‌دهد.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">اتصال مستقیم — و چرا یک رلهٔ محلی</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-arrow-bend-double-up-right', 'var(--mv-orange)', 'فیلتر شکل دست‌دادن OpenVPN را می‌شناسد',
            'روی خط ایران، اتصال TCP به سرور برقرار می‌شود و گواهی سرور هم می‌رسد، ولی بعد اتصال قطع می‌شود. سرور سالم است و پورت باز؛ چیزی که فیلتر می‌شناسد <b>شکل رکوردهای اول</b> است، نه شمارهٔ پورت.')}
          ${para('ph-fill ph-shield-check', 'var(--mv-green)', 'رلهٔ محلی: مستقیم، بدون تونل دوم',
            'برنامه روی خود کامپیوتر شما یک رلهٔ کوچک باز می‌کند؛ OpenVPN به آن وصل می‌شود و رله <b>خودش مستقیم</b> به سرور وصل می‌شود و ۶ کیلوبایت اول را به تکه‌های کوچک و نامنظم می‌برد. همان روشی است که اندروید با آن سرورهای TunnelBear را وصل می‌کند.<br><br>اندازه‌گیری روی خط ایران (یک سرور رسمی VPN Gate، هر کدام دو بار): رلهٔ ساده که بایت‌ها را همان‌طور رد می‌کند — <b>هر دو بار قطع شد</b>؛ رلهٔ تکه‌تکه‌کننده — <b>هر دو بار در حدود ۵ ثانیه وصل شد</b>. هیچ سایفون یا موتور دیگری روشن نمی‌شود.')}
        </div>
        <div class="mv-form-footer">سرورهای UDP از این رله رد نمی‌شوند (رله TCP است)؛ از ایران تقریباً همهٔ پورت‌های UDP سرورهای VPN Gate بسته اندازه گرفته شده‌اند، پس سرورهای TCP را ترجیح دهید.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">کنترل‌های فهرست سرورهای عمومی</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-globe-hemisphere-west', 'var(--mv-blue)', 'کشور',
            'فهرست را به یک یا چند کشور محدود می‌کند. می‌توانید چند کشور را با هم انتخاب کنید — مثلاً برای اینکه یک قاره را یک‌جا تست بگیرید.')}
          ${para('ph-fill ph-sort-ascending', 'var(--mv-orange)', 'مرتب‌سازی',
            'ترتیب فقط روی نمایش اثر دارد؛ هیچ سروری با آن حذف یا اضافه نمی‌شود. پیش‌فرض روی «تست‌شده‌ها اول» است. سرستون‌های جدول هم همین کار را می‌کنند.')}
          ${para('ph-fill ph-check-square', 'var(--mv-indigo)', 'انتخاب',
            'با دکمهٔ «انتخاب» چند سرور را با هم تیک می‌زنید تا یک‌جا به فهرستتان اضافه یا از آن حذف شوند.')}
          ${para('ph-fill ph-trash', 'var(--mv-red)', 'حذف سرورهای قطع',
            'فقط سرورهایی را پاک می‌کند که تست شده‌اند و پاسخ نداده‌اند. سرورهای تست‌نشده هرگز حذف نمی‌شوند. هرچه حذف شود از صفحهٔ «اتصال» برمی‌گردد.')}
        </div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">پیشنهاد</div>
        <div class="mv-form-group">
          <div class="mv-form-row is-stack"><span class="mv-form-label">اولین بار «تست واقعی» را روی «فهرست من» بزنید و چند دقیقه صبر کنید، بعد اولین سرور سبز را انتخاب کنید. اگر <b>هیچ‌کدام</b> سبز نشد، «به‌روز» را بزنید تا فهرست و پورت سرورها تازه شود و دوباره تست بگیرید؛ اگر باز هم نشد، به «آرشیو» بروید، یک کشور نزدیک را انتخاب کنید و همان تست را آنجا بگیرید — یا TunnelBear را با حساب خودتان امتحان کنید.</span></div>
        </div>
      </div>
    </div>`;
    }

    // ── the strip along the bottom, and the compact button in the title band ──

    function renderBar() {
        const host = $('ov-foot');
        if (!host) return;
        const v = ovView();
        const s = v.s;
        const sw = sweep();
        const word = sw ? `${sw.kind === 'probe' ? 'تست واقعی' : 'پینگ'} — ${fa(sw.done)} از ${fa(sw.total)}`
            : s.connected ? 'وصل — تونل کامل سیستم'
                : s.connecting ? 'در حال برقراری نشست'
                    : !s.installed ? 'هستهٔ OpenVPN نصب نیست'
                        : targetInfo().ok ? 'آمادهٔ اتصال' : 'مقصدی انتخاب نشده';
        const t = s.connected || s.connecting ? Object.assign(liveName(), { src: null }) : targetInfo();
        const name = t.name || '';
        host.innerHTML = `
      ${ovDot(sw ? 'busy' : v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end">${name ? `${t.cc ? flag(t.cc, 16) : ''}<span>${esc(name)}</span>` : '<span>—</span>'}</span>`;
    }

    /** One connect button is visible at any moment: the hero's, or this one — never both. */
    function renderBarAction() {
        const host = $('ov-bar-action');
        if (!host) return;
        if (ovSec === 'connect') { if (host.innerHTML) host.innerHTML = ''; return; }
        const v = ovView();
        const t = targetInfo();
        let html;
        if (v.act === 'off') {
            html = `<button type="button" class="mv-btn" data-ov-act="power"><i class="${v.s.connecting ? 'mv-spin-ring' : 'ph-bold ph-power'}"></i>${v.s.connecting ? 'لغو' : 'قطع'}</button>`;
        } else {
            html = `<button type="button" class="mv-btn mv-btn--primary" data-ov-act="power" ${v.act && !st.busy ? '' : 'disabled'}
                      title="${esc(t.ok ? 'اتصال به ' + t.name : (t.why || 'اول یک مقصد انتخاب کنید'))}">
                      <i class="${st.busy ? 'mv-spin-ring' : 'ph-bold ph-power'}"></i>اتصال${t.ok ? ' به ' + esc(t.name.split(' · ')[0]) : ''}</button>`;
        }
        if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
    }

    function renderLog() {
        const pre = $('ov-log');
        if (!pre) return;
        pre.textContent = st.log.length ? st.log.join('\n') : 'هنوز چیزی ثبت نشده.';
        pre.scrollTop = pre.scrollHeight;
    }

    function renderSnack() {
        const host = $('ov-snack');
        if (!host) return;
        const show = st.snack && (Date.now() - st.snackAt) < 2800;
        host.hidden = !show;
        host.innerHTML = show ? `<span>${esc(st.snack)}</span>` : '';
    }

    function say(msg) {
        st.snack = msg;
        st.snackAt = Date.now();
        renderSnack();
        setTimeout(() => { if (Date.now() - st.snackAt >= 2800) { st.snack = ''; renderSnack(); } }, 2900);
    }

    // ── navigation ─────────────────────────────────────────────────────────

    function ovGoSec(id) {
        const wrap = $('ov-wrap');
        if (!wrap) return;
        const known = !!SECTION_OF[id] || Object.prototype.hasOwnProperty.call(SUB, id);
        ovSec = known ? id : 'connect';
        wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === ovSec));
        // A sub-page keeps «سرورهای عمومی» lit in the sidebar: the user is still inside the list,
        // they have merely opened one of its decisions.
        const lit = Object.prototype.hasOwnProperty.call(SUB, ovSec) ? 'servers' : ovSec;
        wrap.querySelectorAll('.mv-side-item[data-ov-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-ov-sec') === lit));
        const found = SECTION_OF[ovSec];
        const title = $('ov-pane-title');
        if (title) title.textContent = found ? found.label : (SUB[ovSec] || '');
        const back = $('ov-back');
        if (back) back.disabled = ovSec === 'connect';
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', ovSec === 'connect');
        const sc = $('ov-scroll');
        if (sc) sc.scrollTop = 0;
        paint();
    }

    /** The back button: a sub-page returns to the list it belongs to, the list to the hero. */
    function goBack() {
        ovGoSec(Object.prototype.hasOwnProperty.call(SUB, ovSec) ? 'servers' : 'connect');
    }

    // ── wiring ─────────────────────────────────────────────────────────────

    function ovWire() {
        const wrap = $('ov-wrap');
        if (!wrap) return;

        wrap.querySelectorAll('[data-ov-go]').forEach((b) => {
            b.onclick = () => ovGoSec(b.getAttribute('data-ov-go'));
        });
        wrap.querySelectorAll('[data-ov-act]').forEach((b) => { b.onclick = () => act(b.getAttribute('data-ov-act')); });
        wrap.querySelectorAll('[data-ov-scope]').forEach((b) => {
            b.onclick = () => {
                st.scope = b.getAttribute('data-ov-scope');
                st.selecting = false; st.checked = [];
                paint();
            };
        });
        wrap.querySelectorAll('[data-ov-kind]').forEach((b) => {
            b.onclick = () => {
                const kind = b.getAttribute('data-ov-kind');
                if (kind === st.target.kind) return;
                // The source's own last choice comes back with it, so flipping between the three
                // does not throw anybody's selection away.
                const mem = st.target.kind === 'gate' ? null : st.target.id;
                st.lastIds = Object.assign({}, st.lastIds, mem ? { [st.target.kind]: mem } : {});
                st.target = { kind, id: kind === 'gate' ? null : ((st.lastIds || {})[kind] || null) };
                saveTarget();
                paint();
            };
        });
        wrap.querySelectorAll('[data-sort]').forEach((b) => {
            b.onclick = () => { st.sort = b.getAttribute('data-sort'); ovGoSec('servers'); };
        });
        wrap.querySelectorAll('th[data-sortcol]').forEach((b) => {
            b.onclick = () => { st.sort = b.getAttribute('data-sortcol'); paint(); };
        });
        wrap.querySelectorAll('[data-cc]').forEach((b) => {
            b.onclick = () => {
                const cc = b.getAttribute('data-cc');
                st.countries = has(st.countries, cc) ? without(st.countries, cc) : st.countries.concat([cc]);
                paint();
            };
        });
        wrap.querySelectorAll('[data-detail]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); st.detailHost = b.getAttribute('data-detail'); ovGoSec('detail'); };
        });
        wrap.querySelectorAll('tr.ov-tr[data-host]').forEach((b) => {
            const choose = () => {
                if (b.classList.contains('is-locked')) return;
                const h = b.getAttribute('data-host');
                if (st.selecting) {
                    st.checked = has(st.checked, h) ? without(st.checked, h) : st.checked.concat([h]);
                    paint();
                    return;
                }
                pick(h);
            };
            b.onclick = choose;
            // Double-click on a chosen server connects to it, the way a list works in Finder.
            b.ondblclick = () => { if (!st.selecting && !b.classList.contains('is-locked') && !status().connected) connectTarget(); };
            b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
        });

        const q = $('ov-q');
        if (q) {
            q.oninput = () => {
                st.query = q.value;
                // NOT paint(): that rebuilds the tool band, and rebuilding the band replaces the
                // input the user is typing into — the caret and the focus go with it, so the
                // second keystroke lands nowhere. Only the rows and the count change here.
                renderServers();
                const sum = wrap.querySelector('.ov-summary');
                const rows = visible();
                if (sum && sum.firstElementChild) sum.firstElementChild.textContent = summaryText(rows);
                // The rows are new DOM and carry no listeners of their own; without this a row
                // found by searching cannot be clicked, which is the one thing a search is for.
                ovWire();
            };
        }
        const qc = $('ov-q-clear');
        if (qc) qc.onclick = (e) => { e.preventDefault(); st.query = ''; paint(); };
    }

    function act(k) {
        switch (k) {
            case 'power': if (ovView().act) toggle(); break;
            case 'refresh': doRefreshList(); break;
            case 'ping': startTest('ping'); break;
            case 'probe': startTest('probe'); break;
            case 'stop': stopTest(); break;
            case 'select': st.selecting = !st.selecting; st.checked = []; paint(); break;
            case 'clear-countries': st.countries = []; paint(); break;
            case 'check-healthy': st.checked = healthyOf(visible()); paint(); break;
            case 'keep': curate('keep', st.checked); break;
            case 'drop': curate('drop', st.checked); break;
            case 'remove-checked': confirmRemove(st.checked); break;
            case 'remove-dead': confirmRemove(deadOf(visible())); break;
            case 'restore': curate('restore', []); break;
            case 'add-account': ovGoSec('accounts'); if (window.OvProfiles) OvProfiles.openAccountSheet(); break;
            case 'detail-select': pick(st.detailHost); ovGoSec('servers'); break;
            case 'detail-keep': curate(has(st.kept, st.detailHost) ? 'drop' : 'keep', [st.detailHost]); break;
            case 'detail-remove': confirmRemove([st.detailHost]); break;
            default: break;
        }
    }

    const PROFILE_SECS = { tunnelbear: 'ov-tunnelbear', profiles: 'ov-profiles', accounts: 'ov-accounts' };

    function paint() {
        if (!$('ov-wrap')) return;
        renderIdent();
        renderSideCounts();
        renderBar();
        renderBarAction();
        renderSnack();
        if (ovSec === 'connect') { renderHero(); renderDest(); renderCards(); }
        if (ovSec === 'servers') { renderTools(); renderServers(); }
        if (ovSec === 'countries') renderCountries();
        if (ovSec === 'sort') renderSorts();
        if (ovSec === 'detail') renderDetail();
        if (ovSec === 'guide') renderGuide();
        if (PROFILE_SECS[ovSec] && window.OvProfiles) {
            OvProfiles.render(ovSec, $(PROFILE_SECS[ovSec]), bridge, { profileId: status().profileId || null, connected: !!status().connected });
        }
        if (ovSec === 'log') renderLog();
        ovWire();
    }

    /** What openvpn-profiles.js may ask of this window. */
    const bridge = {
        say,
        go: (id) => ovGoSec(id),
        sheetHost: () => $('ov-sheet-host'),
        target: () => st.target,
        choose: (kind, id) => choose(kind, id),
        connectChosen: () => { if (!status().connected) connectTarget(); },
        connectFastest: () => doConnectProfile('fastest'),
        busy: () => st.busy || !!status().connecting,
        // The profiles arrived: the home page reads them («مقصد اتصال», the card), so it redraws.
        loaded: () => { if (ovSec === 'connect') paint(); else bridge.changed(); },
        // A profile page changed something the frame shows (a count, an account): redraw the frame
        // parts only — never the page it came from, which is under the user's fingers.
        changed: () => { renderSideCounts(); renderBar(); renderBarAction(); renderIdent(); },
    };

    // ── talking to the server ──────────────────────────────────────────────

    async function post(url, body) {
        const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('خطای ' + r.status));
        return j;
    }

    async function refresh() {
        let d;
        try {
            const r = await fetch('/api/openvpn/list');
            d = await r.json();
            if (!r.ok) return;
        } catch (e) { return; }

        st.payload = d;
        st.mine = d.mine || [];
        st.archive = d.archive || [];
        st.kept = d.kept || [];
        st.hidden = d.hidden || [];
        st.pings = d.pings || {};
        st.probes = d.probes || {};
        st.suggested = d.suggested || null;

        // The server's remembered choice wins; ours is only a fallback for a first-ever open, and
        // «the first row» is never the answer — that list is sorted by megabits measured in Japan.
        if (d.selected) st.selected = d.selected;
        else if (!st.selected && d.suggested) { st.selected = d.suggested; pick(d.suggested, true); }

        // Whatever is carrying traffic IS the destination — including a «سریع‌ترین» the server
        // picked. Otherwise the page would show one server connected and another chosen.
        const s = d.status || {};
        if (s.connected || s.connecting) {
            if (s.profileId) {
                const p = prof().profiles.find((x) => x.id === s.profileId);
                const kind = p ? (p.tunnelbear ? 'bear' : 'own') : st.target.kind;
                if (st.target.id !== s.profileId || st.target.kind !== kind) { st.target = { kind, id: s.profileId }; saveTarget(); }
            } else if (s.host && st.target.kind !== 'gate') { st.target = { kind: 'gate', id: null }; saveTarget(); }
        }

        paint();
    }

    function log(line) {
        st.log.push(line);
        if (st.log.length > 400) st.log = st.log.slice(-400);
        if (ovSec === 'log') renderLog();
        else if (ovSec === 'connect') renderCards();
    }

    async function pick(host, quiet) {
        if (!host) return;
        const was = status();
        st.selected = host;
        if (st.target.kind !== 'gate') { st.target = { kind: 'gate', id: null }; saveTarget(); }
        // A relay chosen out of the archive has to be kept as well, or the next refresh drops it
        // and the connect button holds a selection it cannot find.
        const inMine = st.mine.some(r => r.host === host);
        paint();
        try {
            await post('/api/openvpn/select', { host });
            if (!inMine) { await post('/api/openvpn/curate', { action: 'keep', hosts: [host] }); }
        } catch (e) { /* the choice still stands for this session */ }
        if (!quiet) {
            if (!inMine) say('به فهرست شما اضافه شد');
            // Switching relays while connected should MOVE the tunnel, not leave the user on the
            // old one with a new name on screen.
            if (was.connected && was.host !== host) { await doConnect(host); return; }
        }
        await refresh();
    }

    /**
     * A TunnelBear country or one of the user's own profiles was chosen on its page. Same rule as
     * a relay: while connected elsewhere, choosing MOVES the tunnel.
     */
    async function choose(kind, id) {
        const was = status();
        st.target = { kind, id };
        saveTarget();
        paint();
        if (was.connected && !isLive(kind, id) && targetInfo().ok) { await connectTarget(); }
    }

    async function toggle() {
        const s = status();
        if (s.connected || s.connecting) {
            st.busy = true; paint();
            try { await post('/api/openvpn/disconnect'); log('— قطع شد'); }
            catch (e) { log('✗ ' + e.message); }
            st.busy = false;
            await refresh();
            return;
        }
        await connectTarget();
    }

    /** Connect to whatever «مقصد اتصال» says, from whichever source it is. */
    async function connectTarget() {
        const t = targetInfo();
        if (!t.ok) { if (t.why) say(t.why); return; }
        if (t.kind === 'gate') return doConnect(t.id);
        return doConnectProfile(t.id);
    }

    async function doConnect(host) {
        if (!host) return;
        st.busy = true; st.log = []; paint();
        try { await post('/api/openvpn/connect', { host }); }
        catch (e) { log('✗ ' + e.message); say(e.message); }
        st.busy = false;
        await refresh();
    }

    async function doConnectProfile(id) {
        st.busy = true; st.log = []; paint();
        try {
            const r = await post('/api/openvpn/profiles/connect', { id });
            say('در حال اتصال به ' + ((r.place && r.place.name) || r.profile || ''));
        } catch (e) { log('✗ ' + e.message); say(e.message); }
        st.busy = false;
        if (window.OvProfiles) OvProfiles.refresh();
        await refresh();
    }

    async function doRefreshList() {
        st.busy = true; paint();
        try {
            const out = await post('/api/openvpn/refresh');
            const bits = [];
            bits.push(out.added ? fa(out.added) + ' سرور تازه' : 'سرور تازه‌ای نبود');
            if (out.portsKnown) bits.push('پورت ' + fa(out.portsKnown) + ' سرور معلوم شد');
            say(bits.join(' · '));
        } catch (e) { log('✗ ' + e.message); say(e.message); }
        st.busy = false;
        await refresh();
    }

    async function startTest(kind) {
        const rows = visible();
        if (!rows.length) return;
        const unknown = rows.filter(r => r.ovpnKnown === false).length;
        if (unknown === rows.length) {
            say('پورت OpenVPN این سرورها را نداریم — اول «به‌روز» را بزنید');
            return;
        }
        if (unknown) say(`${fa(rows.length - unknown)} سرور تست می‌شود؛ ${fa(unknown)} تا پورتشان معلوم نیست`);
        try {
            await post('/api/openvpn/test', { kind, hosts: rows.map(r => r.host) });
        } catch (e) { say(e.message); }
        await refresh();
    }

    async function stopTest() {
        try { await post('/api/openvpn/test/cancel'); } catch (e) { /* it may have just ended */ }
        await refresh();
    }

    async function curate(action, hosts) {
        try {
            const out = await post('/api/openvpn/curate', { action, hosts });
            if (action === 'keep') say(fa(out.n) + ' سرور به فهرست شما اضافه شد');
            else if (action === 'drop') say('از فهرست شما برداشته شد');
            else if (action === 'restore') say(fa(out.n) + ' سرور به فهرست برگشت');
            else say(fa(out.n) + ' سرور حذف شد');
        } catch (e) { say(e.message); }
        st.selecting = false; st.checked = [];
        await refresh();
    }

    /**
     * Deleting in bulk asks first, and says how many and from where.
     *
     * The scope decides which verb: from «فهرست من» a delete is a deny-list entry that survives
     * the next refresh (and is undoable from the connect page); from «آرشیو» the row itself goes.
     * Saying so is the difference between a deletion the user meant and one they will report as a
     * bug three days later.
     */
    function confirmRemove(hosts) {
        const list = (hosts || []).filter(Boolean);
        if (!list.length) return;
        const mine = st.scope === 'mine';
        const body = mine
            ? 'از فهرست شما پاک می‌شوند و دیگر برنمی‌گردند، حتی اگر VPN Gate دوباره منتشرشان کند. می‌توانید بعداً از «بازگرداندن حذف‌شده‌ها» در صفحهٔ اتصال برگردانیدشان.'
            : 'از آرشیو پاک می‌شوند. اگر VPN Gate دوباره منتشرشان کند، در به‌روزرسانی بعدی به‌عنوان سرور تازه برمی‌گردند.';
        const go = () => curate(mine ? 'hide' : 'purge', list);
        // The app's own dialog (ui-modal.js), not the browser's — a bare Windows box in the
        // middle of this window is the one surface that does not belong to the app.
        if (window.uiModal && uiModal.confirm) {
            uiModal.confirm({
                title: `حذف ${fa(list.length)} سرور؟`,
                message: body,
                confirmLabel: 'حذف',
                cancelLabel: 'انصراف',
                danger: true,
            }).then((yes) => { if (yes) go(); });
        } else if (window.confirm(`حذف ${fa(list.length)} سرور؟\n\n${body}`)) { go(); }
    }

    // ── pushed events ──────────────────────────────────────────────────────

    window.handleOpenVpnLog = function (d) {
        const line = typeof d === 'string' ? d : ((d && d.line) || '');
        if (/^\[اوپن‌وی‌پی‌ان\]/.test(line)) log(line.replace(/^\[اوپن‌وی‌پی‌ان\]\s*/, ''));
    };

    /**
     * The status the server pushes, which now carries the sweep's progress.
     *
     * Applied without a round trip so the progress bar moves at the rate the sweep reports rather
     * than at the 4-second poll's — and only the parts that changed are redrawn, because
     * re-rendering the list under a user who is scrolling it is its own bug.
     */
    window.handleOpenVpnEvent = function (s) {
        // A delay result for one of the user's own / TunnelBear profiles: that section only.
        if (s && s.profileProbe) { if (window.OvProfiles) window.OvProfiles.onEvent(s); return; }
        if (!s || !st.payload) return;
        // `broadcast('openvpn', …)` carries a full status from a sweep and a bare {phase, host}
        // from connect/disconnect. Only the first can be applied in place; assuming it for the
        // second would replace a whole status with two fields and blank the card.
        if (s.installed === undefined && s.sweep === undefined) { refresh(); return; }
        const hadSweep = !!(st.payload.status && st.payload.status.sweep);
        st.payload.status = s;
        if (!$('ov-wrap')) return;
        renderIdent();
        renderBar();
        renderBarAction();
        if (ovSec === 'connect') { renderHero(); renderDest(); renderCards(); }
        // A sweep that has just ended means new results, which the list must be redrawn from.
        if (ovSec === 'servers') { renderTools(); if (hadSweep && !s.sweep) { refresh(); } else { renderServers(); } ovWire(); }
        else if (hadSweep && !s.sweep) refresh();
    };

    window.MVProbe = window.MVProbe || {};
    window.MVProbe.openvpn = () => !!(st.payload && st.payload.status && st.payload.status.connected);
    /** What the desktop's «وضعیت اتصال» widget shows about a live session. */
    window.MVProbe.openvpnInfo = () => {
        const s = (st.payload && st.payload.status) || {};
        return {
            host: s.profileId ? (s.label || null) : (s.host ? shortName(s.host) : null),
            via: s.connected ? (s.path === 'split' ? 'مستقیم، رلهٔ محلی' : 'مستقیم') : null,
            localIp: s.localIp || null,
        };
    };

    window.openvpnRefresh = refresh;
    // apps.js reads this for the engine lamp (`ovpnState.status.connected`); it was the previous
    // panel's global. Kept as a live view of the same state rather than a copy, so the lamp and
    // MVProbe can never disagree.
    window.ovpnState = st;
    Object.defineProperty(st, 'status', {
        get() { return (st.payload && st.payload.status) || {}; },
        configurable: true,
    });

    window.initOpenVpnModule = function () {
        const root = $('ls-openvpn');
        if (!root) return;
        // Idempotent: a second call must not rebuild the page (which would throw away the
        // user's scroll, their search and their selection) and must not re-hide a container
        // that is currently on screen inside a window.
        if ($('ov-wrap')) { refresh(); return; }
        root.innerHTML = template();
        if (root.parentElement) {
            root.parentElement.style.position = 'relative';
            root.parentElement.style.padding = '0';
            root.parentElement.style.overflow = 'hidden';
        }
        root.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';

        $('ov-wrap').querySelectorAll('.mv-side-item[data-ov-sec]').forEach((b) => {
            b.onclick = () => ovGoSec(b.getAttribute('data-ov-sec'));
        });
        // This window's engine is openvpn.exe, its own item in the store — the same door the
        // gateway and the warp engines put in their sidebars.
        const storeBtn = $('ov-wrap').querySelector('[data-ov-store]');
        if (storeBtn) storeBtn.onclick = () => {
            if (typeof window.storeOpenItem === 'function') window.storeOpenItem('core|openvpn');
            else if (window.MV && MV.wm) MV.wm.open('store');
        };
        $('ov-back').onclick = goBack;
        // The TunnelBear / profile data is needed on the home page too («مقصد اتصال», the card).
        if (window.OvProfiles) OvProfiles.attach(bridge);
        ovGoSec('connect');
        refresh();
        setInterval(() => {
            const r = $('ls-openvpn');
            if (r && r.style.display !== 'none') refresh();
        }, 4000);
    };
})();
