// --- گیت‌هاب تانل · اجزای ظاهری ---
// Every block the «گیت‌هاب تانل» window draws is built from these. They emit the page kit's own
// markup (ui/page-kit.css: grouped form, mini switch, callout, list rows, engine cards, country
// picker), so this window reads like Settings and the other engine windows — and no renderer in
// gt-*.js writes a colour or a hand-made control of its own.
//
// The window is split by what it owns, one file each, loaded before github-tunnel.js:
//   gt-ui.js        these pieces, the action registry and the window's stylesheet
//   gt-session.js   the cloud session: its card, renewal, the setup run and its failures
//   gt-accounts.js  the GitHub account pool and the device-code sign-in
//   gt-route.js     the traffic route, the leak guards, the speed and leak tests
//   gt-exit.js      the exit country chosen on the server, and the per-site rules
//   gt-broker.js    the relay Worker on the user's Cloudflare and the stable tunnel
//   github-tunnel.js  state, data, the window's frame and the render loop
//
// EVENTS ARE DECLARATIVE. A control carries data-gt-act="name" (+ data-arg), a switch
// data-gt-switch="name", a field data-gt-input / data-gt-change. ONE listener per kind on the
// window (github-tunnel.js › gtWire) runs the registered handler, so a poll that redraws a card
// can never leave a button unwired, and no markup carries inline JavaScript.

/** name → (arg, element) for clicks; switches get (checked, element); fields (value, element). */
const GT_ACTIONS = Object.create(null);
const GT_SWITCHES = Object.create(null);
const GT_INPUTS = Object.create(null);
const GT_CHANGES = Object.create(null);

