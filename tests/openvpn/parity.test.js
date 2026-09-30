// «این بخش باید دقیقا همون امکانات گیت وی رو داشته باشه» — the gateway ↔ OpenVPN.
//
// tests/gateway/parity.test.js is the gateway's feature list, kept executable. This is the same
// list again, asserted against the OpenVPN window — so a capability that exists there and not
// here fails HERE, instead of being discovered by the user.
//
// Each row names one capability, the gateway's proof of it, and what must exist on the OpenVPN
// side for it to be real. Where the two genuinely differ the row says why, because «the same
// features» does not mean «the same engine»: the gateway drives SoftEther's own client and has a
// UDP-acceleration switch; this one drives openvpn.exe DIRECTLY — no front, no picker (the user's
// rule, 2026-09-30) — through a local split relay for TCP relays (the manager's directPath).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return null; } };

const gwPanel = read('public/components/gateway.js') || '';
const gwManager = read('gateway-manager.js') || '';

const manager = read('openvpn-manager.js') || '';
const catalog = read('openvpn-catalog.js') || '';
const creds = read('openvpn-creds.js') || '';
const panel = read('public/components/openvpn.js') || '';
const server = read('server.js') || '';
const apps = read('public/shell/apps.js') || '';
const menubar = read('public/shell/menubar.js') || '';
const widgets = read('public/shell/widgets.js') || '';

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

/**
 * One capability. `gw` is the proof it exists on the gateway side; `ov` the proof it exists here.
 * Both are lists of [source, pattern] and every one of them must match.
 */
function parity(name, gw, ov) {
    const missGw = gw.filter(([src, re]) => !src || !re.test(src)).length;
    if (missGw) {
        // The gateway moved. That is not an OpenVPN failure, but it does mean this row no longer
        // proves what it claims, so it says so rather than passing quietly.
        t(name + ' — (مرجع گیت‌وی عوض شده؛ این ردیف را به‌روز کنید)', false, 'gateway pattern missed');
        return;
    }
    const miss = ov.filter(([src, re]) => !src || !re.test(src)).length;
    t(name, miss === 0, miss ? `${miss} pattern(s) missing` : '');
}

t('the gateway sources are present to compare against', !!(gwPanel && gwManager));

// ── 1. the archive, and the two lists over it ────────────────────────────────────────────────
//
// The rows are SHARED — one archive on disk, read through gateway-manager — and everything the
// user does to them is not. That is what the user asked for: «آرشیو مشترک باشه مشکلی نیست، فقط
// برای openvpn توی همون صفحه خودش باید نمایش داده بشه و پینگ گرفته بشه با موتور خودش».

