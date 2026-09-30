// --- scan-scout.js — where to scan, learned on the spot, and a one-second «alive» test ---
//
// Port of Android's data/ScanScout.kt. Measured on the phone, 2026-09-28, after Iran's filtering
// was tightened: of 16 Cloudflare ranges only 172.67.0.0/16 still carried traffic (33 of 60
// addresses answered a WebSocket upgrade on BPB's own path); almost everywhere else TCP was
// closed, or TLS completed and the request was never answered. The scanner walked the ranges in
// a fixed order — 2,048 /24s of 104.16.0.0/13 before 172.67 — so its test budget was spent on
// silent addresses and it found nothing, and «silent» addresses that pass TCP each wasted up to
// ten seconds of real test.
//
//  - order() samples every range with the real check first and puts the ranges that pass at the
//    front, best first; it samples Cloudflare's IPv6 prefixes too, and settles the families with
//    the REAL Xray test (cf-family.measure) — a cheap pass is not proof. Nothing about 172.67 is
//    written down: next week it may be another range, and this follows it.
//  - alive() is TCP, TLS with the config's own name, then the config's own first request (a
//    WebSocket upgrade on its path, or a plain GET): any HTTP status line passes. Under a second
//    on a good address; the scan runs it before spending a real Xray test.
//
// tls.connect({ host: ip, servername }) and never tls.connect({ socket }) — the latter is an
// access violation on this machine class (memory: tls-over-socket-crash).

const tls = require('tls');
const CfUri = require('./public/cf-uri');
const cfFamily = require('./cf-family');

const SAMPLE_PER_RANGE = 6;
const TIMEOUT_MS = 2500;

/** What the base config asks the edge for: the name, the host header, its first request. */
function target(baseConfig) {
    const p = CfUri.parse(baseConfig);
    if (!p || p.tls === 'reality') return null;
    const sni = p.sni || p.host || (CfUri.isIpLiteral(p.address) ? '' : p.address);
    const host = p.host || sni;
    const ws = p.net === 'ws' || p.net === 'httpupgrade';
    let pth = p.path || '/';
    if (!pth.startsWith('/')) pth = '/' + pth;
    // The Windows `\r` trap from the phone session: a stray CR at the end of a path made the edge
    // answer 400 and looked like a filter.
    pth = pth.replace(/[\r\n]+/g, '');
    return { sni, host, path: pth, ws, tls: p.tls === 'tls' };
}

/** A local address on the physical adapter of the right family, so the scan measures the line. */
function localFor(ip, localV4) {
    if (CfUri.isV6(ip)) return cfFamily.globalIpv6() || undefined;
    return localV4 || undefined;
}

/**
 * True when ip:port answers the config's own first request. A target it cannot judge (REALITY,
 * no TLS, no name) passes — it is left to the real test.
 */