const GTUI = (() => {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
    const plain = (html) => String(html || '').replace(/<[^>]+>/g, '').trim();

    /** Register handlers: GTUI.on({ act: {...}, switch: {...}, input: {...}, change: {...} }). */
    function on(map) {
        Object.assign(GT_ACTIONS, map.act || {});
        Object.assign(GT_SWITCHES, map.switch || {});
        Object.assign(GT_INPUTS, map.input || {});
        Object.assign(GT_CHANGES, map.change || {});
    }

    /** The attributes that make an element a registered action (or a section link). */
    function act(name, arg) {
        if (!name) return '';
        return ` data-gt-act="${esc(name)}"${arg != null && arg !== '' ? ` data-arg="${esc(arg)}"` : ''}`;
    }
    const go = (sec) => ` data-gt-go="${esc(sec)}"`;

    // ── small pieces ──────────────────────────────────────────────────────────────
    /* A DRAWN ring, never a rotating glyph: a font glyph sits on a baseline with its own
       bearings, so it wobbles instead of spinning. Same rule as every other engine page. */
    const spin = () => '<i class="mv-spin-ring" aria-hidden="true"></i>';
    const tile = (icon, tint) => `<span class="mv-side-tile gt-tile" style="--tint:${tint || 'var(--mv-gray)'}"><i class="${icon}"></i></span>`;
    const mono = (text) => `<span class="mv-tech">${esc(text)}</span>`;
    /** The kit's status pill; `tone` ok | warn | bad | '' — the word always says it too. */
    const pill = (text, tone, lamp) => `<span class="mv-pill${tone ? ` is-${tone}` : ''}">${lamp ? '<i class="mv-lampdot"></i>' : ''}${esc(text)}</span>`;

    /**
     * A flag, as a bundled SVG: Windows has no glyphs for regional-indicator pairs, so an emoji
     * flag would render as two boxed letters. The code sits behind the image as its fallback.
     */
    function flag(cc, w) {
        const width = w || 18;
        const h = Math.round(width * 0.72);
        const size = `width:${width}px;height:${h}px`;
        if (!cc) return `<span class="mv-flag is-none" style="${size}"></span>`;
        const c = String(cc);
        return `<span class="mv-flag" style="${size}">${esc(c.toUpperCase())}<img src="/assets/flags/${esc(c.toLowerCase())}.svg" alt="" onerror="this.remove()"></span>`;
    }

    /**
     * A push button. kind: primary | plain | danger | '' (the kit's bezel); size: sm | lg | ''.
     * `busy` swaps the label for a spinner and the busy text, and disables it.
     */
    function button(o) {
        const cls = ['mv-btn'];
        if (o.kind === 'primary') cls.push('mv-btn--primary');
        if (o.kind === 'plain') cls.push('mv-btn--plain');
        if (o.kind === 'danger') cls.push('mv-btn--danger');
        if (o.size === 'sm') cls.push('mv-btn--sm');
        if (o.size === 'lg') cls.push('mv-btn--lg');
        if (o.icon && !o.text) cls.push('mv-btn--icon');
        if (o.wide) cls.push('is-wide');
        const body = o.busy
            ? `${spin()}${o.busyText ? `<span>${esc(o.busyText)}</span>` : ''}`
            : `${o.icon ? `<i class="${o.icon}" aria-hidden="true"></i>` : ''}${o.text ? `<span>${esc(o.text)}</span>` : ''}`;
        const label = o.label || (o.text ? '' : o.title);
        return `<button type="button" class="${cls.join(' ')}"${o.go ? go(o.go) : act(o.act, o.arg)}${o.disabled || o.busy ? ' disabled' : ''}`
            + `${o.title ? ` title="${esc(o.title)}"` : ''}${label ? ` aria-label="${esc(label)}"` : ''}>${body}</button>`;
    }

    /** A row of buttons, start-aligned; `grow` pushes what follows it to the far end. */
    const actions = (list, cls) => `<div class="gt-actions${cls ? ` ${cls}` : ''}">${list.filter(Boolean).join('')}</div>`;
    const grow = '<span class="gt-grow"></span>';

    /**
     * The kit's mini switch. The page kit (ui/mv.js) flips it on click or Space and fires
     * `mv-change`; github-tunnel.js › gtWire hands that to GT_SWITCHES[name]. `busy` turns the
     * knob itself into a spinner — the knob is the part the eye follows when a switch is pressed,
     * so a dimmed switch no longer reads as «this did nothing».
     */
    function sw(o) {
        return `<span class="mv-switch mv-switch--mini${o.busy ? ' is-busy' : ''}" role="switch" tabindex="0"`
            + ` aria-checked="${!!o.on}" data-gt-switch="${esc(o.name)}"${o.disabled || o.busy ? ' aria-disabled="true"' : ''}`
            + ` aria-label="${esc(plain(o.label))}"></span>`;
    }

    // ── the grouped form ──────────────────────────────────────────────────────────
    const label = (title, sub) => `<span class="mv-form-label">${title}${sub ? `<small>${sub}</small>` : ''}</span>`;

    /** A form: sections that flow into two or three module columns on a wide window. */
    const form = (sections) => `<div class="mv-form">${sections.filter(Boolean).join('')}</div>`;

    /** header + group + footer. `wide` spans every column. */
    function section(o) {
        const rows = Array.isArray(o.rows) ? o.rows.filter(Boolean).join('') : (o.rows || '');
        if (!rows && !o.keepEmpty) return '';
        return `<section class="mv-form-section${o.wide ? ' is-wide' : ''}${o.cls ? ` ${o.cls}` : ''}"${o.id ? ` id="${esc(o.id)}"` : ''}>
          ${o.header ? `<div class="mv-form-header">${o.header}</div>` : ''}
          <div class="mv-form-group">${rows}</div>
          ${(Array.isArray(o.footer) ? o.footer : [o.footer]).filter(Boolean).map((f) => `<p class="mv-form-footer">${f}</p>`).join('')}
        </section>`;
    }

    /** A row: optional tile, label + second line, and whatever sits at the trailing end. */
    function row(o) {
        return `<div class="mv-form-row${o.cls ? ` ${o.cls}` : ''}">${o.icon ? tile(o.icon, o.tint) : ''}${label(o.title, o.sub)}${o.end ? `<span class="mv-form-control">${o.end}</span>` : ''}</div>`;
    }

    /** A value on the trailing side; LTR values (addresses, ids) are isolated and monospaced. */
    function valueRow(o) {
        const v = o.value == null || o.value === '' ? '—' : o.value;
        const shown = o.html ? v : (o.ltr ? `<span class="gt-val is-ltr" dir="ltr">${esc(v)}</span>` : `<span class="gt-val">${esc(v)}</span>`);
        const copy = o.copy ? button({ icon: 'ph-bold ph-copy', title: 'کپی', act: 'copy', arg: o.copy, size: 'sm' }) : '';
        return row({ icon: o.icon, tint: o.tint, title: o.title, sub: o.sub, end: `${shown}${copy}`, cls: o.cls });
    }

    function switchRow(o) {
        return row({ icon: o.icon, tint: o.tint, title: o.title, sub: o.sub, cls: o.cls,
            end: sw({ name: o.name, on: o.on, disabled: o.disabled, busy: o.busy, label: o.title }) });
    }

    /**
     * The whole row is the button (Settings › a row that does something): a tile, the label, an
     * optional value, and a chevron when it opens somewhere. `tone: 'danger'` for the ones that
     * cannot be undone; `busy` puts a spinner where the value goes.
     */
    function actionRow(o) {
        const cls = ['mv-form-row', 'is-action'];
        if (o.go || o.chevron) cls.push('is-link');
        if (o.tone === 'danger') cls.push('is-danger');
        if (o.cls) cls.push(o.cls);
        const end = o.busy ? `<span class="gt-val">${spin()}</span>`
            : o.tick ? '<i class="ph-bold ph-check gt-tick" aria-hidden="true"></i>'
            : o.value != null && o.value !== '' ? `<span class="gt-val"${o.ltr ? ' dir="ltr"' : ''}>${o.html ? o.value : esc(o.value)}</span>` : '';
        return `<button type="button" class="${cls.join(' ')}"${o.go ? go(o.go) : act(o.act, o.arg)}`
            + `${o.role ? ` role="${o.role}" aria-checked="${!!o.checked}"` : ''}${o.disabled || o.busy ? ' disabled' : ''}${o.busy ? ' aria-busy="true"' : ''}>`
            + `${o.icon ? tile(o.icon, o.tint) : ''}${label(o.title, o.sub)}${end}</button>`;
    }

    /** Full-width content inside a group (a list, a field, a block of text). */
    const stack = (inner, cls) => `<div class="mv-form-row is-stack${cls ? ` ${cls}` : ''}">${inner}</div>`;

    /**
     * A notice inside a group (K6). tone: '' (info) | warn | danger | ok. `actions` sit under the
     * sentence, never beside it — a button squeezed next to three lines of text reads as part of
     * the text.
     */
    function callout(o) {
        const tone = o.tone || '';
        const icon = o.icon || (tone === 'danger' ? 'ph-fill ph-warning-octagon' : tone === 'warn' ? 'ph-fill ph-warning' : tone === 'ok' ? 'ph-fill ph-check-circle' : 'ph-fill ph-info');
        const acts = (o.actions || []).filter(Boolean);
        return `<div class="mv-form-row mv-callout${tone ? ` is-${tone}` : ''}${o.cls ? ` ${o.cls}` : ''}">
          ${o.spin ? `<i class="gt-callout-spin">${spin()}</i>` : `<i class="${icon}" aria-hidden="true"></i>`}
          <div class="gt-callout-body">
            ${o.title ? `<b class="gt-callout-title">${o.title}</b>` : ''}
            ${o.text ? `<span>${o.text}</span>` : ''}
            ${o.observed ? `<code class="gt-observed" dir="ltr">${esc(o.observed)}</code>` : ''}
            ${acts.length ? actions(acts) : ''}
          </div>
        </div>`;
    }

    /** A callout standing on its own — the whole card is the notice (a failed run, a missing step). */
    const notice = (o) => `<div class="mv-form-group gt-notice">${callout(o)}</div>`;

    /** A text field that keeps what was typed across redraws (gtState.drafts, by id). */
    function field(o) {
        const drafts = (typeof gtState !== 'undefined' && gtState.drafts) || {};
        const value = Object.prototype.hasOwnProperty.call(drafts, o.id) ? drafts[o.id] : (o.value || '');
        const cls = `mv-field${o.ltr ? ' mv-field--tech' : ''}${o.cls ? ` ${o.cls}` : ''}`;
        const common = `id="${esc(o.id)}" class="${cls}" data-gt-draft="${esc(o.id)}"${o.ltr ? ' dir="ltr"' : ''}`
            + `${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''} spellcheck="false" autocomplete="off"`
            + `${o.label ? ` aria-label="${esc(o.label)}"` : ''}${o.enter ? ` data-gt-enter="${esc(o.enter)}"` : ''}${o.disabled ? ' disabled' : ''}`;
        return o.rows
            ? `<textarea ${common} rows="${o.rows}">${esc(value)}</textarea>`
            : `<input type="${o.type || 'text'}" ${common} value="${esc(value)}">`;
    }

    /** The kit's borderless pop-up button, for short lists of plain names. */
    function popup(o) {
        return `<select class="mv-popup" id="${esc(o.id)}"${o.change ? ` data-gt-change="${esc(o.change)}"` : ''}${o.label ? ` aria-label="${esc(o.label)}"` : ''}${o.disabled ? ' disabled' : ''}>
          ${o.options.map((x) => `<option value="${esc(x.value)}"${x.value === o.value ? ' selected' : ''}>${esc(x.text)}</option>`).join('')}
        </select>`;
    }

    /** The kit's segmented control; the chosen one is the raised thumb. */
    function seg(o) {
        return `<div class="mv-seg gt-seg" role="radiogroup"${o.label ? ` aria-label="${esc(o.label)}"` : ''}>
          ${o.items.map((x) => `<button type="button"${act(o.act, x.value)} role="radio" aria-checked="${x.value === o.value}" aria-pressed="${x.value === o.value}"${o.disabled || x.disabled ? ' disabled' : ''}${x.title ? ` title="${esc(x.title)}"` : ''}>${esc(x.text)}</button>`).join('')}
        </div>`;
    }

    /**
     * A disclosure row whose open state lives in gtState.ui.open — a native <details> forgets it
     * the moment a poll redraws the card, and draws the operating system's triangle besides.
     */
    function disclosure(o) {
        const open = !!(typeof gtState !== 'undefined' && gtState.ui && gtState.ui.open[o.key]);
        return `<button type="button" class="mv-form-row is-action gt-disc${open ? ' is-open' : ''}"${act('disclose', o.key)} aria-expanded="${open}">
            ${o.icon ? tile(o.icon, o.tint) : ''}${label(o.title, o.sub)}<i class="ph-bold ph-caret-down gt-disc-chev" aria-hidden="true"></i>
          </button>${open ? stack(o.body, 'gt-disc-body') : ''}`;
    }

    /** Big centred state for an empty or waiting section (K10). */
    function empty(o) {
        return `<div class="mv-empty gt-empty">
          ${o.spin ? `<i class="mv-empty-ic">${spin()}</i>` : o.tile ? o.tile : `<i class="${o.icon || 'ph-fill ph-info'} mv-empty-ic" aria-hidden="true"></i>`}
          ${o.title ? `<b>${o.title}</b>` : ''}
          ${o.text ? `<p>${o.text}</p>` : ''}
          ${o.actions && o.actions.length ? actions(o.actions, 'is-center') : ''}
        </div>`;
    }

    // ── the engine page's cards ─────────────────────────────────────────────────
    /**
     * One card under the stage (.mv-eng-card2). Its header opens the section that holds the
     * whole of it when `go` is given; `side` is the one small action beside the header.
     */
    function card(o) {
        const end = `${o.end || ''}${o.go ? '<i class="ph-bold ph-caret-left gt-chev" aria-hidden="true"></i>' : ''}`;
        const head = o.go
            ? `<button type="button" class="mv-eng-card2-head"${go(o.go)}>`
            : '<div class="mv-eng-card2-head gt-head-static">';
        const headEnd = o.go ? '</button>' : '</div>';
        return `<article class="mv-eng-card2 gt-card2${o.cls ? ` ${o.cls}` : ''}"${o.id ? ` id="${esc(o.id)}"` : ''} style="--tint:${o.tint || 'var(--mv-blue)'}">
          <div class="mv-eng-card2-top">
            ${head}<span class="mv-eng-glyph"><i class="${o.icon}" aria-hidden="true"></i></span><h3>${o.title}</h3>
              <span class="mv-eng-card2-end">${end}</span>${headEnd}
            ${o.side || ''}
          </div>
          ${o.body ? `<div class="mv-eng-card2-body">${o.body}</div>` : ''}
          ${o.foot ? `<div class="mv-eng-card2-foot">${o.foot}</div>` : ''}
        </article>`;
    }

    /** The one small square action beside a card header (renew, add, run). */
    function cardAct(o) {
        return `<button type="button" class="mv-eng-card2-act"${act(o.act, o.arg)} title="${esc(o.title)}" aria-label="${esc(o.title)}"${o.disabled || o.busy ? ' disabled' : ''}>
            ${o.busy ? spin() : `<i class="${o.icon}" aria-hidden="true"></i>`}</button>`;
    }

    /** Key/value lines inside a card: what the user needs to see without opening the section. */
    function facts(list) {
        const items = list.filter(Boolean);
        if (!items.length) return '';
        return `<div class="gt-facts">${items.map((f) => `<div class="gt-fact"><span>${f.k}</span><b${f.ltr ? ' dir="ltr" class="is-ltr"' : ''}>${f.html ? f.v : esc(f.v)}</b></div>`).join('')}</div>`;
    }

    /** Rows inside a card, the same rows a form uses, on the card's own ground. */
    const rows = (list) => { const r = list.filter(Boolean).join(''); return r ? `<div class="gt-rows">${r}</div>` : ''; };

    /** A card that answers the whole page (sign-in, a failed run): it takes the whole row. */
    const panel = (inner, cls) => `<div class="gt-panel${cls ? ` ${cls}` : ''}">${inner}</div>`;

    return Object.freeze({
        esc, fa, plain, on, act, go, spin, tile, mono, pill, flag, button, actions, grow, sw,
        label, form, section, row, valueRow, switchRow, actionRow, stack, callout, notice, field, popup, seg,
        disclosure, empty, card, cardAct, facts, rows, panel,
    });
})();

