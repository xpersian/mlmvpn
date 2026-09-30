// --- cf-edge-heal.js — a Cloudflare-fronted config moves to IPv6 when IPv4 carries nothing ---
//
// Port of Android's data/CfEdgeHeal.kt. Before a connect (or a delay test) a config whose edge
// is Cloudflare IPv4 is moved to a Cloudflare IPv6 address when IPv4 is measured dead on this
// network: the address changes, the Worker's NAME stays as SNI and host, so it is the same config
// reaching the same Worker through the family the filter still lets through. Measured on the
// phone: an IPv4 config that read «Timeout» healed itself, connected, exited on Cloudflare
// (2a09:bac1:…) and moved 1 MB in 1.9 s.
//
// Decided by measurement, never assumed (cf-family.js): with a fresh verdict it is instant;
// without one the config is tried as it is (5 s), and only when that fails is the IPv6 twin tried
// (7 s), and the outcome recorded for everything else on this network. A config that works as it
// is, or is not Cloudflare-fronted, is never touched. Both ways: the verdict expires after 20
// minutes and IPv4 is tried first again, so when IPv4 comes back the app follows it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const CfUri = require('./public/cf-uri');
const cfFamily = require('./cf-family');

// The scanner's fifteen ranges (ip-provider.js › CF_FALLBACK) — 172.64.0.0/13 is among them.
const CF_V4 = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

function v4ToInt(ip) {
    if (!CfUri.isV4(ip)) return null;
    return ip.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
}
const CF_V4_PARSED = CF_V4.map((r) => {
    const [base, bits] = r.split('/');
    const b = Number(bits);
    const mask = b === 0 ? 0 : (0xFFFFFFFF << (32 - b)) >>> 0;
    return { base: v4ToInt(base) & mask, mask };
});

function isCfV4(ip) {
    const v = v4ToInt(String(ip || '').trim());
    if (v == null) return false;
    return CF_V4_PARSED.some((r) => ((v & r.mask) >>> 0) === (r.base >>> 0));
}

const cfName = (n) => /\.(workers|pages)\.dev$/i.test(String(n || '').trim());

/** Cloudflare-fronted over TLS, on an address that is not already IPv6. */
function isCfFronted(p) {
    if (!p || p.tls !== 'tls' || CfUri.isV6(p.address)) return false;
    return [p.sni, p.host, p.address].some(cfName) || isCfV4(p.address);
}

/** A Cloudflare IPv6 edge that carried traffic here: the scanner's newest, else a fresh pick. */
function goodV6() {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        const raw = d.ipscanner_archived_ips;
        const list = typeof raw === 'string' ? JSON.parse(raw) : (raw || []);
        const v6 = (Array.isArray(list) ? list : [])
            .filter((n) => n && n.healthy !== false)
            .map((n) => CfUri.bareAddress(typeof n === 'string' ? n : n.ip))
            .filter((ip) => CfUri.isV6(ip));
        // The archive is appended to, so the newest is last.
        if (v6.length) return v6[v6.length - 1];
    } catch (e) { /* no archive yet */ }
    return cfFamily.sampleV6(1)[0];
}

async function works(uri, timeoutMs) {
    try {
        const [ms] = await require('./xray-tester').measureUris([uri], { timeoutMs, basePort: 26300 });
        return ms > 0;
    } catch (e) { return false; }
}

/**
 * The link to use: `uri` itself, or its IPv6 twin when IPv4 is measured dead here.
 * `probe` false uses only a fresh verdict — for bulk paths that must not add seconds per config.
 * @returns {Promise<{uri: string, healed: boolean, from?: string, to?: string}>}
 */
