// The throughput measurement's contract — xray-tester.js › realSpeed.
//
// «سرعت کانفیگ‌ها» in the assistant never finished for Edge configs: the Edge worker never
// forwards speed.cloudflare.com — it answers a local «204» to a plain request and nothing at all
// to an encrypted one — so every address «failed» and the run looped forever. Each case below is
// one of the shapes a download can take through a worker, and what the measurement must make of
// it: a placeholder or an interception is a failure, never a fast node; a slow node that is still
// sending at the cap is a slow node, not a dead one.
//
// Nothing here reaches the internet: an HTTP server on loopback plays the download target, and a
// minimal SOCKS5 relay on loopback plays the core's inbound.
const path = require('path');
const net = require('net');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const tester = require(ROOT + '/xray-tester');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── the download target ─────────────────────────────────────────────────────────
const seen = {};
const chunk = Buffer.alloc(16 * 1024, 7);
const target = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    seen[route] = { range: req.headers.range || null, closedEarly: false, sent: 0 };
    res.on('close', () => { if (!res.writableEnded) seen[route].closedEarly = true; });
    const pump = (total, gapMs) => {
        const next = () => {
            if (seen[route].sent >= total || res.destroyed) { if (!res.destroyed) res.end(); return; }
            const n = Math.min(chunk.length, total - seen[route].sent);
            seen[route].sent += n;
            res.write(chunk.subarray(0, n));
            setTimeout(next, gapMs);
        };
        next();
    };
    if (route === '/ignores-range') {           // a server that sends the whole file anyway
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return pump(8 * 1024 * 1024, 0);
    }
    if (route === '/ranged') {                  // what dl.google.com does: 206, exactly the range
        const m = /bytes=0-(\d+)/.exec(req.headers.range || '');
        const len = m ? Number(m[1]) + 1 : 8 * 1024 * 1024;
        res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': len });
        return pump(len, 0);
    }
    if (route === '/no-content') {              // the Edge worker's answer to a speed test
        res.writeHead(204);
        return res.end();
    }
    if (route === '/placeholder') {             // CacheFly's answer to a datacenter address
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('100mb\n');
    }
    if (route === '/slow') {                    // a working node that cannot finish in time
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return pump(8 * 1024 * 1024, 120);
    }
    if (route === '/silent') {                  // headers, then nothing: a hung transfer
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return;                                 // never ends
    }
    res.writeHead(404);
    res.end();
});

// ── a minimal SOCKS5 relay: no auth, CONNECT only ───────────────────────────────
const relays = new Set();
const socks = net.createServer((client) => {
    relays.add(client);
    client.on('error', () => {});
    client.once('data', () => {
        client.write(Buffer.from([5, 0]));
        client.once('data', (req) => {
            let host, i;
            if (req[3] === 1) { host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`; i = 8; }
            else if (req[3] === 3) { host = req.subarray(5, 5 + req[4]).toString(); i = 5 + req[4]; }
            else { client.destroy(); return; }
            const port = req.readUInt16BE(i);
            const up = net.connect(port, host, () => {
                client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                client.pipe(up); up.pipe(client);
            });
            relays.add(up);
            up.on('error', () => client.destroy());
            client.on('close', () => up.destroy());
        });
    });
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
    const httpPort = await listen(target);
    const socksPort = await listen(socks);
    const url = (route) => `http://127.0.0.1:${httpPort}${route}`;
    const BYTES = 256 * 1024;

    // ── 1. it asks for what it will read, and stops there ───────────────────────
    let r = await tester.realSpeed(socksPort, url('/ranged'), { bytes: BYTES, capMs: 5000 });
    t('a ranged download is measured', r.val > 0, JSON.stringify(r));
    t('…and the request carried the Range header', seen['/ranged'] && seen['/ranged'].range === `bytes=0-${BYTES - 1}`,
        JSON.stringify(seen['/ranged']));

    r = await tester.realSpeed(socksPort, url('/ignores-range'), { bytes: BYTES, capMs: 5000 });
    await new Promise(res => setTimeout(res, 300));
    t('a server that ignores the range is still measured', r.val > 0, JSON.stringify(r));
    t('…and the rest of its file is not downloaded', seen['/ignores-range'] && seen['/ignores-range'].closedEarly
        && seen['/ignores-range'].sent < 8 * 1024 * 1024, JSON.stringify(seen['/ignores-range']));

    // ── 2. an interception or a placeholder is a failure, never a fast node ────
    r = await tester.realSpeed(socksPort, url('/no-content'), { bytes: BYTES, capMs: 5000 });
    t('a «204 No Content» answer (the Edge worker) is a failure', r.val === -1 && r.reason === 'empty', JSON.stringify(r));

    r = await tester.realSpeed(socksPort, url('/placeholder'), { bytes: BYTES, capMs: 5000 });
    t('a 7-byte placeholder (CacheFly to a datacenter) is a failure', r.val === -1 && r.reason === 'short', JSON.stringify(r));

    r = await tester.realSpeed(socksPort, url('/missing'), { bytes: BYTES, capMs: 5000 });
    t('an HTTP error is a failure with its status', r.val === -1 && r.reason === 'http-404', JSON.stringify(r));

    // ── 3. the cap is on the whole measurement, not on silence ──────────────────
    const started = Date.now();
    r = await tester.realSpeed(socksPort, url('/slow'), { bytes: 4 * 1024 * 1024, capMs: 1500 });
    const took = Date.now() - started;
    t('a node still sending at the cap is scored on what arrived', r.val > 0, JSON.stringify(r));
    t('…and the cap holds even though data kept arriving', took < 3000, `${took} ms`);

    r = await tester.realSpeed(socksPort, url('/silent'), { bytes: BYTES, capMs: 1200 });
    t('a transfer that never sends a byte is a timeout', r.val === -1 && r.reason === 'timeout', JSON.stringify(r));

    // ── 4. the default target is not on Cloudflare ──────────────────────────────
    t('the default speed target is not a Cloudflare host (the Edge worker fakes those)',
        !/cloudflare\.com/i.test(tester.DEFAULT_SPEED_URL), tester.DEFAULT_SPEED_URL);

    relays.forEach(s => s.destroy());
    target.closeAllConnections();
    await Promise.all([target, socks].map(s => new Promise(r => { s.close(() => r()); })));

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
