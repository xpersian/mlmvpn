// --- cf-errors.js — why the Workers failed, in Cloudflare's own words ---
//
// Port of Android's CfUsage.failures/hourly. «Nothing connects» needs evidence, and the account
// already holds it: every Worker invocation carries a status — success, clientDisconnected,
// loadShed, scriptThrewException, exceededResources, responseStreamDisconnected, internalError.
// Each time usage is refreshed the breakdown per script, and hour by hour for the last 24 hours,
// is written to the log under the tag [CfErrors].
//
// ⚠️ loadShed was a large share from 2026-09-27 on, even while everything worked — it was NOT the
// cause of the outage of 2026-09-28. Compare hour against hour with a time that worked before
// blaming it.

const axios = require('axios');

const GQL = 'https://api.cloudflare.com/client/v4/graphql';
const THROTTLE_MS = 5 * 60 * 1000;
const lastRun = new Map();

const Q_SCRIPTS = `query F($a: String!, $s: String!, $e: String!) { viewer { accounts(filter: {accountTag: $a}) {
  workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $s, datetime_leq: $e}) {
    sum { requests errors subrequests } quantiles { cpuTimeP99 } dimensions { scriptName status } } } } }`;
const Q_HOURLY = `query H($a: String!, $s: String!, $e: String!) { viewer { accounts(filter: {accountTag: $a}) {
  workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $s, datetime_leq: $e}) {
    sum { requests } dimensions { datetimeHour status } } } } }`;

async function query(headers, q, accountId, s, e) {
    const r = await axios.post(GQL, { query: q, variables: { a: accountId, s, e } }, { headers, timeout: 15000 });
    if (r.data && r.data.errors && r.data.errors.length) throw new Error(r.data.errors[0].message);
    return (((r.data || {}).data || {}).viewer || {}).accounts?.[0]?.workersInvocationsAdaptive || [];
}

/** Per script: { script: { total, byStatus: {status: n}, cpuP99 } } for the last 24 hours. */
async function failures(headers, accountId) {
    const now = new Date();
    const rows = await query(headers, Q_SCRIPTS, accountId, new Date(now - 864e5).toISOString(), now.toISOString());
    const out = {};
    for (const r of rows) {
        const name = r.dimensions && r.dimensions.scriptName || '?';
        const st = r.dimensions && r.dimensions.status || '?';
        const o = out[name] || (out[name] = { total: 0, byStatus: {}, cpuP99: 0 });
        const n = (r.sum && r.sum.requests) || 0;
        o.total += n;
        o.byStatus[st] = (o.byStatus[st] || 0) + n;
        o.cpuP99 = Math.max(o.cpuP99, (r.quantiles && r.quantiles.cpuTimeP99) || 0);
    }
    return out;
}

/** Hour by hour for 24 hours: [{ hour, byStatus }] oldest first. */
async function hourly(headers, accountId) {
    const now = new Date();
    const rows = await query(headers, Q_HOURLY, accountId, new Date(now - 864e5).toISOString(), now.toISOString());
    const by = {};
    for (const r of rows) {
        const h = r.dimensions && r.dimensions.datetimeHour || '?';
        const st = r.dimensions && r.dimensions.status || '?';
        const o = by[h] || (by[h] = {});
        o[st] = (o[st] || 0) + ((r.sum && r.sum.requests) || 0);
    }
    return Object.keys(by).sort().map((hour) => ({ hour, byStatus: by[hour] }));
}

const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
const fmtStatus = (bs, total) => Object.entries(bs).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}=${n}${s === 'success' ? '' : ` (${pct(n, total)}%)`}`).join(' ');

/**
 * Write the breakdown to the log, at most once per 5 minutes per account. Never throws — this is
 * evidence, not a feature, and a token without analytics permission simply says so.
 */
async function logFor(headers, accountId, log = (m) => console.log(m)) {
    if (!accountId) return;
    const last = lastRun.get(accountId) || 0;
    if (Date.now() - last < THROTTLE_MS) return;
    lastRun.set(accountId, Date.now());
    try {
        const [f, h] = await Promise.all([failures(headers, accountId), hourly(headers, accountId)]);
        const scripts = Object.entries(f).sort((a, b) => b[1].total - a[1].total);
        if (!scripts.length) { log(`[CfErrors] ${accountId.slice(0, 8)}…: در ۲۴ ساعت گذشته هیچ درخواستی به ورکرها نرسیده.`); return; }
        for (const [name, o] of scripts) log(`[CfErrors] ${name}: ${o.total} درخواست — ${fmtStatus(o.byStatus, o.total)} · cpuP99=${o.cpuP99}`);
        const bad = h.filter((x) => Object.keys(x.byStatus).some((s) => s !== 'success'));
        for (const x of bad.slice(-8)) {
            const total = Object.values(x.byStatus).reduce((a, b) => a + b, 0);
            log(`[CfErrors] ساعت ${x.hour.replace('T', ' ').slice(0, 16)} UTC: ${fmtStatus(x.byStatus, total)}`);
        }
    } catch (e) {
        log(`[CfErrors] آمار خطای ورکرها خوانده نشد (${e.response ? 'HTTP ' + e.response.status : e.message}) — احتمالاً توکن اجازهٔ خواندن آمار ندارد.`);
    }
}

module.exports = { failures, hourly, logFor };
