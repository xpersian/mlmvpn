// P3 — control-plane calls when the machine cannot resolve names (gt-net.js › WHEN THIS MACHINE
// CANNOT LOOK A NAME UP), and the runner's Xray config with its status channel.
//
// With the kill switch closed and the full tunnel down — the moment a failover needs GitHub —
// Windows' own lookups cannot leave. The app resolves the control-plane names itself: DNS over
// TCP (the lines this was measured on hijack UDP/53 only), then the last address that worked.
// Everything here runs against local servers; nothing leaves the machine.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const SANDBOX = path.join(__dirname, 'home-control-plane');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

/** A DNS answer as a real resolver builds it: question echoed, answers named by pointer. */
function answerFor(query, ips, { rcode = 0, id = null } = {}) {
    const q = query.subarray(2);                      // drop the TCP length
    const qEnd = 12 + (function skip(b, o) { while (b[o] !== 0) o += b[o] + 1; return o + 1; })(q, 12) - 12 + 4;
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id === null ? q.readUInt16BE(0) : id, 0);
    header.writeUInt16BE(0x8180 | rcode, 2);            // response, RD, RA
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(ips.length + 1, 6);            // a CNAME first, then the A records
    const question = q.subarray(12, qEnd);
    const cname = Buffer.concat([Buffer.from([0xc0, 0x0c, 0x00, 0x05, 0x00, 0x01, 0, 0, 0, 60, 0x00, 0x02, 0xc0, 0x0c])]);
    const as = ips.map((ip) => Buffer.concat([Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 60, 0x00, 0x04]), Buffer.from(ip.split('.').map(Number))]));
    const msg = Buffer.concat([header, question, cname, ...as]);
    const len = Buffer.alloc(2); len.writeUInt16BE(msg.length, 0);
    return Buffer.concat([len, msg]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
async function listening(port) {
    for (let i = 0; i < 60; i++) {
        const up = await new Promise((r) => {
            const s = net.connect(port, '127.0.0.1');
            s.once('connect', () => { s.destroy(); r(true); });
            s.once('error', () => r(false));
        });
        if (up) return true;
        await sleep(100);
    }
    return false;
}

/** One HTTP GET through a SOCKS5 port to any host AND port (the app's own helper only asks for 80). */
function socksAsk(socksPort, host, port, reqPath, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const sock = net.connect(socksPort, '127.0.0.1');
        let stage = 0;
        let got = Buffer.alloc(0);
        const done = (extra = {}) => { clearTimeout(timer); sock.destroy(); resolve({ text: got.toString('latin1'), ...extra }); };
        const timer = setTimeout(() => done({ timedOut: true }), timeoutMs);
        sock.on('error', (e) => done({ error: e.code || e.message }));
        sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
        sock.on('data', (b) => {
            if (stage === 0) {
                stage = 1;
                const h = Buffer.from(host);
                const p = Buffer.alloc(2); p.writeUInt16BE(port, 0);
                sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p]));
                return;
            }
            if (stage === 1) {
                stage = 2;
                if (b[1] !== 0) return done({ refused: b[1] });
                sock.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
                return;
            }
            got = Buffer.concat([got, b]);
        });
        sock.on('end', () => done());
    });
}

