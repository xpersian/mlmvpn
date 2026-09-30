// --- GitHub Tunnel: «آزمون نشتی» ---
//
// Four questions about the FULL tunnel, each answered by what the far end actually saw — never by
// the app's own idea of its state. A switch that reads «connected» proves nothing; the report the
// user got on 2026-09-22 («وارد یکسری سایت ها میشن میزنه ایران») came from a tunnel that was up and
// carrying traffic while the name lookups beside it were not.
//
//   1. ADDRESS  An ordinary request from this app — it rides the adapter like any program. The
//               address ip-api.com sees must be the runner's (the same one the engine reports
//               through its own port) and not the line's (captured before the tunnel came up).
//   2. DNS      Whose resolver looked up a name nobody has looked up before. edns.ip-api.com
//               redirects to a fresh random name and reports the resolver that asked its servers
//               for it; an Iranian resolver there is the leak itself.
//   3. UDP      The path WebRTC and games use: the reflexive address a STUN server reports for a
//               datagram sent the ordinary way. The line's own address there is the classic
//               WebRTC leak.
//   4. IPv6     A connection to an IPv6-only address must FAIL — or the line has no IPv6 at all.
//
// Plain HTTP only: TLS over a hand-made socket crashes on this machine class, and none of these
// services needs TLS to answer. Nothing here changes any state.

'use strict';

const http = require('http');
const net = require('net');
const os = require('os');
const dns = require('dns').promises;

const IP_PATH = '/json/?fields=status,countryCode,country,city,isp,query';
const V6_TARGET = '2606:4700:4700::1111';   // Cloudflare's resolver, IPv6 only

function httpGet(url, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve) => {
        let req;
        try {
            req = http.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { if (body.length < 65536) body += c; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
                res.on('error', () => resolve({ status: 0, body: '' }));
            });
        } catch (e) { return resolve({ status: 0, body: '', error: e.message }); }
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
        req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    });
}

function parseJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/** «Phoenix / United States» — one Latin run, however the panel lays the sentence out. */
const place = (w) => [w.city, w.countryName || w.country].filter(Boolean).join(' / ');

/** What a website sees of this machine, asked the ordinary way (whatever route the OS picks). */
async function whoAmI({ timeoutMs = 10000 } = {}) {
    const r = await httpGet(`http://ip-api.com${IP_PATH}`, { timeoutMs });
    const j = parseJson(r.body);
    if (!j || j.status !== 'success') return null;
    return { ip: j.query, country: j.countryCode, countryName: j.country, city: j.city, isp: j.isp };
}

/**
 * The line's own identity, taken BEFORE the tunnel owns the route (routes.js calls it on the way
 * up). Kept so the address check can say «your real address X is hidden», not only «the address
 * is the runner's».
 */
const lineIdentity = (opts) => whoAmI(opts);

/** The resolver that answered a name nobody has looked up before. */
async function resolverSeen({ timeoutMs = 12000 } = {}) {
    const first = await httpGet('http://edns.ip-api.com/json', { timeoutMs });
    const next = first.headers && first.headers.location;
    // The redirect target is a fresh random name — that is what makes the answer about THIS lookup.
    if (!(first.status >= 300 && first.status < 400) || !/^http:\/\/[a-z0-9]+\.edns\.ip-api\.com\/json$/i.test(String(next || ''))) {
        return null;
    }
    const r = await httpGet(next, { timeoutMs });
    const j = parseJson(r.body);
    if (!j || !j.dns || !j.dns.ip) return null;
    const geo = String(j.dns.geo || '');
    // «Iran - Telecommunication Infrastructure Company»: the country is the text before « - ».
    const country = geo.split(' - ')[0].trim();
    // The client subnet the resolver passed on (EDNS Client Subnet), when it passed one: an
    // Iranian subnet there tells every CDN where the user is, whatever resolver carried it.
    const ecsGeo = String((j.edns && j.edns.geo) || '');
    return {
        ip: j.dns.ip, geo, countryName: country, iran: /^iran\b/i.test(country),
        ecs: j.edns && j.edns.ip ? { ip: j.edns.ip, geo: ecsGeo, iran: /^iran\b/i.test(ecsGeo) } : null,
    };
}

/** «United States» for the exit, from its name or its two-letter code. */
function countryNameOf(w) {
    if (!w) return '';
    if (w.countryName) return String(w.countryName);
    if (/^[A-Z]{2}$/.test(String(w.country || ''))) {
        try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(w.country) || ''; } catch (e) { return ''; }
    }
    return '';
}
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** The reflexive address a STUN server reports for an ordinary datagram from this machine. */
async function udpSeen({ timeoutMs = 5000 } = {}) {
    const nat = require('../game/nat');
    const servers = [];
    for (const s of nat.SERVERS) {
        try { const a = await dns.lookup(s.host, { family: 4 }); servers.push({ ...s, ip: a.address }); } catch (e) { /* the others */ }
    }
    if (!servers.length) return null;
    const r = await nat.probeAll(servers, { timeoutMs });
    const answers = (r && r.answers) || [];
    if (!answers.length) return { answered: 0, mapped: [] };
    return { answered: answers.length, mapped: [...new Set(answers.map((a) => a.ip))] };
}