async function heal(uri, { probe = true, log = () => {} } = {}) {
    const p = CfUri.parse(uri);
    if (!isCfFronted(p)) return { uri, healed: false };
    const v = cfFamily.current();
    if (v && v.v4 === true) return { uri, healed: false };
    if (v && v.v4 === false && v.v6 === true) {
        const ip = goodV6();
        log(`[CfEdgeHeal] IPv4 کلادفلر روی این شبکه داده رد نمی‌کند: ${p.address} ← ${ip}`);
        return { uri: CfUri.rewrite(uri, ip), healed: true, from: p.address, to: ip };
    }
    if (!probe) return { uri, healed: false };

    // Only a LITERAL IPv4 address says anything about IPv4: a name is resolved by the machine,
    // which may well pick IPv6 (on the phone a workers.dev name worked while every literal IPv4 of
    // the same account carried nothing), so its success proves nothing. The first version got
    // this wrong.
    const literalV4 = CfUri.isV4(p.address);
    if (await works(uri, 5000)) {
        if (literalV4) cfFamily.record(true, v ? v.v6 : null, 'کانفیگ خود کاربر روی IPv4 کار کرد');
        return { uri, healed: false };
    }
    if (!(await cfFamily.hasIpv6RouteCached())) {
        if (literalV4) cfFamily.record(false, false, 'IPv4 رد نکرد و این شبکه IPv6 ندارد');
        return { uri, healed: false };
    }
    const ip = goodV6();
    const twin = CfUri.rewrite(uri, ip);
    if (await works(twin, 7000)) {
        cfFamily.record(literalV4 ? false : (v ? v.v4 : null), true, 'ترمیم خودکار');
        log(`[CfEdgeHeal] healed: ${p.address} داده رد نکرد، ${ip} کار کرد`);
        return { uri: twin, healed: true, from: p.address, to: ip };
    }
    if (literalV4) cfFamily.record(false, v ? v.v6 : null, 'نه IPv4 رد کرد نه IPv6');
    return { uri, healed: false };
}

/**
 * For the connect route, which takes the link and a clean IP separately: the effective link is
 * healed, and when it moved, the new address comes back folded into the link (cleanIp null).
 */
async function healForConnect(uri, cleanIp, cleanPort, opts = {}) {
    const s = String(uri || '').trim();
    if (!s || s.startsWith('{')) return { uri, cleanIp, cleanPort, healed: false };
    const effective = cleanIp ? CfUri.rewrite(s, cleanIp, cleanPort) : s;
    const r = await heal(effective, opts);
    if (!r.healed) return { uri, cleanIp, cleanPort, healed: false };
    return { uri: r.uri, cleanIp: null, cleanPort: null, healed: true, from: r.from, to: r.to };
}

/**
 * A whole delay-test batch. With no verdict and a Cloudflare-fronted config in it, ONE config
 * whose address is a literal IPv4 settles the verdict first; then every node is healed from the
 * verdict alone, so a list of hundreds costs one probe, not seconds per row.
 * @param nodes [{ id, uri }] — returned in the same shape, with healed links
 */
async function healBatch(nodes, cleanIp, cleanPort, { log = () => {} } = {}) {
    const eff = (n) => (cleanIp ? CfUri.rewrite(String(n.uri || ''), cleanIp, cleanPort) : String(n.uri || ''));
    const fronted = nodes.filter((n) => isCfFronted(CfUri.parse(eff(n))));
    if (!fronted.length) return { nodes, healed: 0 };
    if (!cfFamily.current()) {
        const literal = fronted.find((n) => CfUri.isV4(CfUri.addressOf(eff(n))));
        if (literal) {
            log('[CfEdgeHeal] حکمی برای این شبکه نیست — یک کانفیگ کلادفلری با آدرس IPv4 آزموده می‌شود…');
            await heal(eff(literal), { probe: true, log });
        }
    }
    let healed = 0;
    const out = [];
    for (const n of nodes) {
        if (!fronted.includes(n)) { out.push(n); continue; }
        const r = await heal(eff(n), { probe: false, log: () => {} });
        if (r.healed) { healed++; out.push({ ...n, uri: r.uri, healedFrom: r.from }); } else out.push(n);
    }
    if (!healed) return { nodes, healed: 0, cleanIpFolded: false };
    log(`[CfEdgeHeal] ${healed} کانفیگ کلادفلری برای این آزمون روی IPv6 رفتند (IPv4 اینجا داده رد نمی‌کند).`);
    // The tester would put the clean IP back over a healed link, so with one the clean IP is
    // folded into every link here and the caller passes none.
    if (cleanIp) return { nodes: out.map((n) => (n.healedFrom ? n : { ...n, uri: eff(n) })), healed, cleanIpFolded: true };
    return { nodes: out, healed, cleanIpFolded: false };
}

module.exports = { heal, healForConnect, healBatch, isCfFronted, isCfV4, goodV6, CF_V4 };