// ── the window's stylesheet ─────────────────────────────────────────────────────
// Only what the kit does not already draw, and all of it under #gt-wrapper: panels share one
// document, and an unscoped class here would restyle some other window (see panel-css-is-global).
const GT_CSS = `
#gt-wrapper { position: relative; z-index: 0; flex: 1 1 auto; min-height: 0; color: var(--mv-label); }
#gt-wrapper .gt-sec { display: flex; flex-direction: column; gap: 14px; padding-top: 6px; }

/* ── cards on the front page ── */
/* The cards flow into columns like the kit's form modules: each is as tall as what it says, so a
   long card (the session, an open country list) never stretches the short ones beside it. */
#gt-wrapper #gt-cards { display: block; columns: 262px; column-gap: 12px; }
#gt-wrapper #gt-cards > * { break-inside: avoid; margin-bottom: 12px; }
#gt-wrapper #gt-cards > .gt-span { column-span: all; }
#gt-wrapper .gt-card2 .mv-eng-card2-head.gt-head-static { cursor: default; }
#gt-wrapper .gt-card2 .mv-eng-card2-head.gt-head-static:hover { background: transparent; }
#gt-wrapper .gt-card2 .mv-eng-card2-end { gap: 6px; }
#gt-wrapper .gt-card2 .mv-eng-card2-end .mv-pill { height: 19px; font-size: 11px; }
#gt-wrapper .gt-chev { font-size: 11px; color: var(--mv-label-3); }
#gt-wrapper .gt-card2 .mv-eng-card2-body { gap: 6px; }

/* key/value lines inside a card */
#gt-wrapper .gt-facts { display: flex; flex-direction: column; padding: 0 5px; }
#gt-wrapper .gt-fact { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 31px; padding: 5px 4px; font-size: 12px; color: var(--mv-label-2); }
#gt-wrapper .gt-fact + .gt-fact::before { content: ""; position: absolute; top: 0; inset-inline: 4px; height: var(--mv-hl); background: var(--mv-group-sep); }
#gt-wrapper .gt-fact > span { flex: none; }
#gt-wrapper .gt-fact > b { min-width: 0; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--mv-label);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#gt-wrapper .gt-fact > b.is-ltr { font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums; unicode-bidi: isolate; }

/* form rows on a card's own ground */
#gt-wrapper .gt-rows { display: flex; flex-direction: column; margin: 2px 0; border-radius: 11px; background: var(--mv-fill); }
#gt-wrapper .gt-rows > .mv-form-row { min-height: 40px; padding: 8px 11px; }
#gt-wrapper .gt-rows > .mv-form-row + .mv-form-row::before { inset-inline: 11px; }
#gt-wrapper .gt-rows > .mv-form-row.is-action:first-child { border-radius: 11px 11px 0 0; }
#gt-wrapper .gt-rows > .mv-form-row.is-action:last-child { border-radius: 0 0 11px 11px; }
#gt-wrapper .gt-rows > .mv-form-row.is-action:only-child { border-radius: 11px; }
#gt-wrapper .mv-eng-card2 .mv-callout { border-radius: 11px; }

/* the countdown */
#gt-wrapper .gt-clock { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 0 8px; }
#gt-wrapper .gt-clock b { direction: ltr; font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums; font-size: 31px;
  font-weight: 700; letter-spacing: .05em; line-height: 1.25; color: var(--mv-label); }
#gt-wrapper .gt-clock.is-soon b { color: var(--mv-orange-ink); }
#gt-wrapper .gt-clock small { font-size: 11px; color: var(--mv-label-3); }

/* ── rows ── */
#gt-wrapper .gt-tile { width: 26px; height: 26px; font-size: 15px; }
#gt-wrapper .gt-val { flex: 0 1 auto; min-width: 0; max-width: 100%; display: inline-block; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--mv-label-2); font-size: 12.5px; }
#gt-wrapper .mv-form-row > .mv-form-control { min-width: 0; max-width: 62%; }
#gt-wrapper .gt-val.is-ltr, #gt-wrapper .gt-val[dir="ltr"] { font-family: var(--mv-font-tech); unicode-bidi: isolate; }
#gt-wrapper .gt-tick { flex: none; color: var(--mv-accent); font-size: 16px; }
#gt-wrapper .mv-form-row.is-action[disabled] { cursor: default; opacity: .5; }
#gt-wrapper .mv-form-row.is-action[aria-busy="true"] { opacity: 1; }
#gt-wrapper .mv-form-row.is-action.is-danger .mv-form-label { color: var(--mv-red-ink); }
#gt-wrapper .mv-form-row.is-action[role="radio"][aria-checked="true"] .mv-form-label { font-weight: 600; }
#gt-wrapper .mv-form-row .mv-btn--icon { color: var(--mv-label-2); }

/* the busy switch: its knob turns into the spinner */
#gt-wrapper .mv-switch.is-busy { opacity: 1; }
#gt-wrapper .mv-switch.is-busy::after { background: transparent; box-sizing: border-box; border: 2px solid var(--mv-knob);
  border-top-color: transparent; box-shadow: none; animation: mv-spin .8s linear infinite; }
html[data-motion="reduced"] #gt-wrapper .mv-switch.is-busy::after { animation: none; }

/* buttons in a row */
#gt-wrapper .gt-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
#gt-wrapper .gt-actions.is-center { justify-content: center; }
#gt-wrapper .gt-grow { flex: 1 1 auto; }
#gt-wrapper .mv-btn .mv-spin-ring { font-size: 13px; }
#gt-wrapper .mv-btn.is-wide { width: 100%; }

/* callouts: the sentence, then what to do about it */
#gt-wrapper .gt-callout-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
#gt-wrapper .gt-callout-title { color: var(--mv-label); font-weight: 700; }
#gt-wrapper .mv-callout .gt-actions { margin-top: 1px; }
#gt-wrapper .gt-callout-spin { flex: none; margin-top: 3px; font-size: 15px; color: var(--tone-ink); font-style: normal; }
#gt-wrapper .mv-form-row.mv-callout.is-ok { --tone: var(--mv-green); --tone-ink: var(--mv-green-ink); }
#gt-wrapper .gt-observed { display: block; padding: 6px 9px; border-radius: 7px; background: var(--mv-code); color: var(--mv-label-2);
  font-family: var(--mv-font-mono); font-size: 11px; line-height: 1.6; text-align: left; word-break: break-all; white-space: pre-wrap; }

/* disclosure */
#gt-wrapper .gt-disc-chev { flex: none; font-size: 12px; color: var(--mv-label-3); transition: transform var(--mv-d-2) var(--mv-ease-out); }
#gt-wrapper .gt-disc:not(.is-open) .gt-disc-chev { transform: rotate(90deg); }
[dir="ltr"] #gt-wrapper .gt-disc:not(.is-open) .gt-disc-chev { transform: rotate(-90deg); }
#gt-wrapper .gt-disc-body { font-size: 12px; line-height: 1.9; color: var(--mv-label-2); padding-top: 2px; }

/* segmented control inside a row */
#gt-wrapper .gt-seg > button[disabled] { opacity: .4; cursor: default; }

/* fields */
#gt-wrapper .mv-form-row.is-stack > .mv-field { width: 100%; box-sizing: border-box; }
#gt-wrapper textarea.mv-field { min-height: 58px; }
#gt-wrapper .gt-field-line { display: flex; align-items: center; gap: 8px; }
#gt-wrapper .gt-field-line > .mv-field { flex: 1 1 auto; min-width: 0; }

/* empty and waiting states */
#gt-wrapper .gt-empty { padding: 26px 20px 24px; }
#gt-wrapper .gt-empty > p { max-width: 440px; }
#gt-wrapper .gt-empty .mv-empty-ic { font-style: normal; }

/* a card that answers the whole page */
#gt-wrapper .gt-panel { border-radius: 14px; background: var(--mv-group); box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
  padding: 18px; display: flex; flex-direction: column; gap: 12px; }
#gt-wrapper .gt-panel-head { display: flex; align-items: center; gap: 12px; }
#gt-wrapper .gt-panel-head > .mv-side-tile { width: 38px; height: 38px; font-size: 21px; border-radius: 10px; }
#gt-wrapper .gt-panel-head h2 { margin: 0; font-size: 14.5px; font-weight: 700; color: var(--mv-label); }
#gt-wrapper .gt-panel-head p { margin: 2px 0 0; font-size: 12px; line-height: 1.8; color: var(--mv-label-2); }
#gt-wrapper .gt-panel > .gt-form-inset { margin-inline: -4px; }
#gt-wrapper .gt-panel .mv-form-group { border-radius: 12px; }

/* the device code */
#gt-wrapper .gt-code { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 6px 0 2px; }
#gt-wrapper .gt-code-value { direction: ltr; user-select: all; font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums;
  font-size: 30px; font-weight: 700; letter-spacing: .18em; color: var(--mv-label); padding: 10px 26px; border-radius: 14px;
  background: var(--mv-code); box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
#gt-wrapper .gt-code-url { direction: ltr; user-select: all; font-family: var(--mv-font-mono); font-size: 11px; color: var(--mv-label-3); }
#gt-wrapper .gt-wait { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--mv-label-2); }

/* the setup run's own words */
#gt-wrapper .gt-log { max-height: 128px; overflow-y: auto; margin: 0; padding: 8px 10px; border-radius: 9px; background: var(--mv-code);
  font-family: var(--mv-font-mono); font-size: 11px; line-height: 1.65; color: var(--mv-label-2); direction: ltr; text-align: left;
  white-space: pre-wrap; word-break: break-word; }

/* a numbered guide */
#gt-wrapper .gt-guide { margin: 0; list-style: persian; padding-inline-start: 22px; display: flex; flex-direction: column; gap: 7px; font-size: 12px; line-height: 1.85; color: var(--mv-label-2); }
#gt-wrapper .gt-guide b { color: var(--mv-label); }
#gt-wrapper .gt-guide a { color: var(--mv-accent); cursor: pointer; }
#gt-wrapper .gt-pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--mv-code); color: var(--mv-label);
  font-family: var(--mv-font-mono); font-size: 11px; line-height: 1.6; direction: ltr; text-align: left; white-space: pre; overflow-x: auto; }

/* accounts */
#gt-wrapper .gt-avatar { flex: none; width: 30px; height: 30px; border-radius: 50%; overflow: hidden; display: grid; place-items: center;
  background: linear-gradient(180deg, #4B4D55, #25262B); color: #FFFFFF; font-size: 13px; font-weight: 700; font-family: var(--mv-font-tech); }
#gt-wrapper .gt-avatar > img { width: 100%; height: 100%; object-fit: cover; }
#gt-wrapper .gt-acc { align-items: flex-start; padding-block: 11px; }
#gt-wrapper .gt-acc.is-off { opacity: .6; }
#gt-wrapper .gt-acc-name { display: flex; align-items: center; gap: 7px; min-width: 0; }
#gt-wrapper .gt-acc-name > b { direction: ltr; unicode-bidi: isolate; font-family: var(--mv-font-tech); font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#gt-wrapper .gt-acc .mv-li-text > small { white-space: normal; line-height: 1.7; }
#gt-wrapper .gt-acc-end { flex: none; display: flex; align-items: center; gap: 2px; }
#gt-wrapper .gt-meter { margin-top: 7px; height: 4px; border-radius: 999px; background: var(--mv-track); overflow: hidden; }
#gt-wrapper .gt-meter > i { display: block; height: 100%; border-radius: inherit; background: var(--gt-meter, var(--mv-green)); }
#gt-wrapper .gt-meter-line { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--mv-label-2); }
#gt-wrapper .gt-acc-note { display: block; margin-top: 5px; font-size: 11px; line-height: 1.7; color: var(--mv-label-3); }
#gt-wrapper .gt-acc-note[dir="ltr"] { text-align: left; font-family: var(--mv-font-mono); word-break: break-all; }
#gt-wrapper .gt-mini-list { display: flex; flex-direction: column; }
#gt-wrapper .gt-mini { display: flex; align-items: center; gap: 9px; min-height: 34px; padding: 4px 9px; font-size: 12.5px; }
#gt-wrapper .gt-mini > b { direction: ltr; unicode-bidi: isolate; font-family: var(--mv-font-tech); font-weight: 600; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: start; }
#gt-wrapper .gt-mini .gt-avatar { width: 22px; height: 22px; font-size: 10px; }

/* the leak test's answers and the speed test's rows */
#gt-wrapper .gt-checks { display: flex; flex-direction: column; gap: 2px; }
#gt-wrapper .gt-check { display: flex; align-items: flex-start; gap: 9px; padding: 6px 8px; font-size: 11.5px; line-height: 1.8; color: var(--mv-label); }
#gt-wrapper .gt-check > i { flex: none; margin-top: 3px; font-size: 15px; }
#gt-wrapper .gt-check.is-pass > i { color: var(--mv-green); }
#gt-wrapper .gt-check.is-fail > i { color: var(--mv-red); }
#gt-wrapper .gt-check.is-warn > i { color: var(--mv-orange); }
#gt-wrapper .gt-check.is-unknown > i { color: var(--mv-label-3); }
#gt-wrapper .gt-check-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
#gt-wrapper .gt-check-text > span { display: flex; justify-content: space-between; gap: 10px; }
#gt-wrapper .gt-check-text small { font-size: 11px; line-height: 1.7; color: var(--mv-label-2); }
#gt-wrapper .gt-check-text em { font-style: normal; font-weight: 600; white-space: nowrap; }
#gt-wrapper .gt-check.is-pass em { color: var(--mv-green-ink); }
#gt-wrapper .gt-check.is-fail em { color: var(--mv-red-ink); }
#gt-wrapper .gt-check.is-warn em { color: var(--mv-orange-ink); }
#gt-wrapper .gt-note { font-size: 11px; line-height: 1.8; color: var(--mv-label-3); padding: 2px 8px; }
#gt-wrapper .gt-note.is-warn { color: var(--mv-orange-ink); }

/* the guard chips on the front page: three locks, read at a glance */
#gt-wrapper .gt-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px; }
#gt-wrapper .gt-chips .mv-pill { height: 21px; font-weight: 600; }

/* exit country */
#gt-wrapper .gt-exit-now { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 11px; background: var(--mv-fill); }
#gt-wrapper .gt-exit-now-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
#gt-wrapper .gt-exit-now-text b { font-size: 12.5px; font-weight: 650; }
#gt-wrapper .gt-exit-now-text small { font-size: 11px; color: var(--mv-label-2); direction: ltr; text-align: start; font-family: var(--mv-font-tech); unicode-bidi: isolate; }
#gt-wrapper .gt-exit-now .gt-exit-now-k { margin-inline-start: auto; font-size: 10.5px; color: var(--mv-label-3); white-space: nowrap; }
#gt-wrapper .mv-eng-sec[data-sec="exit"] .mv-eng-cc-rows { max-height: 420px; }
#gt-wrapper .gt-rule-domains { direction: ltr; unicode-bidi: isolate; font-family: var(--mv-font-tech); }
#gt-wrapper .gt-rule-add { display: flex; flex-direction: column; gap: 9px; }
#gt-wrapper .gt-rule-add .mv-eng-cc-cur { background: var(--mv-fill-2); }

/* an account's state: a dot and the word, in the tone's ink */
#gt-wrapper .gt-state { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--mv-label-2); white-space: nowrap; }
#gt-wrapper .gt-state > i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
#gt-wrapper .gt-state.is-ok { color: var(--mv-green-ink); }
#gt-wrapper .gt-state.is-warn { color: var(--mv-orange-ink); }
#gt-wrapper .gt-state.is-bad { color: var(--mv-red-ink); }
#gt-wrapper .gt-count-num { font-family: var(--mv-font-tech); font-weight: 700; color: var(--mv-label-2); }
#gt-wrapper .gt-header-count { margin-inline-start: 6px; padding: 1px 7px; border-radius: 999px; background: var(--mv-fill-2);
  font-size: 11px; font-weight: 700; color: var(--mv-label-2); vertical-align: 1px; }
#gt-wrapper .gt-sec-lead { margin-bottom: 4px; }

/* a notice standing alone, and the welcome card */
#gt-wrapper .gt-notice > .mv-callout { padding: 14px 16px; }
#gt-wrapper .gt-notice .gt-callout-title { font-size: 13.5px; }
#gt-wrapper .gt-panel.is-welcome { padding-block: 10px 16px; }
#gt-wrapper .gt-welcome-tile { width: 58px; height: 58px; border-radius: 15px; font-size: 32px; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
#gt-wrapper .gt-panel.is-welcome .mv-empty > b { font-size: 16px; }
#gt-wrapper .gt-panel.is-welcome .mv-btn--lg { min-width: 200px; }

/* the country picker in a card or a section */
#gt-wrapper .gt-cc { display: flex; flex-direction: column; }
#gt-wrapper .mv-form-row.is-stack > .gt-cc .mv-eng-cc-list { margin-top: 0; }

/* the footer's exit flag */
#gt-wrapper .mv-eng-foot .mv-flag { vertical-align: -2px; }
#gt-wrapper .gt-foot-exit { display: inline-flex; align-items: center; gap: 5px; }
`;

(function gtInjectCss() {
    if (document.getElementById('gt-style')) return;
    const style = document.createElement('style');
    style.id = 'gt-style';
    style.textContent = GT_CSS;
    document.head.appendChild(style);
})();
