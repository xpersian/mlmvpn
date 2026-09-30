// --- GitHub Tunnel v2, spike S0: the runner half ---
//
// DEV ONLY — never shipped. scripts/gt-spike.js pushes this to the user's private repo as
// agent/spike.mjs (next to agent/seal.mjs) and dispatches .github/workflows/mlmvpn-spike.yml.
//
// It stands up exactly what v2 will stand up, minus the polish, so the client half can
// measure it from the user's own line before a line of the real engine is written:
//   * Xray VLESS over WebSocket and over HTTPUpgrade on 127.0.0.1
//   * four Cloudflare quick tunnels (ws, httpupgrade, a second ws, and the realm rendezvous)
//   * sing-box Hysteria2 (salamander) registered with a local hysteria-realm service
//   * the runner's own egress (IP, country, raw speed) and VPN Gate exits per country
// Everything it generates is masked from the job log and sealed to the dispatching client.
import { seal } from './seal.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

const SESSION_ID = process.env.SESSION_ID || '';
const CLIENT_PUB = process.env.CLIENT_PUB || '';
const MINUTES = Math.min(55, Math.max(5, parseInt(process.env.MINUTES || '40', 10) || 40));
const EXIT_COUNTRIES = String(process.env.EXIT_COUNTRIES || 'JP,KR').split(',').filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 4);
const REPO = process.env.GITHUB_REPOSITORY || '';
const TOKEN = process.env.GITHUB_TOKEN || '';
if (!/^[A-Za-z0-9_-]{6,64}$/.test(SESSION_ID)) throw new Error('bad SESSION_ID');
if (!/^[A-Za-z0-9_-]{43}$/.test(CLIENT_PUB)) throw new Error('bad CLIENT_PUB');
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(REPO)) throw new Error('bad GITHUB_REPOSITORY');

// Pinned to the exact assets GitHub reports for these releases (asset digest API, 2026-09-23).
// Xray matches the client's store core so the two ends speak the same dialect.
const PINS = {
    xray: { url: 'https://github.com/XTLS/Xray-core/releases/download/v26.9.9/Xray-linux-64.zip', sha256: '1eb9175d0f0a8f8149c9230a7fc5ae66ce332ed20a53155ce61fe62e3f58b7df' },
    singbox: { url: 'https://github.com/SagerNet/sing-box/releases/download/v1.14.0/sing-box-1.14.0-linux-amd64.tar.gz', sha256: '2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63' },
    cloudflared: { url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-linux-amd64', sha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc' },
};
const SPEED_URL = 'http://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';

const WORK = '/tmp/gt';
fs.mkdirSync(WORK, { recursive: true });

const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const S = {
    uuid: crypto.randomUUID(),
    wsPath: '/' + rnd(12),
    huPath: '/' + rnd(12),
    hy2Password: rnd(18),
    obfsPassword: rnd(18),
    realmToken: rnd(24),
    realmId: 'gt' + rnd(9).replace(/[^A-Za-z0-9]/g, '0'),
};
// Before anything else can print them.
for (const v of Object.values(S)) console.log(`::add-mask::${v}`);

const result = {
    phase: 'starting',
    xray: { uuid: S.uuid, wsPath: S.wsPath, huPath: S.huPath, version: '26.9.9' },
    tunnels: [],
    hy2: null,
    runner: {},
    exits: [],
    timings: {},
    errors: [],
};
const fail = (where, e) => { const msg = `${where}: ${e && e.message ? e.message : e}`; result.errors.push(msg); log(`ERROR ${msg}`); };

// ── GitHub: the sealed hand-off ─────────────────────────────────────────────────
async function gh(method, url, body) {
    return fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mlmvpn-gt-agent',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function publish() {
    const url = `https://api.github.com/repos/${REPO}/contents/sessions/${SESSION_ID}.json`;
    const content = Buffer.from(JSON.stringify(seal(CLIENT_PUB, SESSION_ID, result))).toString('base64');
    for (let i = 0; i < 5; i++) {
        let sha;
        try { const r = await gh('GET', url); if (r.ok) sha = (await r.json()).sha; } catch (e) {}
        try {
            const r = await gh('PUT', url, { message: 'MLMVPN: session', content, ...(sha ? { sha } : {}) });
            if (r.ok) { log(`published (${result.phase})`); return true; }
            log(`publish HTTP ${r.status}`);
        } catch (e) { log(`publish: ${e.message}`); }
        await sleep(1500 * (i + 1));
    }
    return false;
}