parity('«آرشیو» — every relay ever seen is kept, not replaced',
    [[gwManager, /function lists\(\)/], [gwManager, /function mergeLists\(/]],
    [[catalog, /function lists\(\)/], [catalog, /function archiveRows\(\)/],
    [catalog, /require\('\.\/gateway-manager'\)/]]);

t('…and the archive is READ from the gateway, never rewritten by this engine',
    /gw\.servers\(\)/.test(catalog) && !/writeFileSync\([^)]*livePath/.test(catalog),
    'openvpn-catalog must not write the shared CSV');

t('…while the curation is this engine\'s own file, so the two windows stay independent',
    /'\.mlmvpn', 'openvpn'/.test(catalog) && /function curationPath\(\)/.test(catalog));

parity('«فهرست من» — live + kept − hidden, and the connect button chooses from it',
    [[gwManager, /const mine = archive\.filter/], [gwManager, /function liveHosts\(\)/],
    [gwPanel, /data-gw-scope="mine"/], [gwPanel, /data-gw-scope="archive"/]],
    [[catalog, /const mine = archive\.filter/], [catalog, /function liveHosts\(\)/],
    [panel, /data-ov-scope="mine"/], [panel, /data-ov-scope="archive"/]]);

parity('promoting a relay out of the archive («افزودن به فهرست من»)',
    [[gwManager, /function keep\(hosts\)/], [server, /case 'keep':/]],
    [[catalog, /function keep\(hosts\)/], [server, /case 'keep': return res\.json\(\{ ok: true, n: openvpn\.keep/]]);

parity('deleting from «فهرست من» is a deny-list, so a refresh cannot undo it',
    [[gwManager, /function hide\(hosts\)/], [gwManager, /cur\.hidden/]],
    [[catalog, /function hide\(hosts\)/], [catalog, /c\.hidden/]]);

parity('deleting from «آرشیو» removes the row from THIS engine\'s list',
    [[gwManager, /function purge\(hosts\)/]],
    [[catalog, /function purge\(hosts\)/], [catalog, /c\.purged/]]);

parity('«بازگرداندن حذف‌شده‌ها» — the undo a bulk delete must have',
    [[gwManager, /function restoreHidden\(\)/], [gwPanel, /بازگرداندن/]],
    [[catalog, /function restoreHidden\(\)/], [panel, /بازگرداندن/]]);

t('…and it restores BOTH deletions, because the user pressed one button called «حذف»',
    /c\.hidden = \[\];[\s\S]{0,40}c\.purged = \[\];/.test(catalog));

// ── 2. the two tests ─────────────────────────────────────────────────────────────────────────

parity('«پینگ» over a whole list, with progress',
    [[gwManager, /startSweep\(/], [gwPanel, /data-gw-act="ping"/]],
    [[manager, /async function startSweep\(/], [manager, /'ping'/], [panel, /data-ov-act="ping"/]]);

parity('«تست واقعی» — a real handshake, not a TCP connect',
    [[gwManager, /require\('\.\/gateway-probe'\)/], [gwPanel, /data-gw-act="probe"/]],
    [[manager, /Initialization Sequence Completed/], [panel, /data-ov-act="probe"/]]);

t('…and here that means a real OPENVPN connection, through this engine\'s own core',
    /--dev', 'null'/.test(manager) && /'--route-nopull'/.test(manager) && /EXE/.test(manager),
    'probe must dial openvpn.exe on a throwaway device');

parity('…and it says WHICH step failed, not merely that it did',
    [[gwPanel, /PROBE_FAIL/]],
    [[panel, /const PROBE_FAIL = \{/], [panel, /دست‌دادن نیمه‌کاره ماند/]]);

t('…and those reasons are the ones openvpn.exe can actually report, not the gateway probe\'s',
    /auth:/.test(panel) && !/not-softether/.test(panel.replace(/\/\*[\s\S]*?\*\//g, '')));

parity('the sweep reports progress and can be stopped',
    [[gwManager, /function cancelSweep\(\)/], [gwManager, /function sweepState\(\)/],
    [server, /\/api\/gateway\/test\/cancel/], [gwPanel, /data-gw-act="stop"/]],
    [[manager, /function cancelSweep\(\)/], [manager, /function sweepState\(\)/],
    [server, /\/api\/openvpn\/test\/cancel/], [panel, /data-ov-act="stop"/], [panel, /ov-sweep/]]);

t('…and a real-test sweep dials each relay the way a connection would: direct, through the relay',
    /const r = await probe\(row\.host, 20000\);/.test(manager) && /async function probe\(host, budgetMs\)/.test(manager)
    && /await directPath\(server\)/.test(manager));

// ── 3. finding a relay in a list of hundreds ─────────────────────────────────────────────────

parity('search over country name, code and hostname',
    [[gwPanel, /id="gw-q"/]],
    [[panel, /id="ov-q"/], [panel, /countryName\(r\.cc\)\.toLowerCase\(\)\.indexOf\(q\)/]]);

t('…and typing does not rebuild the tool band, or the caret goes with it',
    /renderServers\(\);[\s\S]{0,700}ovWire\(\);/.test(panel) && /NOT paint\(\)/.test(panel));

parity('a country filter, multi-select',
    [[gwPanel, /renderCountries/]],
    [[panel, /function renderCountries\(\)/], [panel, /st\.countries/], [panel, /data-cc=/]]);

parity('seven sort orders, each with its own explanation',
    [[gwPanel, /const SORTS = \[/]],
    [[panel, /const SORTS = \[/], [panel, /تست‌شده‌ها اول/], [panel, /رسمی‌ها اول/],
    [panel, /سریع‌ترین/], [panel, /امتیاز/], [panel, /پهنای باند/], [panel, /کاربران/], [panel, /کشور/]]);

// ── 4. acting on many at once ────────────────────────────────────────────────────────────────

parity('«انتخاب» — bulk select, with «سالم‌ها» to check the proven ones',
    [[gwPanel, /st\.selecting/], [gwPanel, /data-gw-act="check-healthy"/], [gwManager, /function healthyHosts\(/]],
    [[panel, /st\.selecting/], [panel, /data-ov-act="check-healthy"/], [catalog, /function healthyHosts\(/]]);

parity('«حذف سرورهای قطع» removes only what a test condemned, never the untested',
    [[gwManager, /function deadHosts\(/], [gwPanel, /data-gw-act="remove-dead"/]],
    [[catalog, /function deadHosts\(/], [panel, /function deadOf\(/], [panel, /data-ov-act="remove-dead"/]]);

parity('…and a bulk delete asks first, with the count and what it means',
    [[gwPanel, /function confirmRemove\(/], [gwPanel, /uiModal\.confirm/]],
    [[panel, /function confirmRemove\(/], [panel, /uiModal\.confirm/]]);

// ── 5. the per-server page and the guide ─────────────────────────────────────────────────────

parity('a page per relay: both measurements, the relay\'s own facts, and the actions',
    [[gwPanel, /function renderDetail\(\)/], [gwPanel, /سیاست نگهداری لاگ/]],
    [[panel, /function renderDetail\(\)/], [panel, /سیاست نگهداری لاگ/], [panel, /گردانندهٔ سرور/],
    [panel, /مدت روشن بودن/]]);

parity('«راهنمای سرورها» — what the two lists are, what the two tests mean',
    [[gwPanel, /function renderGuide\(\)/], [gwPanel, /دو فهرست/], [gwPanel, /دو تست/]],
    [[panel, /function renderGuide\(\)/], [panel, /دو فهرست/], [panel, /دو تست/]]);

t('…and it also explains the direct path and its local relay, with the measurement',
    /اتصال مستقیم — و چرا یک رلهٔ محلی/.test(panel) && /دست‌دادن/.test(panel));

// ── 6. the list's own state ──────────────────────────────────────────────────────────────────

parity('«به‌روزرسانی فهرست» says how old the list is, and warns when it is stale',
    [[gwPanel, /function ago\(/], [gwPanel, /const STALE_MS/]],
    [[panel, /function ago\(/], [panel, /const STALE_MS/]]);

parity('…and how many relays the refresh newly discovered',
    [[gwPanel, /سرور تازه پیدا شد/]],
    [[panel, /' سرور تازه'/]]);
t('…and, here, how many of them we now have an OpenVPN port for',
    /پورت ' \+ fa\(out\.portsKnown\) \+ ' سرور معلوم شد/.test(panel));

// ── 6b. the relay's real OpenVPN port ────────────────────────────────────────────────────────
//
// Reported 2026-09-21: «تست واقعی» said «موتور بیرون آمد» on every volunteer relay. It was not
// the relays. VPN Gate's CSV has no port column — the port lives inside the base64 profile the
// gateway drops — so 317 of 323 volunteer rows were being dialled on 443, which only official
// relays serve. A wrong door reads exactly like a dead house.

t('the real port is harvested from the VPN Gate profile, on its way past the gateway',
    /function harvestPorts\(rawCsv\)/.test(catalog)
    && /require\('\.\/openvpn-catalog'\)\.harvestPorts\(raw\)/.test(gwManager));
t('…and the harvest can never cost the gateway its list',
    /try \{ require\('\.\/openvpn-catalog'\)\.harvestPorts\(raw\); \} catch/.test(gwManager));
t('…and the mirror is a second, free source of the same fact',
    /function notePorts\(rows\)/.test(catalog) && /notePorts\(/.test(server));
t('…and the refresh button refreshes the SHARED archive, which is where ports come from',
    /gateway\.refreshServers\(/.test((server.match(/app\.post\('\/api\/openvpn\/refresh'[\s\S]{0,1800}/) || [''])[0]));
t('a relay whose port we have never seen is SKIPPED by a sweep, not recorded as a failure',
    /const targets = all\.filter\(\(r\) => r\.ovpnKnown\);/.test(manager)
    && /const skipped = all\.length - targets\.length;/.test(manager));
t('…and it can never be counted dead, so «حذف خراب‌ها» cannot offer to delete it',
    /if \(!portFor\(h\)\.known\) return false;/.test(catalog));
t('…and the row says «پورت نامعلوم» rather than «تست نشده» or a failure',
    /پورت نامعلوم/.test(panel) && /function noPort\(host\)/.test(panel));
t('…and «موتور بیرون آمد» is gone: an exhausted retry is reported as what it means',
    !/موتور بیرون آمد/.test(panel) && /fin\(false, 'unreachable'\)\);/.test(manager));

// ── 7. the session ───────────────────────────────────────────────────────────────────────────

parity('a session clock',
    [[gwPanel, /function duration\(/], [gwPanel, /مدت اتصال/]],
    [[panel, /function duration\(/], [panel, /مدت اتصال/]]);

parity('a relay is chosen for the user rather than leaving the button blank',
    [[gwManager, /function suggest\(\)/], [server, /suggested: gateway\.suggest\(\)/]],
    [[catalog, /function suggest\(\)/], [server, /suggested: openvpn\.suggest\(\)/]]);

parity('switching relay while connected MOVES the tunnel',
    [[gwPanel, /was\.connected && was\.host !== host/]],
    [[panel, /was\.connected && was\.host !== host/]]);

parity('the session card names the path the traffic is really on',
    [[gwPanel, /مسیر واقعی داده/]],
    [[panel, /<span>مسیر داده<\/span>/], [panel, /s\.path === 'split'/]]);

// ── 8. what is genuinely this engine's own ───────────────────────────────────────────────────
//
// The gateway has a UDP switch here. This engine is DIRECT, and that is the user's rule: «به هیچ
// عنوان نباید گزینهٔ دیگری مثل سایفون باشد». What made the raw path work is measured, not assumed:
// on the raw line a plain relay was reset 2 of 2 times, the split relay connected in ~5 s 2 of 2.

t('connect is direct: no front, no SOCKS carrier, no Psiphon started by this engine',
    !/ensureFront|resolveVia|frontMode|--socks-proxy|startPsiphon/.test(manager));
t('…a VPN Gate TCP relay is dialled through the loopback split relay, with a bypass route for its socket',
    /async function directPath\(/.test(manager) && /new SplitRelay\(\[ip\], port/.test(manager)
    && /route \$\{ip\} 255\.255\.255\.255 net_gateway/.test(manager) && /remote 127\.0\.0\.1 \$\{rport\} tcp-client/.test(manager));
t('…the relay lives exactly as long as the process it carries',
    /state\.relay = relay;/.test(manager) && /if \(state\.relay\) state\.relay\.close\(\)/.test(manager));
t('…the panel offers no path to choose, and never mentions starting another engine',
    !/data-ov-front=|function frontOptions|function setFront|\/api\/openvpn\/front/.test(panel)
    && !/سایفون خودش بالا می‌آید/.test(panel));
t('…and the server has no front route and ignores any «via» a page sends',
    !/\/api\/openvpn\/front/.test(server.replace(/\/\/.*$/gm, '')) && !/via: \(req\.body && req\.body\.via\)/.test(server));

// The profile the gateway's archive cannot supply.
t('a profile is built from an archive row, because the shared archive carries none',
    /function buildProfile\(row, opts\)/.test(catalog) && /creds\.CA/.test(catalog));
t('…from VPN Gate\'s one shared client certificate, verified identical across every profile',
    /module\.exports = \{ CA, CERT, KEY \}/.test(creds) && /0 mismatches/.test(creds));
t('…and it carries BOTH cipher lines, or openvpn.exe negotiates AEAD and refuses the data channel',
    /'cipher AES-128-CBC'/.test(catalog) && /'data-ciphers AES-128-CBC'/.test(catalog)
    && /'data-ciphers-fallback AES-128-CBC'/.test(catalog));

// ── 9. it must look and behave like the rest of THIS app ─────────────────────────────────────

t('the panel is built from the page kit, like every other engine window',
    /class="mv-split"/.test(panel) && /mv-eng-stage/.test(panel) && /mv-side-item/.test(panel));
t('…its flags are SVG, because Windows renders emoji flags as boxed letters',
    /assets\/flags\//.test(panel) && !/getNodeFlagEmoji/.test(panel));
t('…its country names come from Intl, not from a hand-written table of two dozen',
    /Intl\.DisplayNames\(\['fa'\]/.test(panel));
{
    const css = (panel.match(/#ov-wrap \{[^}]*\}/) || [''])[0];
    t('the panel wrapper creates no stacking context, or the back button is unclickable',
        /position:\s*relative/.test(css) && !/z-index/.test(css), css);
}
t('«حذف خراب‌ها» is in the toolbar itself, not behind a mode',
    /data-ov-act="remove-dead"/.test((panel.match(/<div class="ov-tb">[\s\S]*?<\/div>/) || [''])[0]));
t('…and it is absent when nothing has failed, rather than offering a no-op',
    /\$\{dead\.length \? `<button type="button" data-ov-act="remove-dead"/.test(panel));

// The engine lamp. Both of these lists are hand-written, and an engine missing from one is an
// engine the desktop swears is off while its own window says it is connected.
t('the desktop connection widget knows this engine',
    /'openvpn'/.test((widgets.match(/var ENGINES = \[[\s\S]*?\];/) || [''])[0]));
t('…and so does the menubar',
    /'openvpn'/.test((menubar.match(/var ENGINE_ORDER = \[[\s\S]*?\];/) || [''])[0]));
t('…and the lamp reads the panel\'s own probe rather than a global that may not exist',
    /MVProbe\.openvpn/.test(apps) && /window\.MVProbe\.openvpn = /.test(panel));
t('…and the window\'s onShow refreshes instead of re-running init, which would re-hide the page',
    /window\.openvpnRefresh/.test(apps) && !/initOpenVpnModule\(\);/.test(apps));
t('…and a second init is a no-op rather than a rebuild that throws away the user\'s place',
    /if \(\$\('ov-wrap'\)\) \{ refresh\(\); return; \}/.test(panel));

t('every string the user reads is Persian',
    /جست‌وجوی کشور یا نام سرور/.test(panel) && /تست واقعی/.test(panel) && /فهرست من/.test(panel));

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
assert.ok(true);
process.exit(failed ? 1 : 0);