function alive(ip, port, t, { localV4 = null } = {}) {
    if (!t || !t.tls || !t.sni) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        let sock = null;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            clearTimeout(readTimer);
            try { sock && sock.destroy(); } catch (e) {}
            resolve(ok);
        };
        const connectTimer = setTimeout(() => done(false), TIMEOUT_MS * 2);
        let readTimer = null;
        try {
            sock = tls.connect({
                host: CfUri.stripBrackets(ip), port,
                servername: CfUri.isIpLiteral(t.sni) ? undefined : t.sni,
                ALPNProtocols: ['http/1.1'],
                rejectUnauthorized: false,
                localAddress: localFor(ip, localV4),
            }, () => {
                clearTimeout(connectTimer);
                readTimer = setTimeout(() => done(false), TIMEOUT_MS);
                const req = t.ws
                    ? `GET ${t.path} HTTP/1.1\r\nHost: ${t.host}\r\nUser-Agent: Mozilla/5.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
                      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
                    : `GET ${t.path} HTTP/1.1\r\nHost: ${t.host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`;
                sock.write(req);
            });
            let buf = '';
            sock.on('data', (d) => {
                buf += d.toString('latin1');
                if (buf.length >= 5) done(buf.startsWith('HTTP/'));
            });
            sock.on('error', () => done(false));
            sock.on('close', () => done(buf.startsWith('HTTP/')));
        } catch (e) { done(false); }
    });
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

let lastReport = [];

/**
 * The Cloudflare addresses to scan, best first, learned on the spot:
 *  1. every IPv4 range is sampled with alive() (TCP, TLS, the config's first request);
 *  2. when this machine has an IPv6 route, Cloudflare's v6 prefixes are sampled the same way;
 *  3. the families are settled with the REAL test (cf-family.measure);
 *  4. the family that carries traffic goes first — a dead family is left out entirely so its
 *     silent addresses cannot eat the test budget — and within v4 the ranges that passed lead,
 *     in proportion to how many passed, with their passing addresses at the very front.
 * Falls back to null (the caller's plain sampling) when the base config cannot be judged.
 *
 * @param ranges   Cloudflare IPv4 CIDRs
 * @param count    how many addresses the caller wants
 * @returns {Promise<null | {ips: string[], verdict, report: string}>}
 */
async function order({ ranges, baseConfig, port = 443, count = 200, localV4 = null, log = () => {}, shouldStop = () => false }) {
    const t = target(baseConfig);
    if (!t || !t.tls || !t.sni) return null;
    const { sampleFromRanges } = require('./ip-provider');
    const gen = (cidrs, n) => (n > 0 && cidrs.length
        ? sampleFromRanges(cidrs.map((cidr) => ({ cidr, provider: 'cloudflare' })), n).map((x) => x.ip) : []);

    log(`پیشاهنگ: نمونه‌گیری از ${ranges.length} بازهٔ IPv4 کلادفلر با درخواست خود کانفیگ (${t.ws ? 'ارتقای وب‌سوکت' : 'GET'} روی ${t.path})…`);
    const v6Route = cfFamily.hasIpv6RouteCached();
    const samples = ranges.map((r) => ({ r, ips: gen([r], SAMPLE_PER_RANGE) }));
    const flat = [];
    samples.forEach((s, si) => s.ips.forEach((ip) => flat.push({ si, ip })));
    const passFlat = await pool(flat, 32, (x) => (shouldStop() ? false : alive(x.ip, port, t, { localV4 })));
    const scouted = samples.map((s, si) => ({
        r: s.r,
        size: s.ips.length,
        passed: flat.filter((x, k) => x.si === si && passFlat[k]).map((x) => x.ip),
    }));

    let v6Sample = [];
    let v6Alive = [];
    if (await v6Route) {
        v6Sample = cfFamily.sampleV6(cfFamily.V6_PREFIXES.length);
        const ok = await pool(v6Sample, 32, (ip) => (shouldStop() ? false : alive(ip, port, t)));
        v6Alive = v6Sample.filter((ip, k) => ok[k]);
    }
    lastReport = scouted.map((s) => [s.r, s.passed.length, s.size]).concat([['IPv6', v6Alive.length, v6Sample.length]]);
    const report = 'scout: ' + scouted.map((s) => `${s.r}=${s.passed.length}/${s.size}`).join(', ')
        + `, IPv6=${v6Sample.length ? `${v6Alive.length}/${v6Sample.length}` : 'بدون مسیر IPv6'}`;
    log(report);
    if (shouldStop()) return null;

    const good = scouted.filter((s) => s.passed.length).sort((a, b) => b.passed.length / b.size - a.passed.length / a.size);
    const bad = scouted.filter((s) => !s.passed.length);
    log('پیشاهنگ: سنجش واقعی دو خانواده (IPv4 و IPv6) با هستهٔ Xray…');
    const verdict = await cfFamily.measure({
        baseConfig, port, v4Alive: good.flatMap((s) => s.passed), v6Alive, log,
    });

    // v4 ranges that passed lead, each in proportion to its pass rate; the passing addresses
    // themselves are the very first.
    const goodPassed = good.flatMap((s) => s.passed);
    const goodTotal = good.reduce((a, s) => a + s.passed.length / s.size, 0) || 1;
    const v4First = goodPassed.concat(...good.map((s) => gen([s.r], Math.ceil(count * (s.passed.length / s.size) / goodTotal))));
    const v4Rest = gen(bad.map((s) => s.r), count);
    // v6 prefixes that answered lead; the rest still get their share, since any address in a live
    // prefix reaches the edge.
    const livePrefixes = [...new Set(v6Alive.map(cfFamily.prefixOf))];
    const v6 = v6Sample.length ? v6Alive.concat(cfFamily.sampleV6(400, livePrefixes.length ? livePrefixes : cfFamily.V6_PREFIXES)) : [];

    let list;
    if (verdict.v4 === false && verdict.v6 === true) list = v6;                 // v4 carries nothing here
    else if (verdict.v4 === true && verdict.v6 === true) list = v4First.concat(v6, v4Rest);
    else if (verdict.v6 === true) list = v6.concat(v4First, v4Rest);
    else if (verdict.v4 === true) list = v4First.concat(v4Rest, v6);
    else list = v6.concat(v4First, v4Rest);                                    // unknown: newest evidence first
    const ips = [...new Set(list)].slice(0, count);
    return { ips, verdict, report };
}

module.exports = { target, alive, order, pool, localFor, get lastReport() { return lastReport; } };