/** Does this machine have a global IPv6 address on a real adapter at all? */
function globalIpv6Addresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (/mlmvpn|loopback/i.test(name)) continue;
        for (const a of list || []) {
            if (a.family === 'IPv6' && !a.internal && /^[23]/.test(a.address)) out.push(a.address);
        }
    }
    return out;
}

/**
 * Did an IPv6 request REACH the internet — asked of the far end, never of our own socket.
 *
 * A completed TCP handshake proves nothing here. The tunnel's own stack accepts every
 * connection that enters the adapter and only then applies its rules, and IPv6 is refused
 * there — so the handshake «succeeds» in a few milliseconds and the far end never hears a
 * byte. Measured on the reporting machine, 2026-09-23: connect in 5 ms, then closed with
 * nothing received; `curl -6` said «Empty reply from server». The first version of this check
 * called that a leak. Only an HTTP answer from Cloudflare counts as «reached»; its trace, when
 * it gives one, says which address it saw.
 */
function ipv6Seen({ timeoutMs = 6000 } = {}) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let data = '';
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            s.destroy();
            const reached = /^HTTP\/1\.[01] \d{3}/.test(data);
            const ip = (data.match(/^ip=([0-9a-fA-F:.]+)\s*$/m) || [])[1] || null;
            resolve({ reached, ip });
        };
        s.setTimeout(timeoutMs);
        s.on('connect', () => s.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: [${V6_TARGET}]\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`));
        s.on('data', (d) => { if (data.length < 16384) data += d; });
        s.on('end', finish);
        s.on('close', finish);
        s.on('timeout', finish);
        s.on('error', finish);
        try { s.connect(80, V6_TARGET); } catch (e) { finish(); }
    });
}

/** Whether an address the far end reported is this machine's own (its /64 is enough). */
function isOwnV6(ip, own) {
    if (!ip) return false;
    const prefix = (a) => String(a).toLowerCase().split(':').slice(0, 4).join(':');
    return own.some((a) => a.toLowerCase() === String(ip).toLowerCase() || prefix(a) === prefix(ip));
}

/**
 * Run the four checks against the full tunnel.
 *
 * @param exit  where the engine says traffic leaves (gt-core's own measurement through its SOCKS
 *              port) — the reference the other answers must match
 * @param line  the line's identity from before the tunnel came up, or null
 * @param appRouting  «مسیر برنامه‌ها» as the tunnel applies it: a split the user chose is not a
 *              leak of the tunnel, but a report that stayed silent about it would mislead
 */
async function run({ exit = null, line = null, appRouting = null, tunnelResolver = null, probes = {} } = {}) {
    // `probes` replaces the network for tests; the verdicts below are the part worth pinning.
    const p = { whoAmI, resolverSeen, udpSeen, ipv6Seen, globalIpv6Addresses, ...probes };
    const [seen, resolver, udp, v6] = await Promise.all([
        Promise.resolve().then(() => p.whoAmI()).catch(() => null),
        Promise.resolve().then(() => p.resolverSeen()).catch(() => null),
        Promise.resolve().then(() => p.udpSeen()).catch(() => null),
        Promise.resolve().then(() => p.ipv6Seen()).catch(() => ({ reached: false, ip: null })),
    ]);
    const hasV6 = p.globalIpv6Addresses();
    const checks = [];
    const fa = (n) => Number(n).toLocaleString('fa-IR');

    // 1. The address.
    if (!seen) {
        checks.push({ id: 'ip', status: 'unknown', fa: 'آدرس: پاسخی از سرویس سنجش نیامد — دوباره امتحان کنید.' });
    } else {
        const isLine = !!(line && line.ip && seen.ip === line.ip);
        const matchesExit = !!(exit && exit.ip && seen.ip === exit.ip);
        const iran = seen.country === 'IR';
        const ok = !isLine && !iran && (!exit || !exit.ip || matchesExit);
        checks.push({
            id: 'ip', status: ok ? 'pass' : 'fail',
            seen, line: line ? { ip: line.ip, country: line.country } : null,
            fa: ok
                ? `آدرس: سایت‌ها ${seen.ip} را می‌بینند، در ${place(seen)} — آدرس سرور شما${line && line.ip ? `، نه ${line.ip}` : ''}.`
                : isLine || iran
                    ? `آدرس: سایت‌ها آدرس واقعی شما را می‌بینند: ${seen.ip}${seen.country ? ` در ${place(seen)}` : ''} — نشت.`
                    : `آدرس: سایت‌ها ${seen.ip} را می‌بینند، ولی خروجی تونل ${exit.ip} است — بخشی از ترافیک از مسیر دیگری می‌رود.`,
        });
    }

    // 2. DNS.
    if (!resolver) {
        checks.push({ id: 'dns', status: 'unknown', fa: 'DNS: سرویس سنجش پاسخ نداد — دوباره امتحان کنید.' });
    } else if (resolver.iran || (resolver.ecs && resolver.ecs.iran)) {
        checks.push({
            id: 'dns', status: 'fail', resolver,
            fa: resolver.iran
                ? `DNS: نام سایت‌ها را ${resolver.geo || resolver.ip} پیدا می‌کند — نشت DNS؛ سایت‌هایی که از روی DNS تصمیم می‌گیرند ایران را می‌بینند.`
                : `DNS: درخواست‌ها با نشانی شبکهٔ ایرانی شما به سایت‌ها می‌رسند: ${resolver.ecs.geo} — نشت DNS.`,
        });
    } else {
        // In the resolver's country = the server's country. NOT «the tunnel's resolver»: the
        // runner resolves every name a second time itself, with its own resolver, and that is
        // the lookup the far end sees (measured: tunnel built on 8.8.8.8, report said «United
        // States - Cloudflare»). A lookup that left from here instead lands on the resolver's
        // nearest point to Iran — on the bare line the same report said «Germany - Cloudflare».
        const exitCountry = countryNameOf(exit);
        const sameCountry = !exitCountry || sameName(resolver.countryName, exitCountry);
        checks.push({
            id: 'dns', status: sameCountry ? 'pass' : 'warn', resolver,
            fa: sameCountry
                ? `DNS: نام سایت‌ها را ${resolver.geo || resolver.ip} پیدا می‌کند — در کشور سرور شما، بیرون از ایران.`
                : `DNS: نام سایت‌ها را ${resolver.geo || resolver.ip} پیدا می‌کند — بیرون از ایران، ولی نه در کشور سرور شما، ${exitCountry}؛ یک بار دیگر آزمون را بزنید.`,
        });
    }

    // 3. UDP (WebRTC).
    if (!udp || !udp.answered) {
        checks.push({ id: 'udp', status: 'unknown', fa: 'WebRTC/UDP: هیچ سرور STUN جواب نداد — یعنی دست‌کم آدرس واقعی شما هم از این راه لو نمی‌رود.' });
    } else {
        const leaked = udp.mapped.filter((ip) => (line && ip === line.ip));
        const foreignToExit = exit && exit.ip ? udp.mapped.filter((ip) => ip !== exit.ip && !leaked.includes(ip)) : [];
        const ok = !leaked.length;
        checks.push({
            id: 'udp', status: ok ? 'pass' : 'fail', mapped: udp.mapped,
            fa: ok
                ? `WebRTC/UDP: سرورهای STUN آدرس ${udp.mapped.join(' و ')} را می‌بینند${foreignToExit.length ? '' : ' — همان سرور شما'}.`
                : `WebRTC/UDP: سرورهای STUN آدرس واقعی شما را می‌بینند: ${leaked.join(' و ')} — نشت WebRTC.`,
        });
    }

    // 4. IPv6.
    if (!hasV6.length) {
        checks.push({ id: 'ipv6', status: 'pass', fa: 'IPv6: این خط آدرس IPv6 ندارد — چیزی برای نشت نیست.' });
    } else {
        // Reached = the far end ANSWERED over IPv6. The tunnel refuses IPv6, so an answer means
        // it went some other way — unless the address it saw is provably not ours.
        const reached = !!(v6 && v6.reached);
        const foreign = reached && v6.ip && !isOwnV6(v6.ip, hasV6);
        const leak = reached && !foreign;
        checks.push({
            id: 'ipv6', status: leak ? 'fail' : 'pass', addresses: hasV6.length, seen: v6 && v6.ip ? v6.ip : null,
            fa: leak
                ? `IPv6: یک درخواست IPv6 به اینترنت رسید${v6.ip ? ` و طرف مقابل ${v6.ip} را دید` : ''} — آدرس IPv6 واقعی شما در دسترس سایت‌هاست. «قفل IPv6» را روشن کنید.`
                : foreign
                    ? `IPv6: درخواست IPv6 از تونل رفت و طرف مقابل ${v6.ip} را دید، نه آدرس شما.`
                    : `IPv6: این خط ${fa(hasV6.length)} نشانی IPv6 دارد، ولی هیچ درخواست IPv6 به اینترنت نرسید.`,
        });
    }

    // Not a check: what the user chose themselves.
    let note = '';
    if (appRouting && appRouting.mode === 'bypass' && appRouting.count) {
        note = `«مسیر برنامه‌ها»: ${fa(appRouting.count)} برنامه به انتخاب خودتان بیرون از تونل می‌روند — آن‌ها با آدرس واقعی شما دیده می‌شوند.`;
    } else if (appRouting && appRouting.mode === 'allow' && appRouting.count) {
        note = `«مسیر برنامه‌ها»: فقط ${fa(appRouting.count)} برنامهٔ انتخاب‌شده از تونل می‌روند؛ بقیه به انتخاب خودتان با آدرس واقعی بیرون می‌روند.`;
    }

    const failed = checks.filter((c) => c.status === 'fail').length;
    const unsure = checks.filter((c) => c.status === 'unknown' || c.status === 'warn').length;
    return {
        at: Date.now(),
        verdict: failed ? 'leak' : unsure ? 'partial' : 'clean',
        checks,
        note,
    };
}

module.exports = { run, lineIdentity, whoAmI, resolverSeen, udpSeen, ipv6Seen, isOwnV6, globalIpv6Addresses };
