#!/usr/bin/env node
/*
 * gt-spike.js — GitHub Tunnel v2, spike S0: dispatch the runner half, then measure from
 * THIS machine's line. DEV ONLY; nothing here ships.
 *
 *   node scripts/gt-spike.js [--minutes 25] [--exits JP,KR] [--account <login>] [--keep]
 *   node scripts/gt-spike.js --attach <state.json>     re-measure a spike still running
 *
 * It spends Linux runner minutes on one of the user's GitHub accounts (Linux bills 1×) and
 * cancels the run when the measurements are done, unless --keep.
 *
 * What it answers, in the order the plan needs the answers:
 *   1. Does the Cloudflare path reach this line at all, and from which clean IPs; does the
 *      fragment profile help or hurt here?
 *   2. How much of the line's own speed does it deliver (1 and 4 streams, A/B against the
 *      direct line measured right before and after)? WS vs HTTPUpgrade, mux on/off.
 *   3. How good is UDP carried over it (a STUN train through SOCKS UDP ASSOCIATE)?
 *   4. Does Hysteria2 hole-punch to the runner from here, how often, and how fast is it?
 *   5. From the runner's side: its egress, and VPN Gate exits per country.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const accounts = require(ROOT + '/github-tunnel/gt-accounts');
const github = require(ROOT + '/github-tunnel/gt-github');
const sc = require(ROOT + '/github-tunnel/gt-session-crypto');
const fp = require(ROOT + '/tls-fingerprint');
const probe = require(ROOT + '/game/probe');
const corePaths = require(ROOT + '/core-paths');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] || '') : def; };
const flag = (name) => argv.includes(`--${name}`);
const MINUTES = String(Math.min(55, Math.max(10, parseInt(arg('minutes', '25'), 10) || 25)));
const EXITS = String(arg('exits', 'JP,KR')).toUpperCase();
const OUT = process.env.GT_SPIKE_OUT || path.join(os.tmpdir(), 'gt-spike');
fs.mkdirSync(OUT, { recursive: true });

const SPEED_URL = 'http://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
const DELAY_URL = 'http://clients3.google.com/generate_204';
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = new Set();

const WORKFLOW_FILE = 'mlmvpn-spike.yml';
const WORKFLOW_YAML = `name: mlmvpn-spike
on:
  workflow_dispatch:
    inputs:
      session_id:
        required: true
        type: string
      client_pub:
        required: true
        type: string
      minutes:
        required: false
        type: string
        default: '25'
      exits:
        required: false
        type: string
        default: 'JP,KR'

permissions:
  contents: write

jobs:
  spike:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: agent
      - name: Spike
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SESSION_ID: \${{ inputs.session_id }}
          CLIENT_PUB: \${{ inputs.client_pub }}
          MINUTES: \${{ inputs.minutes }}
          EXIT_COUNTRIES: \${{ inputs.exits }}
        run: node agent/spike.mjs
`;

// ── processes ───────────────────────────────────────────────────────────────────
function run(exe, args, { timeout = 60000 } = {}) {
    return new Promise((resolve) => {
        execFile(exe, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}
function daemon(exe, args, logName) {
    const out = fs.openSync(path.join(OUT, logName), 'a');
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', out, out] });
    p.on('error', () => {});
    children.add(p);
    p.on('exit', () => children.delete(p));
    return p;
}
function killAll() { for (const p of children) { try { p.kill(); } catch (e) {} } }

// Private copies, so the app's `taskkill /IM xray.exe` never takes the spike down mid-measure.
function privateCopy(id, file, fallback, as) {
    const src = corePaths.file(id, file, fallback);
    const dst = path.join(OUT, as);
    try { fs.copyFileSync(src, dst); } catch (e) { if (!fs.existsSync(dst)) throw e; }
    return dst;
}

async function freePorts(n) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const base = 33000 + Math.floor(Math.random() * 5000);
        const ports = Array.from({ length: n }, (_, i) => base + i);
        const ok = await Promise.all(ports.map((p) => new Promise((res) => {
            const s = net.createServer();
            s.once('error', () => res(false));
            s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
        })));
        if (ok.every(Boolean)) return ports;
    }
    throw new Error('no free ports');
}
async function waitPort(port, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const up = await new Promise((res) => {
            const s = net.connect(port, '127.0.0.1');
            s.once('connect', () => { s.destroy(); res(true); });
            s.once('error', () => res(false));
        });
        if (up) return true;
        await sleep(200);
    }
    return false;
}

// ── measuring ───────────────────────────────────────────────────────────────────
async function curl({ socksPort, url, range, maxTime = 12 }) {
    const args = ['-s', '-o', 'NUL', '--max-time', String(maxTime),
        '-w', '%{size_download} %{time_starttransfer} %{time_total} %{http_code}'];
    if (socksPort) args.push('--socks5-hostname', `127.0.0.1:${socksPort}`);
    if (range) args.push('-r', range);
    args.push(url);
    const r = await run('curl.exe', args, { timeout: (maxTime + 8) * 1000 });
    const [bytes, ttfb, total, code] = r.stdout.trim().split(/\s+/).map(Number);
    return { bytes: bytes || 0, ttfb: ttfb || 0, total: total || 0, code: code || 0 };
}
async function delay(socksPort) {
    const shots = [];
    for (let i = 0; i < 2; i++) {
        const r = await curl({ socksPort, url: DELAY_URL, maxTime: 10 });
        if (r.code === 204) shots.push(Math.round(r.total * 1000));
    }
    return shots.length ? Math.min(...shots) : null;
}
// Rate from the first body byte: the handshake belongs to delay, not to throughput.
async function throughput(socksPort, streams, seconds = 12) {
    const chunk = 25000000;
    const t = Date.now();
    const rs = await Promise.all(Array.from({ length: streams }, (_, i) =>
        curl({ socksPort, url: SPEED_URL, range: `${i * chunk}-${i * chunk + chunk - 1}`, maxTime: seconds })));
    const bytes = rs.reduce((s, r) => s + r.bytes, 0);
    const secs = Math.max(0.5, Math.max(...rs.map((r) => r.total - r.ttfb)));
    return { mbps: +(bytes * 8 / secs / 1e6).toFixed(2), bytes, wall: Date.now() - t };
}
async function udpQuality(socksPort) {
    try {
        const ip = (await dns.lookup('stun.l.google.com', { family: 4 })).address;
        const r = await probe.udpTrainViaSocks({ host: 'stun.l.google.com', ip, port: 19302, proto: 'stun', socksPort, pps: 20, seconds: 8, warmupMs: 800 });
        if (!r || !r.ok) return { ok: false, error: (r && (r.error || r.reason)) || 'no replies' };
        const s = r.stats || r;
        return { ok: true, loss: s.loss, min: s.min, p50: s.p50, p95: s.p95, jitter: s.jitter, spikes: s.spikes };
    } catch (e) { return { ok: false, error: e.message }; }
}

async function environment() {
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
        "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 3 InterfaceAlias,NextHop,RouteMetric,InterfaceMetric | ConvertTo-Json -Compress"]);
    let routes = [];
    try { routes = [].concat(JSON.parse(r.stdout.trim() || '[]')); } catch (e) {}
    const top = routes[0] && routes[0].InterfaceAlias;
    const stacked = /mlmvpn|VPN|tailscale|wireguard|MLMVPN/i.test(String(top || ''));
    return { defaultRoute: routes, stacked };
}

// The user's own recently verified clean Cloudflare IPs, from the assistant's groups.
function cleanIpCandidates(limit = 5) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        const raw = d.ipscanner_combo_groups;
        const groups = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const seen = new Map();
        for (const g of groups || []) for (const n of g.nodes || []) {
            const m = String(n.config || '').match(/@(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/);
            if (m && !seen.has(m[1])) seen.set(m[1], g.date || '');
        }
        return [...seen.keys()].slice(-limit);
    } catch (e) { return []; }
}

// ── the VLESS client side of mode A ─────────────────────────────────────────────
// A quick tunnel's label, for the passthrough Worker's path: abc-def.trycloudflare.com → abc-def.
const labelOf = (host) => String(host || '').replace(/\.trycloudflare\.com$/, '');

// The first spike measured *.trycloudflare.com blocked from this line (DNS and SNI), so the
// real candidates reach the tunnel through the user's own Worker: SNI and Host are the
// Worker's, and the path carries the key and the tunnel label (scripts/spike/pass-worker.js).
function viaPass(pass, tunnelHost) {
    return pass ? { host: pass.host, pathPrefix: `/${pass.key}/${labelOf(tunnelHost)}` } : { host: tunnelHost, pathPrefix: '' };
}

function vlessOutbound(tag, s, v) {
    const host = v.host;
    const pathQ = `${v.pathPrefix || ''}${v.transport === 'hu' ? s.xray.huPath : s.xray.wsPath}?ed=2560`;
    const ob = {
        tag, protocol: 'vless',
        settings: { vnext: [{ address: v.address, port: 443, users: [{ id: s.xray.uuid, encryption: 'none' }] }] },
        streamSettings: {
            network: v.transport === 'hu' ? 'httpupgrade' : 'ws',
            security: 'tls',
            // http/1.1 ONLY: offer h2 and Cloudflare picks it, and a WebSocket cannot ride h2.
            tlsSettings: { serverName: host, fingerprint: 'chrome', alpn: ['http/1.1'] },
        },
        // concurrency -1 keeps TCP off the mux but still carries UDP as XUDP; QUIC is refused
        // so browsers fall back to TCP instead of UDP-in-TCP.
        mux: { enabled: true, concurrency: v.mux || -1, xudpConcurrency: 16, xudpProxyUDP443: 'reject' },
    };
    if (v.transport === 'hu') ob.streamSettings.httpupgradeSettings = { path: pathQ, host };
    else ob.streamSettings.wsSettings = { path: pathQ, host };
    if (v.frag) {
        ob.streamSettings.tlsSettings.fingerprint = fp.FINGERPRINT;
        ob.streamSettings.tlsSettings.cipherSuites = fp.CIPHER_SUITES;
        ob.streamSettings.finalmask = JSON.parse(JSON.stringify(fp.FINAL_MASK));
    }
    return ob;
}

async function startXray(exe, s, variants, label) {
    const ports = await freePorts(variants.length);
    const cfg = {
        log: { loglevel: 'warning' },
        inbounds: variants.map((v, i) => ({ tag: `in${i}`, listen: '127.0.0.1', port: ports[i], protocol: 'socks', settings: { udp: true, auth: 'noauth' } })),
        outbounds: [...variants.map((v, i) => vlessOutbound(`out${i}`, s, v)), { tag: 'direct', protocol: 'freedom' }],
        routing: { rules: variants.map((v, i) => ({ type: 'field', inboundTag: [`in${i}`], outboundTag: `out${i}` })) },
    };
    const file = path.join(OUT, `xray-${label}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 1));
    const p = daemon(exe, ['run', '-c', file], `xray-${label}.log`);
    const up = await waitPort(ports[ports.length - 1]);
    if (!up) throw new Error(`xray (${label}) did not start — see ${file}`);
    return { p, ports };
}

// ── mode B: Hysteria2 through a realm the runner hosts ──────────────────────────
async function startHy2(exe, s, realmUrl, { detourPort, pin }) {
    const [port] = await freePorts(1);
    const cfg = {
        log: { level: 'info' },
        inbounds: [{ type: 'mixed', tag: 'in', listen: '127.0.0.1', listen_port: port }],
        outbounds: [
            { type: 'hysteria2', tag: 'hy2', password: s.hy2.password,
              obfs: { type: 'salamander', password: s.hy2.obfs },
              realm: { server_url: realmUrl, token: s.hy2.realmToken, realm_id: s.hy2.realmId,
                       stun_servers: ['stun.cloudflare.com:3478', 'stun.l.google.com:19302'],
                       ...(detourPort ? { http_client: { detour: 'cf' } } : {}) },
              tls: { enabled: true, server_name: s.hy2.serverName, ...(pin ? { certificate_public_key_sha256: [s.hy2.pinSha256] } : { insecure: true }) } },
            ...(detourPort ? [{ type: 'socks', tag: 'cf', server: '127.0.0.1', server_port: detourPort }] : []),
            { type: 'direct', tag: 'direct' },
        ],
        route: { final: 'hy2' },
    };
    const label = `hy2-${detourPort ? 'detour' : 'direct'}-${pin ? 'pin' : 'insecure'}`;
    const file = path.join(OUT, `${label}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 1));
    const p = daemon(exe, ['run', '-c', file], `${label}.log`);
    await waitPort(port);
    return { p, port, label };
}

// Measuring through another tunnel answers none of the questions (it measures THAT tunnel's
// exit, not this line), so with --wait-direct nothing is dispatched until the default route
// is the machine's own adapter.
async function waitForDirectLine() {
    let env = await environment();
    if (!env.stacked) return env;
    const name = env.defaultRoute[0] && env.defaultRoute[0].InterfaceAlias;
    console.log(`\n  اینترنت این سیستم الان از «${name}» می‌گذرد. برای اندازه‌گیری خود خط، آن را قطع کنید —`);
    console.log('  همین‌جا منتظر می‌مانم و به‌محض مستقیم شدن مسیر، خودم شروع می‌کنم.\n');
    const until = Date.now() + 30 * 60 * 1000;
    while (Date.now() < until) {
        await sleep(5000);
        env = await environment();
        if (!env.stacked) { log(`default route is now «${env.defaultRoute[0] && env.defaultRoute[0].InterfaceAlias}» — starting`); return env; }
    }
    throw new Error('the line never became direct (30 min)');
}

// ── main ────────────────────────────────────────────────────────────────────────
// Importable without side effects, so the configs it builds can be validated offline.
if (require.main !== module) module.exports = { vlessOutbound, WORKFLOW_YAML };
else (async () => {
    if (flag('wait-direct')) await waitForDirectLine();
    let st;
    if (arg('attach', '')) {
        st = JSON.parse(fs.readFileSync(arg('attach', ''), 'utf8'));
        log(`re-attaching to ${st.sessionId}`);
    } else {
        const wanted = arg('account', '');
        const pool = accounts.list().filter((a) => accounts.isSelectable(a) && (!wanted || a.login === wanted));
        if (!pool.length) throw new Error('no usable GitHub account in the pool');
        const acct = pool[0];
        const token = accounts.token(acct.id);
        if (!token) throw new Error(`no token for @${acct.login}`);
        log(`account @${acct.login}`);

        const repo = await github.ensureRepo(token);
        await github.ensureFile(token, repo.fullName, `.github/workflows/${WORKFLOW_FILE}`, WORKFLOW_YAML, { what: 'spike workflow' });
        await github.ensureFile(token, repo.fullName, 'agent/spike.mjs', fs.readFileSync(path.join(__dirname, 'spike', 'spike-agent.mjs'), 'utf8'), { what: 'spike agent' });
        await github.ensureFile(token, repo.fullName, 'agent/seal.mjs', fs.readFileSync(path.join(ROOT, 'github-tunnel', 'runner', 'seal.mjs'), 'utf8'), { what: 'seal' });

        const kp = sc.newKeyPair();
        const sessionId = `SPIKE-${Date.now().toString(36)}-${require('crypto').randomBytes(3).toString('hex')}`;
        // GitHub needs a moment before a freshly pushed workflow file can be dispatched.
        let runId = null;
        for (let i = 0; i < 6 && !runId; i++) {
            try {
                runId = await github.dispatchWorkflow(token, repo.fullName, repo.defaultBranch,
                    { session_id: sessionId, client_pub: kp.publicKey, minutes: MINUTES, exits: EXITS }, { workflowFile: WORKFLOW_FILE });
            } catch (e) { log(`dispatch: ${e.message} — retrying`); await sleep(5000); }
        }
        if (!runId) throw new Error('could not dispatch the spike');
        st = { sessionId, privateJwk: kp.privateJwk, runId, repo: repo.fullName, accountId: acct.id, login: acct.login, dispatchedAt: Date.now() };
        fs.writeFileSync(path.join(OUT, `state-${sessionId}.json`), JSON.stringify(st, null, 1));
        log(`dispatched run ${runId} (${MINUTES} min budget)`);
    }
    const token = accounts.token(st.accountId);
    const cleanup = async () => {
        killAll();
        if (!flag('keep')) {
            try { await github.cancelRun(token, st.repo, st.runId); log('run cancelled'); } catch (e) {}
            try { await github.deleteSessionFile(token, st.repo, st.sessionId); } catch (e) {}
        }
    };
    process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

    const report = { sessionId: st.sessionId, at: new Date().toISOString(), env: await environment() };
    if (report.env.stacked) log(`WARNING: the default route is «${report.env.defaultRoute[0].InterfaceAlias}» — every number below is stacked on another tunnel`);

    // Wait for the runner to publish.
    let s = null;
    const until = Date.now() + 12 * 60 * 1000;
    while (Date.now() < until) {
        try {
            const sealed = await github.getSessionData(token, st.repo, st.sessionId);
            if (sealed) { s = sc.open(st.privateJwk, sealed, st.sessionId); if (s.phase !== 'starting') break; }
        } catch (e) { log(`session: ${e.message}`); }
        try {
            const r = await github.getRun(token, st.repo, st.runId);
            if (r && r.status === 'completed') throw new Error(`the run ended early (${r.conclusion})`);
        } catch (e) { if (/ended early/.test(e.message)) throw e; }
        await sleep(5000);
    }
    if (!s) throw new Error('the runner never published');
    report.readyAfterMs = Date.now() - (st.dispatchedAt || T0);
    report.runner = s.runner; report.tunnels = s.tunnels.map(({ n, kind, ok, ms, selfTestStatus }) => ({ n, kind, ok, ms, selfTestStatus }));
    report.runnerErrors = s.errors; report.runnerTimings = s.timings;
    log(`runner up in ${(report.readyAfterMs / 1000).toFixed(0)} s — ${s.runner.country || '?'} ${s.runner.org || ''}, raw ${s.runner.directMbps} Mbit/s`);
    log(`tunnels: ${s.tunnels.map((t) => `${t.kind}#${t.n}=${t.ok ? 'ok' : 'FAIL'}`).join('  ')}`);

    const XRAY = privateCopy('xray', 'xray.exe', path.join(ROOT, 'core', 'xray.exe'), 'gtspike-core.exe');
    const SB = privateCopy('singbox', 'sing-box.exe', path.join(ROOT, 'core', 'sing-box.exe'), 'gtspike-sb.exe');
    const byKind = (k) => s.tunnels.filter((t) => t.kind === k && t.ok && t.host);
    const ws = byKind('ws'), hu = byKind('hu'), realm = byKind('realm')[0];

    // 0. The line on its own.
    const base1 = await throughput(null, 1), base4 = await throughput(null, 4);
    report.baseline = { before: { one: base1.mbps, four: base4.mbps } };
    log(`direct line: ${base1.mbps} Mbit/s (1 stream), ${base4.mbps} (4 streams)`);

    // The user's own passthrough Worker, if scripts/spike/deploy-pass.js has put one up.
    let PASS = null;
    try { PASS = JSON.parse(fs.readFileSync(path.join(OUT, 'pass.json'), 'utf8')); } catch (e) {}
    report.passWorker = !!PASS;
    const shown = (v) => (v.address === v.host ? `(${v.host === (PASS && PASS.host) ? 'worker' : 'tunnel'} dns)` : v.address);

    // 1. Reachability: every address × fragment on/off, delay only, all at once — through the
    //    Worker, plus one straight-to-trycloudflare control so the block is re-confirmed.
    let best = null;
    if (ws[0]) {
        const vs = [{ address: ws[0].host, host: ws[0].host, pathPrefix: '', transport: 'ws', frag: false, control: true }];
        const via = viaPass(PASS, ws[0].host);
        for (const address of [via.host, ...cleanIpCandidates(5)]) {
            for (const frag of [false, true]) vs.push({ address, ...via, transport: 'ws', frag });
        }
        const x = await startXray(XRAY, s, vs, 'reach');
        const delays = await Promise.all(vs.map((v, i) => delay(x.ports[i])));
        x.p.kill();
        report.reach = vs.map((v, i) => ({ address: shown(v), via: v.pathPrefix ? 'worker' : 'direct', frag: v.frag, delayMs: delays[i] }));
        for (const r of report.reach) log(`  reach ${r.via.padEnd(6)} ${r.address.padEnd(18)} frag=${r.frag ? 'on ' : 'off'} → ${r.delayMs == null ? 'FAIL' : r.delayMs + ' ms'}`);
        const ok = vs.map((v, i) => ({ v, d: delays[i] })).filter((o) => o.d != null).sort((a, b) => (a.d - b.d) || (a.v.frag - b.v.frag));
        best = ok[0] ? ok[0].v : null;
    }

    // 2. Throughput, only for what reached.
    let x = null;
    let cfSocks = 0;
    if (best) {
        const through = (t) => (best.pathPrefix ? viaPass(PASS, t.host) : { host: t.host, pathPrefix: '' });
        const vs = [
            { ...best, ...through(ws[0]), transport: 'ws', mux: 0, name: 'ws#1' },
            { ...best, ...through(ws[0]), transport: 'ws', mux: 8, name: 'ws#1 mux8' },
            ...(hu[0] ? [{ ...best, ...through(hu[0]), transport: 'hu', mux: 0, name: 'httpupgrade' }] : []),
            ...(ws[1] ? [{ ...best, ...through(ws[1]), transport: 'ws', mux: 0, name: 'ws#3' }] : []),
        ];
        x = await startXray(XRAY, s, vs, 'speed');
        report.cf = [];
        for (let i = 0; i < vs.length; i++) {
            const d = await delay(x.ports[i]);
            const one = await throughput(x.ports[i], 1);
            const four = await throughput(x.ports[i], 4);
            report.cf.push({ name: vs[i].name, via: vs[i].pathPrefix ? 'worker' : 'direct', address: shown(vs[i]), frag: vs[i].frag, delayMs: d, one: one.mbps, four: four.mbps });
            log(`  cf ${vs[i].name.padEnd(12)} delay ${d == null ? '—' : d + ' ms'}  1×: ${one.mbps}  4×: ${four.mbps} Mbit/s`);
        }
        report.cfUdp = await udpQuality(x.ports[0]);
        log(`  cf UDP (XUDP, STUN train): ${JSON.stringify(report.cfUdp)}`);
        cfSocks = x.ports[0];
    } else {
        log('the Cloudflare path reached nothing from this line — no throughput to measure');
    }

    // 4. Mode B runs whatever mode A did: its data never touches Cloudflare. Only the realm's
    //    control requests do — through the Worker, and when mode A works, detoured through it.
    if (realm && s.hy2) {
        const realmUrl = PASS ? `https://${PASS.host}/${PASS.key}/${labelOf(realm.host)}` : `https://${realm.host}`;
        report.hy2 = [];
        const tries = [
            ...(cfSocks ? [{ detourPort: cfSocks, pin: true }] : []),
            { detourPort: 0, pin: true },
            ...(cfSocks ? [{ detourPort: cfSocks, pin: false }] : [{ detourPort: 0, pin: false }]),
        ];
        for (const opts of tries) {
            const h = await startHy2(SB, s, realmUrl, opts);
            const t1 = Date.now();
            let d = null;
            for (let i = 0; i < 8 && d == null; i++) { d = await delay(h.port); if (d == null) await sleep(1500); }
            const row = { variant: h.label, firstByteMs: d == null ? null : Date.now() - t1, delayMs: d };
            if (d != null) {
                row.one = (await throughput(h.port, 1)).mbps;
                row.four = (await throughput(h.port, 4)).mbps;
                row.udp = await udpQuality(h.port);
                // Punch success: fresh clients, each must get a byte through.
                let okN = 0;
                h.p.kill();
                for (let k = 0; k < 4; k++) {
                    const hk = await startHy2(SB, s, realmUrl, opts);
                    let dk = null;
                    for (let i = 0; i < 6 && dk == null; i++) { dk = await delay(hk.port); if (dk == null) await sleep(1500); }
                    if (dk != null) okN++;
                    hk.p.kill();
                }
                row.punchSuccess = `${okN + 1}/5`;
            } else {
                h.p.kill();
                // Why it failed is in sing-box's own log; keep the lines that say so.
                try {
                    row.logTail = fs.readFileSync(path.join(OUT, `${h.label}.log`), 'utf8').split('\n')
                        .filter((l) => /ERROR|WARN|realm|punch|stun/i.test(l)).slice(-6).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200));
                } catch (e) {}
            }
            report.hy2.push(row);
            log(`  hy2 ${h.label.padEnd(20)} ${d == null ? `FAIL ${JSON.stringify(row.logTail || [])}` : `delay ${d} ms  1×: ${row.one}  4×: ${row.four} Mbit/s  punch ${row.punchSuccess}  udp ${JSON.stringify(row.udp)}`}`);
            if (d != null) break;
        }
    }
    if (x) x.p.kill();

    const base1b = await throughput(null, 1), base4b = await throughput(null, 4);
    report.baseline.after = { one: base1b.mbps, four: base4b.mbps };
    log(`direct line again: ${base1b.mbps} / ${base4b.mbps} Mbit/s`);

    // 5. The runner's own measurements of exits by country.
    const until2 = Date.now() + 8 * 60 * 1000;
    while (Date.now() < until2 && s.phase !== 'measured') {
        await sleep(10000);
        try { const sealed = await github.getSessionData(token, st.repo, st.sessionId); if (sealed) s = sc.open(st.privateJwk, sealed, st.sessionId); } catch (e) {}
    }
    report.exits = s.exits || [];
    for (const e of report.exits) {
        log(`  exit ${e.provider} ${e.country} → ${e.error ? 'FAIL ' + e.error : `${e.exitCountry || '?'} ${e.mbps} Mbit/s (listed ${e.listedMbps}), up in ${e.connectMs} ms`}`);
        if (e.error && e.logTail) for (const l of e.logTail.slice(-4)) log(`      ${l}`);
    }

    report.envAfter = await environment();
    if (report.envAfter.stacked) log('WARNING: the default route changed to another tunnel during the run — the numbers above are mixed');
    const file = path.join(OUT, `report-${st.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    log(`report: ${file}`);
    await cleanup();
    console.log('\n  تمام شد. می‌توانید «گیت‌وی» را دوباره وصل کنید و به Claude خبر بدهید.\n');
    process.exit(0);
})().catch(async (e) => {
    console.error(`FAILED: ${e.message}`);
    killAll();
    process.exit(1);
});
