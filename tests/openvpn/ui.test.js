// «اوپن‌وی‌پی‌ان» — the window's redesign (2026-10-01), as rules that must not quietly come undone.
//
// The user: «بخش OPEN VPN، حساب‌ها و پروفایل‌ها خیلی UI بدی داره و اصلا هماهنگ نیست — کلا سیستم
// OPEN VPN باید از اول UIش طراحی بشه، هماهنگ با مک او اس جدید». What was wrong, concretely: the
// TunnelBear page was forty-seven blue «اتصال» buttons, the account form was a native radio and two
// bare inputs that the 4-second poll could wipe, and the power button only knew one of the three
// sources. parity.test.js keeps the FEATURES; this keeps the SHAPE.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const frame = read('public/components/openvpn.js');
const pages = read('public/components/openvpn-profiles.js');
const both = frame + '\n' + pages;
// Markup only: comments say what used to be there, and may name it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// ── macOS controls, not Windows ones ─────────────────────────────────────────────────────────
t('no native <select> anywhere in the window', !/<select[\s>]/.test(code(both)));
t('no native radio or checkbox — choices are kit marks and switches',
    !/type="(radio|checkbox)"/.test(code(both)));
t('no inline handlers in the markup (the flag image\'s onerror is the one exception)',
    !/\son(click|change|input|keydown)=/.test(code(both)));
t('the account form is a K8 sheet over the window', /class="mv-sheet"/.test(pages) && /mv-sheet-foot/.test(pages)
    && /function openSheet\(/.test(pages));
t('…and typing into it survives the poll: the sheet is outside the repainted page',
    /sheetHost/.test(pages) && /id="ov-sheet-host"/.test(frame));
t('auto-switch is the kit switch, not a checkbox', /class="mv-switch" role="switch"/.test(pages) && /mv-change/.test(pages));
t('fields are kit fields', /class="mv-field mv-field--tech ovp-field"/.test(pages));

// ── choose, then connect ─────────────────────────────────────────────────────────────────────
t('a TunnelBear or profile row CHOOSES; there is no per-row «اتصال» button any more',
    /data-ovp-pick=/.test(pages) && !/data-ovp="connect"/.test(pages));
t('the one connect path serves all three sources', /async function connectTarget\(\)/.test(frame)
    && /t\.kind === 'gate'\) return doConnect\(/.test(frame) && /return doConnectProfile\(t\.id\)/.test(frame));
t('«مقصد اتصال» switches source on the home page', /function renderDest\(\)/.test(frame) && /data-ov-kind=/.test(frame));
t('the live connection becomes the destination (a «سریع‌ترین» the server picked included)',
    /Whatever is carrying traffic IS the destination/.test(frame));
t('the chosen row and the live row never share a look', /is-on/.test(pages) && /is-sel/.test(pages)
    && /\.ov-table tr\.ov-tr\.is-sel/.test(frame) && /\.ov-table tr\.ov-tr\.is-on/.test(frame));
t('the compact connect button sits in the title band on every page but the hero\'s',
    /function renderBarAction\(\)/.test(frame) && /id="ov-bar-action"/.test(frame));

// ── the VPN Gate list is a macOS table ───────────────────────────────────────────────────────
t('servers are a K4 table with sortable column headers', /class="mv-table ov-table"/.test(frame) && /data-sortcol=/.test(frame));
t('…and a narrow window folds columns instead of scrolling sideways', /@container \(max-width: 660px\)/.test(frame));

// ── small things that were wrong once ────────────────────────────────────────────────────────
t('a zero count is left blank (a Persian zero reads as a status dot)', /const n = \(x\) => \(x \? fa\(x\) : ''\);/.test(frame));
t('values on the server page are .mv-form-value, not the kit\'s 18px icon slot', /mv-form-value ov-val/.test(frame));
t('only .ovpn files are offered as profiles (a .conf would silently become a companion)',
    !/accept="[^"]*\.conf/.test(pages));
t('a new profile is found by NAME — the import answers with names, not ids',
    /x\.name === r\.added\[0\]/.test(pages));
t('the guide no longer tells anyone to change «مسیر عبور», which was removed on 2026-09-30',
    !/مسیر عبور/.test(frame));

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