// ── binaries ────────────────────────────────────────────────────────────────────
async function fetchPinned(name) {
    const { url, sha256 } = PINS[name];
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== sha256) throw new Error(`sha256 mismatch: ${got}`);
    const file = path.join(WORK, path.basename(new URL(url).pathname));
    fs.writeFileSync(file, buf);
    return file;
}

function daemon(name, exe, args) {
    const out = fs.openSync(path.join(WORK, `${name}.log`), 'a');
    const p = spawn(exe, args, { stdio: ['ignore', out, out] });
    p.on('exit', (code) => log(`${name} exited (${code})`));
    return p;
}

// ── measuring from the runner ───────────────────────────────────────────────────
async function curlSpeed(extraArgs = [], seconds = 15) {
    try {
        const { stdout } = await pexec('curl', ['-s', '-r', '0-99999999', '--max-time', String(seconds), '-o', '/dev/null',
            '-w', '%{size_download} %{time_starttransfer} %{time_total} %{http_code}', ...extraArgs, SPEED_URL], { timeout: (seconds + 10) * 1000 })
            .catch((e) => ({ stdout: e.stdout || '' }));
        const [bytes, ttfb, total, code] = String(stdout).trim().split(/\s+/).map(Number);
        const secs = Math.max(0.001, total - ttfb);
        return { mbps: bytes > 0 ? +(bytes * 8 / secs / 1e6).toFixed(1) : 0, bytes, code };
    } catch (e) { return { mbps: 0, error: e.message }; }
}
async function curlJson(url, extraArgs = []) {
    try {
        const { stdout } = await pexec('curl', ['-s', '--max-time', '12', ...extraArgs, url], { timeout: 20000 });
        return JSON.parse(stdout);
    } catch (e) { return null; }
}

// ── quick tunnels ───────────────────────────────────────────────────────────────
const CF = path.join(WORK, 'cloudflared');
const tunnels = [];

function startTunnel(n, kind, originPort) {
    const metrics = 20240 + n;
    const t = { n, kind, originPort, metrics, logFile: path.join(WORK, `cf${n}.log`), host: null, ok: false, restarts: 0 };
    t.proc = daemon(`cf${n}`, CF, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${originPort}`,
        '--metrics', `127.0.0.1:${metrics}`, '--logfile', t.logFile, '--loglevel', 'info']);
    return t;
}

async function resolveHost(t, timeoutMs = 90000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const r = await fetch(`http://127.0.0.1:${t.metrics}/quicktunnel`);
            if (r.ok) { const j = await r.json(); if (j && j.hostname) return j.hostname; }
        } catch (e) {}
        try {
            const m = fs.readFileSync(t.logFile, 'utf8').match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
            if (m) return m[1];
        } catch (e) {}
        await sleep(1000);
    }
    return null;
}

// Through the Cloudflare edge and back: any answer from OUR origin (Xray's 400/404, the
// realm's own status) proves the path; 5xx/530 is Cloudflare saying the tunnel is not there.
async function selfTest(t) {
    const p = t.kind === 'ws' ? S.wsPath : t.kind === 'hu' ? S.huPath : '/';
    const until = Date.now() + 45000;
    while (Date.now() < until) {
        if (t.kind === 'hu') {
            // An HTTPUpgrade origin answers a plain GET by closing the connection, which
            // Cloudflare reports as 502 — the first spike read that as a dead tunnel. Ask for
            // the upgrade it actually serves; 101 is the only proof.
            const { stdout } = await pexec('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '6',
                '-H', 'Connection: Upgrade', '-H', 'Upgrade: websocket', `https://${t.host}${p}`]).catch((e) => ({ stdout: e.stdout || '' }));
            t.selfTestStatus = Number(String(stdout).trim()) || String(stdout).trim();
            if (t.selfTestStatus === 101) return true;
        } else {
            try {
                const r = await fetch(`https://${t.host}${p}`, { signal: AbortSignal.timeout(8000) });
                t.selfTestStatus = r.status;
                if (r.status < 500) return true;
            } catch (e) { t.selfTestStatus = String(e.message || e).slice(0, 60); }
        }
        await sleep(2000);
    }
    return false;
}

