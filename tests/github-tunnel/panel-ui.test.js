/*
 * The GitHub Tunnel window's markup, and the banner that froze the whole app.
 *
 * The window is built from the page kit (public/components/gt-ui.js) so that it looks and works
 * like every other macOS-style window in the app. That promise is easy to break one quick fix at
 * a time — a native <select> here, a <details> there, a hand-coloured `--ide-*` box, an inline
 * onclick — which is exactly how the old panel ended up with a bright-blue full-width button in a
 * yellow box. So every renderer is loaded into a small sandbox, asked for its markup in the states
 * that matter, and the markup is held to the kit's rules:
 *
 *   · no native <select> except the kit's own pop-up button, and no <details>
 *   · no inline JavaScript: every control declares an action, and every declared action,
 *     switch, field and section link has a handler registered for it (a control with none is a
 *     button that silently does nothing)
 *   · no legacy colour tokens anywhere in the window's source
 *   · the exit country is the kit's picker, and the firewall warning is a callout with a small
 *     button — the two things the user pointed at
 *
 * And ui/mv.js › showBanner: with three banners on screen, a fourth spun an endless loop — the
 * one it dismissed keeps its place for its 200 ms exit, so the count never went down — and the
 * renderer froze. The clicking test of this window found it; this pins the fix.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const COMP = path.join(ROOT, 'public', 'components');
const FILES = ['gt-ui.js', 'gt-session.js', 'gt-accounts.js', 'gt-route.js', 'gt-exit.js', 'gt-broker.js', 'github-tunnel.js'];

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// ── a sandbox the window's scripts can load in ──────────────────────────────────────────
const store = new Map();
const sandbox = {
    console,
    Intl,
    setTimeout, clearTimeout, setInterval, clearInterval,
    PersistentStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, String(v)) },
    document: {
        getElementById: () => null,
        createElement: () => ({ set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
        head: { appendChild: (el) => { sandbox.__css = el.textContent; } },
        querySelector: () => null,
        documentElement: { classList: { contains: () => false } },
    },
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of FILES) {
    const src = fs.readFileSync(path.join(COMP, f), 'utf8');
    try { vm.runInContext(src, ctx, { filename: f }); t(`${f} loads`, true); }
    catch (e) { t(`${f} loads`, false, e.message); }
}
const run = (code) => vm.runInContext(code, ctx);

// ── fixtures: a connected v2 session with a country exit, and the states around it ───────
const fixture = (over) => {
    run(`Object.assign(gtState, ${JSON.stringify({
        accounts: { currentAccountId: 'a1', accounts: [
            { id: 'a1', login: 'first-account', health: 'OK', disabled: false, cooldownRemainingMs: 0, activeSessionId: 's1', repository: 'x/y', quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 620, remainingMinutes: 1380 } },
            { id: 'a2', login: 'second', health: 'EXHAUSTED', disabled: false, cooldownRemainingMs: 60000, consecutiveFailures: 1, repository: 'x/z', quota: { source: 'estimated', usedMinutes: 900 } },
            { id: 'a3', login: 'third', health: 'AUTH_REQUIRED', disabled: true, cooldownRemainingMs: 0, quota: {} } ] },
        githubStatus: { connected: true },
        broker: { deployed: true, needsRedeploy: true, redeployReason: 'feature', effectiveUrl: 'https://relay.example.workers.dev', customUrl: '' },
        status: { ok: true, dataPlane: 'v2', provisioning: null, autoRenew: true, continuity: { phase: 'idle' },
            slots: { enabled: true, slots: { a: {}, b: {} }, slotsBound: ['A', 'B'], accountsReady: 1, accountsTotal: 3 },
            exitChoice: { prefs: { country: 'JP', provider: '', rules: [{ country: 'KR', provider: '', domains: ['mexc.com'] }] }, job: { phase: 'partial', error: 'KR: no server answered' } },
            session: { id: 'S1', status: 'EXPIRING_SOON', remainingMs: 300000, dataPlane: 'v2', runner: { country: 'US', city: 'Boydton' }, tunnels: 3, slot: { name: 'b', ready: true }, accountLogin: 'first-account' } },
        engine: { ok: true, busy: false,
            engine: { connected: true, running: true, mode: 'tun', delayMs: 290,
                exitPlan: { use: 'x1', rules: [{ id: 'x2', domains: ['mexc.com'] }] },
                exits: [{ id: 'x1', state: 'ready', country: 'JP', provider: 'vpngate', mbps: 60, rttMs: 180 }, { id: 'x2', state: 'failed', country: 'KR', provider: 'vpngate', error: 'AUTH_FAILED' }],
                catalog: { vpngate: { JP: 56, KR: 26, TH: 6, RU: 6, VN: 3 }, psiphon: ['DE', 'JP', 'NL', 'US', 'GB', 'FR', 'SE'] },
                exit: { ip: '126.25.30.12', country: 'JP', city: 'Nagoya' } },
            killSwitch: { enabled: true, engaged: false, applicable: true }, dnsGuard: { active: true },
            ipv6Guard: { enabled: true, active: false, applicable: true },
            firewall: { enforcing: false, autoEnable: false },
            leakTest: { at: 1, verdict: 'clean', guards: { killSwitch: false, killSwitchWanted: true }, firewall: { enforcing: false }, checks: [{ status: 'pass', fa: 'آدرس: 126.25.30.12' }] } },
        speed: { summary: 'WARN', results: [{ name: 'دانلود', verdict: 'WARN', detail: '18 Mbit', hint: 'کم' }] },
        drafts: {}, ui: { open: { 'ts-guide': true, 'gh-404': true }, cc: { home: true, rule: true }, ccQuery: {}, ruleCc: 'JP' },
    })}); ${over || ''}`);
};

const render = () => ({
    session: run('gtSessionCard(gtView())'),
    route: run('gtRouteCard(gtView())'),
    exitCard: run('gtExitCard()'),
    leak: run('gtLeakCard()'),
    accountsCard: run('gtAccountsCard()'),
    brokerCard: run('gtBrokerCard()'),
    exit: run('gtRenderExit()'),
    network: run('gtRenderNetwork()'),
    accounts: run('gtRenderAccounts()'),
    broker: run('gtRenderBroker()'),
    run: run('gtRunPanel()'),
    signin: run('gtSignInPanel()'),
});

store.set('cf_accounts', JSON.stringify([{ id: 'c1', name: 'one@x.com', email: 'one@x.com', token: 't1' }, { id: 'c2', name: 'two@x.com', email: 'two@x.com', token: 't2' }]));

const states = {
    'connected v2, firewall off, partial exit': () => fixture(),
    'failed run': () => fixture(`gtState.status.session = null; gtState.status.provisioning = { state: 'FAILED', error: 'dispatch failed: HTTP 422' };`),
    'run in progress': () => fixture(`gtState.status.session = null; gtState.status.provisioning = { state: 'INSTALLING', log: ['a', 'b'] };`),
    'relay out of date': () => fixture(`gtState.status.session = null; gtState.status.provisioning = { state: 'FAILED', errorCode: 'BROKER_NEEDS_UPDATE' };`),
    'Tailscale tag missing (v1)': () => fixture(`gtState.status.dataPlane = 'v1'; gtState.status.session = null; gtState.status.provisioning = { state: 'FAILED', errorCode: 'ACL_TAG_NOT_PERMITTED', error: '400' };`),
    'sign-in code waiting': () => fixture(`gtState.githubStatus = { connected: true, pending: { state: 'waiting', userCode: 'AB-CD', verificationUri: 'https://github.com/login/device' } };`),
    'sign-in error': () => fixture(`gtState.githubStatus = { connected: true, pending: { state: 'error', error: 'expired' } };`),
    'no accounts at all': () => fixture(`gtState.accounts = { accounts: [] }; gtState.githubStatus = { connected: false }; gtState.status = null; gtState.engine = null;`),
    'disconnected with an error': () => fixture(`gtState.engine.engine.connected = false; gtState.engine.engine.error = 'NO_EGRESS'; gtState.lastFailure = { code: 'NO_EGRESS', message: 'x' };`),
    'firewall lease chosen': () => fixture(`gtState.engine.firewall = { enforcing: true, autoEnable: true, leased: true };`),
    'no Cloudflare account': () => { store.set('cf_accounts', '[]'); fixture(); },
};

const handlers = {
    act: run('Object.keys(GT_ACTIONS)'),
    sw: run('Object.keys(GT_SWITCHES)'),
    input: run('Object.keys(GT_INPUTS)'),
    change: run('Object.keys(GT_CHANGES)'),
    sections: run('GT_SECTIONS.map((x) => x.id)'),
};

const unhandled = new Set();
const bad = [];
for (const [name, set] of Object.entries(states)) {
    set();
    let html;
    try { html = render(); } catch (e) { t(`renders: ${name}`, false, e.stack); continue; }
    t(`renders: ${name}`, true);
    for (const [part, markup] of Object.entries(html)) {
        const m = String(markup);
        for (const x of m.matchAll(/data-gt-act="([^"]+)"/g)) if (!handlers.act.includes(x[1])) unhandled.add(`act:${x[1]} (${part})`);
        for (const x of m.matchAll(/data-gt-switch="([^"]+)"/g)) if (!handlers.sw.includes(x[1])) unhandled.add(`switch:${x[1]} (${part})`);
        for (const x of m.matchAll(/data-gt-input="([^"]+)"/g)) if (!handlers.input.includes(x[1])) unhandled.add(`input:${x[1]} (${part})`);
        for (const x of m.matchAll(/data-gt-change="([^"]+)"/g)) if (!handlers.change.includes(x[1])) unhandled.add(`change:${x[1]} (${part})`);
        for (const x of m.matchAll(/data-gt-enter="([^"]+)"/g)) if (!handlers.act.includes(x[1])) unhandled.add(`enter:${x[1]} (${part})`);
        for (const x of m.matchAll(/data-gt-go="([^"]+)"/g)) if (!handlers.sections.includes(x[1])) unhandled.add(`go:${x[1]} (${part})`);
        if (/<select(?![^>]*class="mv-popup")/.test(m)) bad.push(`${name} › ${part}: a native <select>`);
        if (/<details/.test(m)) bad.push(`${name} › ${part}: <details>`);
        if (/\son(click|change|input|keydown)=/.test(m)) bad.push(`${name} › ${part}: inline event handler`);
        if (/undefined|\[object Object\]|NaN/.test(m.replace(/<[^>]+>/g, ' '))) bad.push(`${name} › ${part}: prints undefined/NaN/[object Object]`);
    }
}
t('every control has a registered handler', unhandled.size === 0, [...unhandled].join(', '));
t('kit controls only: no native select/details, no inline handlers, nothing printed as undefined', bad.length === 0, bad.join(' · '));

// The two things the user pointed at.
states['connected v2, firewall off, partial exit']();
{
    const h = render();
    t('the exit card is the kit picker, with the flag of the chosen country',
        /mv-eng-cc-cur/.test(h.exitCard) && /assets\/flags\/jp\.svg/.test(h.exitCard) && !/<select/.test(h.exitCard));
    const fw = /<div class="mv-form-row mv-callout is-warn[^"]*">[\s\S]*?دیوارآتش ویندوز روی این سیستم خاموش است[\s\S]*?data-gt-act="fw-enable"[^>]*>/.exec(h.route);
    t('the firewall warning is a warn callout with a small button (card)', fw && /mv-btn--sm/.test(fw[0]) && !/mv-btn--primary/.test(fw[0]), fw ? fw[0].slice(-200) : 'no callout');
    t('…and the same in «مسیر و محافظ»', /mv-callout is-warn[\s\S]*?دیوارآتش ویندوز روی این سیستم خاموش است[\s\S]*?data-gt-act="fw-enable"/.test(h.network));
    t('a site rule is listed with its country and domains, and can be removed',
        /assets\/flags\/kr\.svg/.test(h.exit) && /mexc\.com/.test(h.exit) && /data-gt-act="exit-rule-remove" data-arg="0"/.test(h.exit));
    t('the rule form keeps what was typed (drafts)', (() => {
        run(`gtState.drafts['gt-exit-rule-domains'] = 'typed.example'`);
        return /typed\.example/.test(run('gtRenderExit()'));
    })());
    t('the exit in use is the live row; a failed one says so', /mv-li is-on[\s\S]*?پیش‌فرض/.test(h.exit) && /ناموفق/.test(h.exit));
    t('the provider segments offer only what the country has', (() => {
        run(`gtState.status.exitChoice.prefs.country = 'TH'`);
        const x = run('gtRenderExit()');
        return /data-arg="psiphon"[^>]*disabled/.test(x) && !/data-arg="vpngate"[^>]*disabled/.test(x);
    })());
}
states['firewall lease chosen']();
t('once chosen, the firewall lease is a switch, not a callout', /data-gt-switch="firewall"/.test(run('gtRenderNetwork()')) && !/fw-enable/.test(run('gtRenderNetwork()')));

// No legacy colours in the window's own source: tokens only (ui/tokens.css).
{
    const offenders = FILES.filter((f) => /var\(--(ide|syn)-/.test(fs.readFileSync(path.join(COMP, f), 'utf8')));
    t('no --ide-*/--syn-* tokens in the window', offenders.length === 0, offenders.join(', '));
    t('the stylesheet is scoped to the window', !!sandbox.__css
        && sandbox.__css.split('}').map((r) => r.split('{')[0].trim()).filter((s) => s && !s.startsWith('@') && !s.startsWith('/*') && !s.startsWith('from') && !s.startsWith('to'))
            .every((sel) => sel.split(',').every((p) => /#gt-wrapper/.test(p))));
}

// ── ui/mv.js › showBanner must end, whatever arrives ─────────────────────────────────────
{
    const mv = fs.readFileSync(path.join(ROOT, 'public', 'ui', 'mv.js'), 'utf8');
    const start = mv.indexOf('var TONES = [');
    const end = mv.indexOf('window.toast = function');
    const code = mv.slice(start, end);
    const mk = () => {
        const el = { children: [], className: '', parentNode: null, _l: {},
            setAttribute() {}, addEventListener() {}, classList: { add() {} },
            querySelector() { return { set textContent(v) {} }; },
            set innerHTML(v) {},
            insertBefore(n, ref) { n.parentNode = el; const i = ref ? el.children.indexOf(ref) : el.children.length; el.children.splice(i < 0 ? 0 : i, 0, n); },
            appendChild(n) { n.parentNode = el; el.children.push(n); },
            removeChild(n) { el.children.splice(el.children.indexOf(n), 1); n.parentNode = null; },
            get firstChild() { return el.children[0] || null; },
            get lastChild() { return el.children[el.children.length - 1] || null; },
            get isConnected() { return true; } };
        return el;
    };
    const body = mk();
    const bctx = vm.createContext({
        document: { createElement: mk, body },
        // Timers never fire here: every dismissed banner stays in its 200 ms exit for good,
        // which is exactly the state the old loop could not get out of.
        setTimeout: () => 0, clearTimeout() {},
        MV_bannerHook: null, Array,
    });
    let ended = true, err = '';
    try {
        vm.runInContext(`${code}; for (var n = 0; n < 8; n++) showBanner('پیام ' + n);`, bctx, { timeout: 2000 });
    } catch (e) { ended = false; err = e.message; }
    t('a fourth, fifth… banner never freezes the window (showBanner returns)', ended, err);
    const host = body.children[0];
    const staying = host ? host.children.filter((c) => !c.__mvLeaving).length : -1;
    t('at most three banners stay; older ones are on their way out', staying === 3, `staying=${staying}`);
}

// ── report ──────────────────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${!r.pass && r.detail ? `\n      ${String(r.detail).slice(0, 600)}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