function dnsServer(handler) {
    return new Promise((resolve) => {
        const srv = net.createServer((sock) => {
            let buf = Buffer.alloc(0);
            sock.on('data', (d) => {
                buf = Buffer.concat([buf, d]);
                if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) handler(buf.subarray(0, 2 + buf.readUInt16BE(0)), sock);
            });
            sock.on('error', () => {});
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

(async () => {
    process.env.MLMVPN_GT_LOCAL_ENGINE_PORT = '0';
    const gtNet = require(ROOT + '/github-tunnel/gt-net');

    // ── the question on the wire ──
    const q = gtNet.dnsQuery('api.github.com', 0x1234);
    t('the query is framed for TCP (two-byte length) with our id', q.readUInt16BE(0) === q.length - 2 && q.readUInt16BE(2) === 0x1234);
    t('…a standard recursive query for one A record', q.readUInt16BE(4) === 0x0100 && q.readUInt16BE(6) === 1
        && q.subarray(q.length - 4).equals(Buffer.from([0, 1, 0, 1])));
    t('…with the name as length-prefixed labels', q.subarray(14, q.length - 4).equals(Buffer.from('\x03api\x06github\x03com\x00', 'latin1')));

    // ── reading the answer ──
    const ans = answerFor(q, ['140.82.121.5', '140.82.121.6']);
    t('an answer with a CNAME and compressed names yields the A records', JSON.stringify(gtNet.parseAnswer(ans.subarray(2), 0x1234)) === '["140.82.121.5","140.82.121.6"]');
    let bad = null;
    try { gtNet.parseAnswer(answerFor(q, ['1.2.3.4'], { id: 0x9999 }).subarray(2), 0x1234); } catch (e) { bad = e; }
    t('…an answer to somebody else\'s question is refused', !!bad);
    bad = null;
    try { gtNet.parseAnswer(answerFor(q, [], { rcode: 3 }).subarray(2), 0x1234); } catch (e) { bad = e; }
    t('…and an error code (NXDOMAIN) is not read as «no addresses»', bad && /rcode 3/.test(bad.message));

    // ── over TCP, to a resolver ──
    const good = await dnsServer((query, sock) => sock.end(answerFor(query, ['140.82.121.4'])));
    const port = good.address().port;
    const ips = await gtNet.tcpResolve('github.com', '127.0.0.1', 3000, port);
    t('a lookup over TCP gets the resolver\'s answer', JSON.stringify(ips) === '["140.82.121.4"]');
    const viaOwn = await gtNet.resolveOwn('github.com', { servers: ['127.0.0.1'], port });
    t('resolveOwn answers from the first resolver that does', viaOwn[0] === '140.82.121.4');
    const lkg = JSON.parse(fs.readFileSync(gtNet.LKG_FILE, 'utf8'));
    t('…and remembers it as the last known good address', lkg['github.com'] && lkg['github.com'].ips[0] === '140.82.121.4');

    // ── every resolver gone: the last address that worked ──
    const dead = await dnsServer((query, sock) => sock.destroy());
    const deadPort = dead.address().port;
    const cached = await gtNet.resolveOwn('github.com', { servers: ['127.0.0.1'], port: deadPort, timeoutMs: 800 });
    t('no resolver answers: the last known good address is used', cached[0] === '140.82.121.4');
    let nf = null;
    try { await gtNet.resolveOwn('never-seen.example.com', { servers: ['127.0.0.1'], port: deadPort, timeoutMs: 800 }); } catch (e) { nf = e; }
    t('…and a name never resolved is an honest ENOTFOUND', nf && nf.code === 'ENOTFOUND');
    let inj = null;
    try { await gtNet.resolveOwn('evil name; rm -rf', { servers: ['127.0.0.1'], port }); } catch (e) { inj = e; }
    t('…a malformed name is refused before anything is sent', inj && inj.code === 'ENOTFOUND');
    good.close(); dead.close();

    // ── wired into gtFetch ──
    const src = fs.readFileSync(ROOT + '/github-tunnel/gt-net.js', 'utf8');
    t('gtFetch retries a name the MACHINE could not resolve through the app\'s own resolver, before any proxy',
        /const own = isDnsFailure\(e\) \? ownResolverAgent\(\) : null;/.test(src)
        && src.indexOf('ownResolverAgent()') < src.indexOf('const agent = systemProxyAgent();'));
    t('…and keeps the last good address of every name that worked', /rememberAsync\(host\);\s*return res;/.test(src));

    // ── the runner's Xray config and its status channel ──
    const cfgMod = await import(pathToFileURL(ROOT + '/github-tunnel/runner/xray-config.mjs').href);
    const cfg = cfgMod.buildXrayConfig({ uuid: '0b6e1c7a-3c9d-4e2f-9a1b-2c3d4e5f6a7b', wsPath: '/abcdEFGH1234' });
    t('the status channel is the FIRST rule, by name (before the private-address block)',
        JSON.stringify(cfg.routing.rules[0]) === JSON.stringify({ type: 'field', domain: [`full:${cfgMod.STATUS_HOST}`], outboundTag: 'status' }));
    t('…and lands on the agent on loopback, whatever port was asked for',
        cfg.outbounds.some((o) => o.tag === 'status' && o.protocol === 'freedom' && o.settings.redirect === `127.0.0.1:${cfgMod.STATUS_PORT}`));
    // Xray 26 blackholes every private target reached from a VLESS inbound unless a final rule
    // says otherwise — without this the channel silently never answered on a real runner.
    const statusOut = cfg.outbounds.find((o) => o.tag === 'status');
    t('…through a final rule that allows exactly that port on 127.0.0.1 and nothing else',
        JSON.stringify(statusOut.settings.finalRules) === JSON.stringify([{ action: 'allow', network: 'tcp', ip: ['127.0.0.1/32'], port: String(cfgMod.STATUS_PORT) }]));
    t('…and `direct` keeps Xray\'s own private-target block (no allow rule of its own)',
        cfg.outbounds.every((o) => o.tag === 'status' || !(o.settings && o.settings.finalRules)));
    t('…while everything else private stays blocked', cfg.routing.rules.some((r) => (r.ip || []).includes('geoip:private') && r.outboundTag === 'block'));
    t('the client asks for exactly that name', require(ROOT + '/github-tunnel/gt-core').STATUS_HOST === cfgMod.STATUS_HOST);
    const xray = path.join(ROOT, 'core', 'xray.exe');
    if (fs.existsSync(xray)) {
        const r = spawnSync(xray, ['run', '-test', '-c', 'stdin:'], { input: JSON.stringify(cfg), encoding: 'utf8', timeout: 30000 });
        t('Xray accepts the runner config', r.status === 0 && /Configuration OK/.test(r.stdout || ''), (r.stdout || r.stderr || '').slice(-200));

        // ── the status channel for real: a client Xray (SOCKS → VLESS/WS + mux, as gtcore) → this
        //    runner config → a status server on loopback. No Cloudflare, nothing leaves the machine.
        const [wsPort, statusPort, socksPort] = [await freePort(), await freePort(), await freePort()];
        const uuid = '0b6e1c7a-3c9d-4e2f-9a1b-2c3d4e5f6a7b';
        const wsPath = '/abcdEFGH1234';
        const statusSrv = require('http').createServer((req, res) => {
            const b = `STATUS-OK ${req.url}`;
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(b) });
            res.end(b);
        });
        await new Promise((r) => statusSrv.listen(statusPort, '127.0.0.1', r));
        const clientCfg = {
            log: { loglevel: 'none' },
            inbounds: [{ listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { auth: 'noauth', udp: true } }],
            outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: '127.0.0.1', port: wsPort, users: [{ id: uuid, encryption: 'none' }] }] },
                streamSettings: { network: 'ws', wsSettings: { path: wsPath } }, mux: { enabled: true, concurrency: 8 } }],
        };
        const runXray = (c) => { const p = spawn(xray, ['run', '-c', 'stdin:'], { stdio: ['pipe', 'ignore', 'ignore'] }); p.stdin.end(JSON.stringify(c)); return p; };
        const procs = [runXray(cfgMod.buildXrayConfig({ uuid, wsPath, wsPort, statusPort })), runXray(clientCfg)];
        try {
            const up = (await listening(wsPort)) && (await listening(socksPort));
            const byName = await socksAsk(socksPort, cfgMod.STATUS_HOST, 80, '/s');
            t('the status channel answers through a real Xray pair', up && /^HTTP\/1\.1 200/.test(byName.text) && /STATUS-OK \/s$/.test(byName.text), JSON.stringify(byName).slice(0, 300));
            const byAddr = await socksAsk(socksPort, '127.0.0.1', statusPort, '/s');
            t('…while the same port asked for BY ADDRESS stays blocked', !/STATUS-OK/.test(byAddr.text), JSON.stringify(byAddr).slice(0, 300));
            const byLocal = await socksAsk(socksPort, 'localhost', statusPort, '/s');
            t('…and so does a name that resolves to loopback (Xray\'s own guard on `direct`)', !/STATUS-OK/.test(byLocal.text), JSON.stringify(byLocal).slice(0, 300));
        } finally {
            procs.forEach((p) => { try { p.kill(); } catch (e) {} });
            statusSrv.close();
        }

        // ── WHICH SIDE FAILED: the Worker reached, something behind it answering 530 ──
        // (a quick tunnel still warming up, or a runner that is gone). Read from the measuring
        // core's own log, with the real Xray — before this, it read as «no clean IP on your line».
        const cleanip = require(ROOT + '/github-tunnel/gt-cleanip');
        const farPort = await freePort();
        const far = require('http').createServer((req, res) => { res.writeHead(530); res.end(); });
        far.on('upgrade', (req, sock) => sock.end('HTTP/1.1 530 Origin Unreachable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
        await new Promise((r) => far.listen(farPort, '127.0.0.1', r));
        try {
            const diag = {};
            const got = await cleanip.measure({
                exe: xray, ips: ['127.0.0.1'], diag, timeoutMs: 5000,
                buildOutbound: (ip) => ({ protocol: 'vless', settings: { vnext: [{ address: ip, port: farPort, users: [{ id: uuid, encryption: 'none' }] }] },
                    streamSettings: { network: 'ws', wsSettings: { path: '/p/pass/abcdEFGH1234' } } }),
            });
            t('a WebSocket refused behind the Worker is seen as an HTTP answer, not as a filtered line',
                got.length === 0 && diag.http && diag.http['127.0.0.1'] === 530, JSON.stringify(diag));
            const r = cleanip.refusalOf(diag, false);
            t('…summed up as one status and the addresses that reached the Worker', r && r.status === 530 && r.frag === false && r.ips.join() === '127.0.0.1', JSON.stringify(r));
        } finally { far.close(); }
    } else {
        t('Xray check skipped (no core in this checkout)', true);
    }

    fs.rmSync(SANDBOX, { recursive: true, force: true });
    module.exports = results;
    if (require.main === module) {
        results.forEach((x) => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const badCount = results.filter((x) => !x.pass).length;
        console.log(`\n${results.length - badCount}/${results.length} passed`);
        process.exitCode = badCount ? 1 : 0;
        setTimeout(() => process.exit(badCount ? 1 : 0), 50).unref();
    }
})().catch((e) => { console.error(e); process.exit(1); });