async function bringTunnel(t) {
    const t1 = Date.now();
    t.host = await resolveHost(t);
    if (!t.host) { t.ok = false; t.error = 'no hostname'; return t; }
    console.log(`::add-mask::${t.host}`);
    t.ok = await selfTest(t);
    t.ms = Date.now() - t1;
    return t;
}

// ── VPN Gate exits, measured from the datacenter ────────────────────────────────
async function vpngateCandidates() {
    const res = await fetch('http://www.vpngate.net/api/iphone/', { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    const rows = text.split(/\r?\n/).filter((l) => l && !l.startsWith('*') && !l.startsWith('#'));
    const out = [];
    for (const line of rows) {
        const f = line.split(',');
        if (f.length < 15) continue;
        const [host, ip, score, ping, speed, , cc] = f;
        const cfg = f[14];
        if (!cfg || !EXIT_COUNTRIES.includes(cc)) continue;
        out.push({ host, ip, score: +score, ping: +ping, speed: +speed, country: cc, cfg });
    }
    const picked = [];
    for (const cc of EXIT_COUNTRIES) {
        picked.push(...out.filter((r) => r.country === cc).sort((a, b) => b.speed - a.speed).slice(0, 2));
    }
    return picked;
}

async function measureVpngate(c, i) {
    const dev = `tun${10 + i}`;
    const table = String(110 + i);
    const cfgFile = path.join(WORK, `vg${i}.ovpn`);
    const logFile = path.join(WORK, `vg${i}.log`);
    const pidFile = path.join(WORK, `vg${i}.pid`);
    fs.writeFileSync(cfgFile, Buffer.from(c.cfg, 'base64'));
    const row = { provider: 'vpngate', country: c.country, host: c.host, listedMbps: +(c.speed / 1e6).toFixed(1) };
    const t1 = Date.now();
    try {
        await pexec('sudo', ['openvpn', '--config', cfgFile, '--route-nopull', '--dev', dev, '--dev-type', 'tun',
            '--data-ciphers', 'AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-128-CBC', '--data-ciphers-fallback', 'AES-128-CBC',
            '--connect-retry-max', '1', '--connect-timeout', '10', '--log', logFile, '--writepid', pidFile, '--daemon']);
        // openvpn runs as root and writes its log 0600 — reading it as the runner user fails
        // silently, which is what made every exit in the first spike look dead.
        const readLog = async () => (await pexec('sudo', ['cat', logFile]).catch(() => ({ stdout: '' }))).stdout || '';
        let up = false;
        for (let s = 0; s < 40 && !up; s++) {
            await sleep(1000);
            up = /Initialization Sequence Completed/.test(await readLog());
        }
        if (!up) {
            row.logTail = (await readLog()).split('\n').filter(Boolean).slice(-10).map((l) => l.slice(0, 160));
            throw new Error('did not come up in 40 s');
        }
        row.connectMs = Date.now() - t1;
        await pexec('sudo', ['ip', 'route', 'replace', 'default', 'dev', dev, 'table', table]);
        await pexec('sudo', ['ip', 'rule', 'add', 'oif', dev, 'lookup', table, 'priority', String(1000 + i)]);
        const geo = await curlJson('https://api.ip.sb/geoip', ['--interface', dev]) || await curlJson('https://ipinfo.io/json', ['--interface', dev]);
        if (geo) { row.exitIp = geo.ip; row.exitCountry = geo.country_code || geo.country; row.exitOrg = geo.organization || geo.asn_organization || geo.org || ''; }
        Object.assign(row, await curlSpeed(['--interface', dev], 15));
    } catch (e) {
        row.error = String(e.message || e).slice(0, 160);
    } finally {
        try { const pid = fs.readFileSync(pidFile, 'utf8').trim(); if (/^\d+$/.test(pid)) await pexec('sudo', ['kill', pid]); } catch (e) {}
        try { await pexec('sudo', ['ip', 'rule', 'del', 'oif', dev, 'lookup', table]); } catch (e) {}
    }
    return row;
}

// ── main ────────────────────────────────────────────────────────────────────────
(async () => {
    log(`spike ${SESSION_ID}: ${MINUTES} min, exits ${EXIT_COUNTRIES.join(',') || 'none'}`);

    // Binaries, in parallel.
    let t1 = Date.now();
    const [xz, sbz, cfb] = await Promise.all([fetchPinned('xray'), fetchPinned('singbox'), fetchPinned('cloudflared')]);
    await pexec('unzip', ['-o', '-q', xz, '-d', path.join(WORK, 'xray')]);
    await pexec('tar', ['-xzf', sbz, '-C', WORK]);
    fs.renameSync(cfb, CF);
    fs.chmodSync(CF, 0o755);
    const XRAY = path.join(WORK, 'xray', 'xray');
    const SINGBOX = path.join(WORK, 'sing-box-1.14.0-linux-amd64', 'sing-box');
    result.timings.downloadMs = Date.now() - t1;
    log('binaries verified');

    // A congestion controller built for long fat pipes, and buffers to match.
    for (const s of ['net.core.default_qdisc=fq', 'net.ipv4.tcp_congestion_control=bbr',
        'net.core.rmem_max=67108864', 'net.core.wmem_max=67108864',
        'net.ipv4.tcp_rmem=4096 87380 67108864', 'net.ipv4.tcp_wmem=4096 65536 67108864', 'net.ipv4.tcp_mtu_probing=1']) {
        try { await pexec('sudo', ['sysctl', '-w', s]); } catch (e) { fail('sysctl', e); }
    }

    // Xray: the VLESS side of mode A.
    const client = { id: S.uuid, email: 'direct@gt' };
    const sniff = { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true };
    const xrayCfg = {
        log: { loglevel: 'warning' },
        inbounds: [
            { tag: 'ws', listen: '127.0.0.1', port: 10001, protocol: 'vless', settings: { clients: [client], decryption: 'none' },
              streamSettings: { network: 'ws', wsSettings: { path: S.wsPath } }, sniffing: sniff },
            { tag: 'hu', listen: '127.0.0.1', port: 10002, protocol: 'vless', settings: { clients: [client], decryption: 'none' },
              streamSettings: { network: 'httpupgrade', httpupgradeSettings: { path: S.huPath } }, sniffing: sniff },
        ],
        outbounds: [
            { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
            { tag: 'block', protocol: 'blackhole' },
        ],
        routing: { domainStrategy: 'AsIs', rules: [
            { type: 'field', ip: ['geoip:private'], outboundTag: 'block' },
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'block' },
            { type: 'field', port: '25', outboundTag: 'block' },
        ] },
    };
    fs.writeFileSync(path.join(WORK, 'xray.json'), JSON.stringify(xrayCfg));
    daemon('xray', XRAY, ['run', '-c', path.join(WORK, 'xray.json')]);

    // sing-box: Hysteria2 behind NAT, registered with a realm that only this runner hosts.
    t1 = Date.now();
    try {
        await pexec('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
            '-subj', '/CN=gt.local', '-keyout', path.join(WORK, 'k.pem'), '-out', path.join(WORK, 'c.pem')]);
        const spki = new crypto.X509Certificate(fs.readFileSync(path.join(WORK, 'c.pem'))).publicKey.export({ type: 'spki', format: 'der' });
        const pin = crypto.createHash('sha256').update(spki).digest('base64');
        const sbCfg = {
            log: { level: 'info' },
            services: [{ type: 'hysteria-realm', tag: 'realm', listen: '127.0.0.1', listen_port: 18080,
                users: [{ name: 'gt', token: S.realmToken, max_realms: 4 }] }],
            inbounds: [{ type: 'hysteria2', tag: 'hy2-in', listen: '0.0.0.0', listen_port: 24443,
                users: [{ name: 'u', password: S.hy2Password }],
                obfs: { type: 'salamander', password: S.obfsPassword },
                realm: { server_url: 'http://127.0.0.1:18080', token: S.realmToken, realm_id: S.realmId,
                    stun_servers: ['stun.cloudflare.com:3478', 'stun.l.google.com:19302'] },
                tls: { enabled: true, server_name: 'gt.local', certificate_path: path.join(WORK, 'c.pem'), key_path: path.join(WORK, 'k.pem') } }],
            outbounds: [{ type: 'direct', tag: 'direct' }],
        };
        fs.writeFileSync(path.join(WORK, 'sb.json'), JSON.stringify(sbCfg));
        try { await pexec('sudo', ['sysctl', '-w', 'net.core.rmem_max=16777216']); } catch (e) {}
        daemon('singbox', SINGBOX, ['run', '-c', path.join(WORK, 'sb.json')]);
        result.hy2 = { password: S.hy2Password, obfs: S.obfsPassword, realmToken: S.realmToken, realmId: S.realmId,
            pinSha256: pin, serverName: 'gt.local', port: 24443 };
    } catch (e) { fail('hysteria2', e); }
    result.timings.hy2Ms = Date.now() - t1;

    await sleep(1500);

    // Four quick tunnels at once.
    t1 = Date.now();
    tunnels.push(startTunnel(1, 'ws', 10001), startTunnel(2, 'hu', 10002), startTunnel(3, 'ws', 10001), startTunnel(4, 'realm', 18080));
    await Promise.all(tunnels.map(bringTunnel));
    result.timings.tunnelsMs = Date.now() - t1;
    const publicTunnels = () => tunnels.map(({ n, kind, host, ok, ms, selfTestStatus, restarts, error }) => ({ n, kind, host, ok, ms, selfTestStatus, restarts, error }));
    result.tunnels = publicTunnels();
    log(`tunnels: ${tunnels.map((t) => `${t.kind}=${t.ok ? 'ok' : 'FAIL'}`).join(' ')}`);

    // Who and where the runner is, and what it can pull on its own.
    const geo = await curlJson('https://api.ip.sb/geoip') || await curlJson('https://ipinfo.io/json') || await curlJson('https://ifconfig.co/json');
    if (geo) result.runner = { ip: geo.ip, country: geo.country_code || geo.country_iso || geo.country, city: geo.city, org: geo.organization || geo.asn_organization || geo.org || geo.asn_org };
    if (result.runner.ip) console.log(`::add-mask::${result.runner.ip}`);
    result.runner.directMbps = (await curlSpeed([], 10)).mbps;

    result.phase = 'ready';
    await publish();

    // Exits by country, measured from here — the client needs nothing for this part.
    try {
        try { await pexec('which', ['openvpn']); } catch (e) {
            // A runner image's package lists can be stale; one update is cheaper than a failed install.
            try { await pexec('sudo', ['apt-get', 'install', '-y', '-qq', 'openvpn'], { timeout: 180000 }); }
            catch (e2) {
                await pexec('sudo', ['apt-get', 'update', '-qq'], { timeout: 180000 });
                await pexec('sudo', ['apt-get', 'install', '-y', '-qq', 'openvpn'], { timeout: 180000 });
            }
        }
        const cands = await vpngateCandidates();
        log(`vpngate candidates: ${cands.length}`);
        for (let i = 0; i < cands.length; i++) result.exits.push(await measureVpngate(cands[i], i));
    } catch (e) { fail('vpngate', e); }
    result.phase = 'measured';
    await publish();

    // Stay up for the client, and notice a quick tunnel that dies — that churn is a finding too.
    const deadline = T0 + MINUTES * 60 * 1000;
    while (Date.now() < deadline) {
        await sleep(30000);
        for (const t of tunnels) {
            if (t.proc.exitCode === null) continue;
            t.restarts++;
            log(`tunnel ${t.n} died; restarting`);
            Object.assign(t, startTunnel(t.n, t.kind, t.originPort), { restarts: t.restarts });
            await bringTunnel(t);
            result.tunnels = publicTunnels();
            await publish();
        }
    }
    log('spike over');
    process.exit(0);
})().catch(async (e) => {
    fail('fatal', e);
    result.phase = 'failed';
    await publish();
    process.exit(1);
});
