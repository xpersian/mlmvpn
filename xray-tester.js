// --- xray-tester.js — measuring a list of configs, the way v2rayN measures it ---
//
// This replaces the single-shot tester that used to live inline in /api/v2ray/test-nodes.
// That one had a defect no amount of retrying could survive, and it is worth writing down
// because it produced the complaint «کانفیگ ها دیلی نمیدن» on configs that work perfectly:
//
//   It built ONE xray process with one socks inbound per node, on a base port picked at
//   RANDOM out of 20000–29999, and never checked whether those ports were free. Xray binds
//   every inbound up front and a single failure is fatal to the whole process:
//       Failed to start: app/proxyman/inbound: failed to listen TCP on 28390 > ...
//       bind: Only one usage of each socket address ... is normally permitted.
//   Measured here: occupy one port out of four and ALL FOUR are dead. So one busy port — the
//   live connection's 20808/20809, a Windows reserved exclusion (this machine really has
//   28385 and 28390 reserved: `netsh interface ipv4 show excludedportrange protocol=tcp`),
//   or another copy of the app — turned every node in the batch into "-1" at once, and the
//   route answered 500 while the panel showed "Timeout" on every row.
//
// v2rayN does not leave this to chance, and neither does this module:
//
//   1. PORTS ARE FOUND, NOT GUESSED. v2rayN reads the machine's active listeners and scans
//      upward from a fixed base for unused ones (CoreConfigV2rayService.GenerateClientSpeedtestConfig).
//      Here every candidate port is bind-probed on 127.0.0.1, which is exact rather than a
//      snapshot, and the probes are released together immediately before the core is spawned.
//   2. A PAGE THAT FAILS IS HALVED, NOT LOST. v2rayN's RunRealPingBatchAsync collects the
//      pages whose core did not come up and retests them at half the page size, down to one
//      core per node (RunMixedTestAsync). A single unrepresentable or unluckily-placed node
//      can therefore never take its neighbours down with it.
//   3. EVERY PORT IS CHECKED, NOT JUST THE FIRST. The old code probed basePort only, so a
//      core that half-bound looked ready.
//   4. TCP PING NEEDS NO CORE AT ALL. v2rayN's Tcping is a bare socket connect to the node's
//      own address:port (GetTcpingTime). The old route had no 'ping' branch whatsoever, so
//      «پینگ سرور» fell through to the download branch and reported megabytes per second in
//      a column labelled ms.
//   5. A NODE THAT CANNOT BE PARSED SAYS SO. It used to become a `blackhole` outbound that
//      quietly timed out; now it is reported immediately, with the parser's own message.
//
// The delay figure itself is unchanged and deliberately so — one pooled keep-alive agent,
// two shots 100 ms apart, smallest positive result, two attempts — because that is
// ConnectionHandler.GetRealPingTime and the user compares this screen against v2rayN's.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const { SocksTlsAgent, SocksHttpAgent } = require('./socks-agents');

// Deterministic, and clear of everything else this app binds: the live engine's socks/http
// (20808/20809), its stats api (20085) and the scanner's batch engine (31000+). A fixed base
// also means a failure is reproducible instead of depending on a random draw.
const BASE_PORT = 21300;
const MAX_PORT = 29500;

// One core per this many nodes. v2rayN's default page is enormous (Global.SpeedTestPageSize
// = 1000) because it trusts its port scan; 60 keeps a single core's blast radius small
// enough that the halving below converges in two or three steps on any realistic list.
const PAGE_SIZE = 60;
// Below this a page is not worth halving again — run one core per node instead, which is
// v2rayN's RunMixedTestAsync fallback and cannot fail for a neighbour's reason.
const MIN_PAGE = 4;

const DEFAULT_PROBE_URL = 'https://clients3.google.com/generate_204';
// THROUGHPUT IS MEASURED AGAINST A DOWNLOAD THAT IS NOT ON CLOUDFLARE.
//
// It used to be speed.cloudflare.com, on the theory that these configs come out at Cloudflare
// anyway. For a config that runs ON a Cloudflare Worker — everything «زیرساخت ابری» makes — it
// is the one destination guaranteed to be wrong:
//   * the Edge panel's worker never forwards speed.cloudflare.com (or cp.cloudflare.com) at
//     all (edgeworker.js › isSpeedTestSite). It waits for a plain-HTTP request and answers a
//     local «204 No Content»; an https request never gets its TLS answer and hangs to the cap.
//     Measured through a live Edge config and clean IP on 2026-09-22: delay 146 ms, CacheFly
//     1744 KB/s, speed.cloudflare.com −1 after 9 s — every node, every time. That is the whole
//     of «اندازه‌گیری سرعت واقعی» cycling forever in the assistant with nothing confirmed;
//   * every other worker cannot connect() to a Cloudflare address and detours through its
//     proxy IP, so the number describes the proxy IP rather than the path. Same BPB config,
//     same clean IP: 744 KB/s from speed.cloudflare.com, 1938 KB/s from the file below.
// So the file is Google's own download server — outside Cloudflare, next to every Cloudflare
// edge, and the worker reaches it directly from whichever edge the clean IP landed on: the part
// of the path that actually differs from one clean IP to the next. It honours the Range header
// (206, exactly the bytes asked for), and the URL has been stable for over a decade.
// NOT CacheFly, v2rayN's default, although it was the first thing tried: through a worker its
// 10 MB and 100 MB test files come back as a 7-byte «100mb» placeholder (text/html, 200) —
// it evidently refuses datacenter addresses. Only its 1 MB file still passed on 2026-09-22.
// Plain HTTP on purpose: the tunnel already encrypts it, and no TLS has to be layered onto the
// SOCKS socket (see realSpeed).
const DEFAULT_SPEED_URL = 'http://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
// How much to read. The file is bigger on purpose: the request asks for exactly this much with
// a Range header, and the reader stops here even when a server ignores the range. 1.5 MB is
// enough to leave TCP slow-start behind and short enough that a page of nodes finishes.
const SPEED_BYTES = 1500000;
// Less than this is an error page, a placeholder or an intercepted request, not a transfer —
// a worker answering «204», or CacheFly's 7-byte «100mb», must not come out as a fast node.
const SPEED_MIN_BYTES = 32 * 1024;
const SPEED_CAP_MS = 12000;

const userDir = () => {
    const dir = path.join(os.homedir(), '.mlmvpn');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best effort */ }
    return dir;
};

function unpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

/** Is this TCP port free on loopback right now? Answered by trying to bind it. */
function portIsFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(null));
        srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
}

/**
 * `count` free loopback ports, held open so nothing else can take them in the meantime.
 * Returns { ports, release } — call release() immediately before spawning the core.
 *
 * Holding and releasing leaves a window of a millisecond or two. That is unavoidable without
 * handing xray a socket, and it is a different thing entirely from the old code's blind
 * guess: the ports Windows has RESERVED (its Hyper-V/WinNAT exclusions) and the ports this
 * app itself is using are refused by bind and skipped here, permanently.
 */
// Ports handed to a core in THIS process stay claimed until that core is done. A port is released
// the instant before xray binds it (runPage), so two tests started together from the same base —
// the arena qualifies up to nine at once — found the same "free" port; the second core then either
// died or, worse, its first probe reached the OTHER core and read that config's result
// (measured 2026-09-29: panels knocked out as «unreachable» whose configs carried data).
const claimed = new Map();   // port → claim expiry (a safety net for a claim never given back)
const CLAIM_MS = 120000;
function isClaimed(port) {
    const until = claimed.get(port);
    if (!until) return false;
    if (until < Date.now()) { claimed.delete(port); return false; }
    return true;
}
function unclaim(ports) { for (const p of ports || []) claimed.delete(p); }

async function reservePorts(count, startAt = BASE_PORT) {
    const held = [];
    const ports = [];
    let port = startAt;
    while (ports.length < count && port < MAX_PORT) {
        if (!isClaimed(port)) {
            claimed.set(port, Date.now() + CLAIM_MS);   // before the await: a parallel caller skips it
            const srv = await portIsFree(port);
            if (srv) { held.push(srv); ports.push(port); } else claimed.delete(port);
        }
        port++;
    }
    const release = () => Promise.all(held.map(s => new Promise(r => s.close(r))));
    if (ports.length < count) {
        await release();
        unclaim(ports);
        throw new Error(`هیچ پورت آزادی برای تست پیدا نشد (از ${startAt} تا ${MAX_PORT})`);
    }
    return { ports, release, next: port };
}

/** Wait until something accepts on `port`, or give up. */
function waitForPort(port, budgetMs = 6000) {
    const deadline = Date.now() + budgetMs;
    return new Promise((resolve) => {
        const attempt = () => {
            const sock = new net.Socket();
            sock.setTimeout(500);
            const retry = () => {
                sock.destroy();
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(attempt, 100);
            };
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('error', retry);
            sock.once('timeout', retry);
            sock.connect(port, '127.0.0.1');
        };
        attempt();
    });
}

/**
 * v2rayN's Tcping (SpeedtestService.GetTcpingTime): a plain TCP connect to the node's own
 * address and port, no core, no proxy. Nothing about it needs xray, which is why it is
 * instant and cannot be spoiled by another node in the list.
 */
function tcpPing(address, port, timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (!address || !port) return resolve(-1);
        // IPv6 only when this machine has a route for it — without one a hang costs a slot. Since
        // the filtering of 2026-09-28 a Cloudflare IPv6 address is often the only one that works,
        // so it can no longer be written off wholesale (cf-family.js).
        const bare = String(address).replace(/^\[|\]$/g, '');
        if (bare.includes(':') && !require('./cf-family').hasIpv6RouteNow()) return resolve(-1);
        address = bare;
        const started = Date.now();
        const sock = new net.Socket();
        sock.setTimeout(timeoutMs);
        const fail = () => { sock.destroy(); resolve(-1); };
        sock.once('connect', () => { const ms = Date.now() - started; sock.destroy(); resolve(ms || 1); });
        sock.once('error', fail);
        sock.once('timeout', fail);
        sock.connect(Number(port), String(address));
    });
}

/**
 * ConnectionHandler.GetRealPingTime, over a local SOCKS port.
 *
 * One pooled agent for both shots, so shot #2 rides the tunnel shot #1 built; smallest
 * positive result; the body is drained or the socket never returns to the pool and shot #2
 * pays for a whole new handshake (which is what made every delay this app printed 4× too
 * large before this method was adopted).
 */
/**
 * How fast this node actually moves bytes, in KB/s.
 *
 * Latency and throughput are different questions and a low ping does not answer the second one:
 * a node one hop away on a saturated link pings beautifully and downloads at 40 KB/s. This is
 * what «سرعت کانفیگ‌ها» measures, so that choosing it gives a genuinely different list from
 * choosing latency — which is the whole point of offering the choice.
 *
 * Bytes are counted from the FIRST byte of the body, not from the request: otherwise the
 * connect and the TLS handshake are charged to the transfer and a distant node is punished
 * twice for the same distance.
 *
 * The cap is on the WHOLE measurement, not on silence. The old `req.setTimeout` was an idle
 * timer, so a node trickling a few KB a second held its slot until all 1.5 MB had arrived. Now
 * a node still sending at the cap is scored on what it managed — it works, it is just slow, and
 * a slow working node is not the same answer as a dead one.
 */
async function realSpeed(socksPort, speedUrl, { log = () => {}, bytes: want = SPEED_BYTES, capMs = SPEED_CAP_MS } = {}) {
    let url = null;
    try { url = new URL(speedUrl); } catch (e) { return { val: -1, reason: 'probe-url' }; }

    const isTls = url.protocol !== 'http:';
    const agent = isTls ? new SocksTlsAgent(socksPort) : new SocksHttpAgent(socksPort);

    const out = await new Promise((resolve) => {
        let settled = false;
        let got = 0;
        let first = 0;
        let req = null;
        let cap = null;
        const rate = () => {
            const ms = first ? (Date.now() - first) : 0;
            return ms > 0 ? Math.max(1, Math.round((got / 1024) / (ms / 1000))) : -1;
        };
        const finish = (val, reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(cap);
            // Enough was read, or the node is done for: stop the transfer rather than let the
            // rest of a large file stream into a socket nobody is reading.
            try { if (req) req.destroy(); } catch (e) {}
            resolve({ val, reason });
        };
        const scored = () => { const v = rate(); finish(v, v > 0 ? undefined : 'short'); };
        req = (isTls ? https : http).request({
            host: url.hostname,
            port: url.port || (isTls ? 443 : 80),
            path: (url.pathname || '/') + (url.search || ''),
            method: 'GET',
            agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Cache-Control': 'no-cache',
                // Ask for exactly what will be read…
                'Range': `bytes=0-${want - 1}`,
            },
        }, (response) => {
            const code = response.statusCode || 0;
            // 206 answers the Range; 200 is a server that ignored it and sends the whole file.
            if (!(code >= 200 && code < 300)) { response.resume(); return finish(-1, 'http-' + code); }
            response.on('data', (d) => {
                if (!first) first = Date.now();
                got += d.length;
                // …and stop there even if the whole file is coming.
                if (got >= want) scored();
            });
            response.on('end', () => {
                if (got < SPEED_MIN_BYTES) return finish(-1, got ? 'short' : 'empty');
                scored();
            });
            response.on('error', (e) => finish(-1, e.message));
        });
        cap = setTimeout(() => {
            if (got >= SPEED_MIN_BYTES) scored();
            else finish(-1, 'timeout');
        }, capMs);
        req.on('error', (err) => finish(-1, err.message));
        req.end();
    });

    try { agent.destroy(); } catch (e) {}
    return out;
}

async function realPing(socksPort, probeUrl, { sanctioned = false, log = () => {} } = {}) {
    let url = null;
    try { url = new URL(probeUrl); } catch (e) { return { val: -1, reason: 'probe-url' }; }

    const isTls = url.protocol !== 'http:';
    const agent = isTls ? new SocksTlsAgent(socksPort) : new SocksHttpAgent(socksPort);
    let lastReason = 'timeout';

    const shot = () => new Promise((resolve) => {
        const started = Date.now();
        let settled = false;
        const finish = (val, reason) => {
            if (settled) return;
            settled = true;
            if (reason) lastReason = reason;
            resolve(val);
        };
        const req = (isTls ? https : http).request({
            host: url.hostname,
            port: url.port || (isTls ? 443 : 80),
            path: (url.pathname || '/') + (url.search || ''),
            method: 'GET',
            agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                // No `Connection: close`: that is what stopped the socket being pooled.
                'Cache-Control': 'no-cache',
            },
        }, (response) => {
            const code = response.statusCode || 0;
            response.resume();
            response.on('end', () => {
                const elapsed = Date.now() - started;
                // Platforms that sanction Iranian addresses answer 403/451 over a perfectly
                // good tunnel; for THOSE targets that is a failure worth reporting, while
                // YouTube and Binance return 403 to a bare probe as a matter of course.
                if (!(code > 0) || (sanctioned && (code === 403 || code === 451))) {
                    return finish(-1, 'http-' + code);
                }
                finish(elapsed || 1);
            });
            response.on('error', (e) => finish(-1, e.message));
        });
        // v2rayN caps the whole real-ping at 9 s.
        req.setTimeout(9000, () => { try { req.destroy(); } catch (e) { } finish(-1, 'timeout'); });
        req.on('error', (err) => finish(-1, err.message));
        req.end();
    });

    const startedAll = Date.now();
    let best = -1;
    // Outer loop = GetRealPingTimeInfo's retry, inner pair = GetRealPingTime.
    for (let attempt = 0; attempt < 2 && best <= 0; attempt++) {
        const shots = [];
        for (let i = 0; i < 2; i++) {
            if (Date.now() - startedAll > 12000) break;
            const t = await shot();
            if (t > 0) shots.push(t);
            if (i === 0) await new Promise(r => setTimeout(r, 100));
        }
        if (shots.length) best = Math.min(...shots);
        if (best <= 0 && attempt === 0) await new Promise(r => setTimeout(r, 500));
    }

    try { agent.destroy(); } catch (e) { }
    return best > 0 ? { val: best } : { val: -1, reason: lastReason };
}

const SANCTIONED = ['deepmind', 'anthropic', 'chatgpt', 'openai', 'gemini'];
const isSanctionedTarget = (u) => !!u && SANCTIONED.some(s => String(u).includes(s));

/**
 * One core, one page of nodes. Resolves { ok, results } — ok:false means the CORE did not
 * come up, which says nothing about the nodes and is the caller's cue to halve the page.
 */
async function runPage(page, opts) {
    let heldPorts = null;
    try { return await runPageInner(page, opts, (p) => { heldPorts = p; }); }
    finally { unclaim(heldPorts); }
}

async function runPageInner(page, opts, onPorts) {
    const { probeUrl, concurrency, isAborted, log, onResult } = opts;
    // 'delay' → milliseconds (lower is better) · 'speed' → KB/s (higher is better).
    const mode = opts.mode === 'speed' ? 'speed' : 'delay';
    // How long a core gets to bind. A parameter rather than a constant so the test suite can
    // exercise the halving fallback in seconds instead of minutes.
    const firstBudget = opts.portBudgetMs || 6000;
    const restBudget = Math.max(400, Math.round(firstBudget / 4));

    let reserved;
    try {
        reserved = await reservePorts(page.length, opts.basePort || BASE_PORT);
    } catch (e) {
        log(`[Test] ${e.message}`);
        return { ok: false, reason: 'ports' };
    }
    const ports = reserved.ports;
    onPorts(ports);

    const inbounds = [];
    const outbounds = [];
    const rules = [];
    page.forEach((node, i) => {
        inbounds.push({
            port: ports[i], listen: '127.0.0.1', protocol: 'socks',
            settings: { udp: true }, tag: `in-${i}`,
        });
        outbounds.push(Object.assign({}, node.outbound, { tag: `out-${i}` }));
        rules.push({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` });
    });

    const dir = userDir();
    // One file per run: tests running side by side each wrote the same config_test_solo.json, and a
    // core could start on its neighbour's config.
    const configPath = path.join(dir, `config_test_${ports[0]}_${page.length}.json`);
    const config = {
        log: { loglevel: 'warning' },
        inbounds,
        outbounds,
        dns: { servers: ['8.8.8.8', '1.1.1.1', 'localhost'] },
        routing: { rules },
    };
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        await reserved.release();
        log(`[Test] نوشتن کانفیگ تست ناموفق بود: ${e.message}`);
        return { ok: false, reason: 'config-write' };
    }

    const exePath = require('./core-paths').file('xray', 'xray.exe', path.join(unpackedDir(), 'core', 'xray.exe'));
    if (!fs.existsSync(exePath)) {
        await reserved.release();
        return { ok: false, reason: 'core-missing' };
    }

    // Hand the ports over: held until this instant so nothing could take them, free now so
    // xray can bind them.
    await reserved.release();

    const proc = spawn(exePath, ['-config', configPath], { windowsHide: true });
    // The core's own words, kept for the error the user is shown. Xray says exactly why it
    // refused to start and that sentence used to be thrown away.
    let coreErr = '';
    const grab = (d) => { coreErr = (coreErr + d.toString()).slice(-4000); };
    if (proc.stdout) proc.stdout.on('data', grab);
    if (proc.stderr) proc.stderr.on('data', grab);
    let exited = false;
    proc.on('error', (e) => { exited = true; coreErr += '\n' + e.message; });
    proc.on('close', () => { exited = true; });

    const kill = () => { try { proc.kill(); } catch (e) { } };

    // EVERY port, not just the first: a core that bound half its inbounds and then died
    // still answered on the one the old code probed.
    const firstUp = await waitForPort(ports[0], firstBudget);
    if (!firstUp || exited) {
        kill();
        const why = (coreErr.match(/Failed to start:.*/) || coreErr.match(/failed to .*/i) || [''])[0].trim();
        log(`[Test] هسته بالا نیامد (${page.length} کانفیگ، پورت ${ports[0]}): ${why || 'بدون پیام'}`);
        return { ok: false, reason: 'core', detail: why };
    }
    for (let i = 1; i < ports.length; i++) {
        if (!(await waitForPort(ports[i], restBudget))) {
            kill();
            log(`[Test] هسته پورت ${ports[i]} را باز نکرد — صفحه نصف می‌شود`);
            return { ok: false, reason: 'core-partial' };
        }
    }

    const sanctioned = isSanctionedTarget(probeUrl);
    const results = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < page.length) {
            if (isAborted()) return;
            const i = cursor++;
            const node = page[i];
            log(`[Test ${mode === 'speed' ? 'Speed' : 'Delay'}] Node ${node.id} on port ${ports[i]}…`);
            const r = mode === 'speed'
                ? await realSpeed(ports[i], probeUrl, { log })
                : await realPing(ports[i], probeUrl, { sanctioned, log });
            const out = { id: node.id, val: r.val, reason: r.reason, unit: mode === 'speed' ? 'kbps' : 'ms' };
            results.push(out);
            onResult(out);
            log(`[Test ${mode === 'speed' ? 'Speed' : 'Delay'}] Node ${node.id} → ${r.val}${r.val > 0 ? (mode === 'speed' ? ' KB/s' : 'ms') : ` (${r.reason || 'ناموفق'})`}`);
        }
    };
    const lanes = Math.max(1, Math.min(concurrency, page.length));
    await Promise.all(Array.from({ length: lanes }, worker));

    kill();
    try { fs.unlinkSync(configPath); } catch (e) { /* the next run overwrites it */ }
    return { ok: true, results };
}

/**
 * Measure a list of nodes.
 *
 * @param nodes      [{ id, uri }] — id is whatever the caller wants echoed back.
 * @param testType   'delay' (real ping through the core, ms — lower is better),
 *                   'speed' (real throughput through the core, KB/s — higher is better),
 *                   or 'ping' (tcping, no core at all — fastest, but it only proves the port
 *                   answers, not that anything passes through it).
 * @param onResult   called once per node, as soon as its number exists.
 * @returns { results, coreFailures } — coreFailures counts nodes that could not be measured
 *           because no core would run for them, which is a different thing from a dead node
 *           and the panel says so.
 */
async function testNodes({
    nodes,
    cleanIp = null,
    cleanPort = null,
    testType = 'delay',
    settings = {},
    onResult = () => {},
    isAborted = () => false,
    log = () => {},
    timings = {},
    basePort = BASE_PORT,
} = {}) {
    const { parseVlessUri } = require('./xray-manager');

    const prepared = [];
    const results = [];
    const emit = (r) => { results.push(r); onResult(r); };

    for (const n of nodes || []) {
        const uri = String(n.uri || '').trim();
        // A pasted JSON config has no address of its own to reach from here and no URI to
        // parse; it is skipped rather than measured as a freedom outbound (which is what the
        // old code did, producing a number that described the user's own connection).
        if (!uri || uri.startsWith('{')) {
            emit({ id: n.id, val: -1, reason: 'json' });
            continue;
        }
        let outbound;
        try {
            outbound = parseVlessUri(uri, cleanIp, cleanPort);
        } catch (e) {
            emit({ id: n.id, val: -1, reason: e.message });
            continue;
        }
        const srv = (outbound.settings
            && ((outbound.settings.vnext && outbound.settings.vnext[0])
                || (outbound.settings.servers && outbound.settings.servers[0]))) || null;
        prepared.push({ id: n.id, uri, outbound, address: srv && srv.address, port: srv && srv.port });
    }

    // ── tcping: no core, so nothing can go wrong for a neighbour's reason ────────────
    if (testType === 'ping') {
        const lanes = Math.max(1, Math.min(parseInt(settings.concurrency, 10) || 30, prepared.length || 1));
        let cursor = 0;
        const worker = async () => {
            while (cursor < prepared.length) {
                if (isAborted()) return;
                const node = prepared[cursor++];
                const ms = await tcpPing(node.address, node.port);
                emit({ id: node.id, val: ms, reason: ms > 0 ? undefined : 'unreachable' });
            }
        };
        await Promise.all(Array.from({ length: lanes }, worker));
        return { results, coreFailures: 0 };
    }

    // ── real delay or real throughput: pages of nodes behind one core, halved on failure ──
    const speedMode = testType === 'speed';
    const probeUrl = settings.pingUrl || (speedMode ? DEFAULT_SPEED_URL : DEFAULT_PROBE_URL);
    const concurrency = parseInt(settings.concurrency, 10) > 0 ? parseInt(settings.concurrency, 10) : 30;
    let coreFailures = 0;

    const run = async (list, pageSize) => {
        if (!list.length || isAborted()) return;
        const failed = [];
        for (let i = 0; i < list.length; i += pageSize) {
            if (isAborted()) return;
            const page = list.slice(i, i + pageSize);
            const r = await runPage(page, { probeUrl, concurrency, isAborted, log, onResult: emit, portBudgetMs: timings.portBudgetMs, mode: speedMode ? 'speed' : 'delay', basePort });
            if (!r.ok) failed.push(...page);
        }
        if (!failed.length || isAborted()) return;

        const next = Math.floor(pageSize / 2);
        if (next >= MIN_PAGE) {
            log(`[Test] ${failed.length} کانفیگ با هسته‌ی مشترک تست نشدند — با صفحه‌ی ${next} دوباره`);
            return run(failed, next);
        }
        // v2rayN's last resort: one core per node. A node that fails here really cannot be
        // measured, and that is reported as such rather than as a timeout.
        log(`[Test] ${failed.length} کانفیگ با هسته‌ی جداگانه تست می‌شوند`);
        for (const node of failed) {
            if (isAborted()) return;
            const r = await runPage([node], { probeUrl, concurrency: 1, isAborted, log, onResult: emit, portBudgetMs: timings.portBudgetMs, mode: speedMode ? 'speed' : 'delay', basePort });
            if (!r.ok) {
                coreFailures++;
                emit({ id: node.id, val: -1, reason: 'core' });
            }
        }
    };

    await run(prepared, Math.min(prepared.length || 1, PAGE_SIZE));
    return { results, coreFailures };
}

/**
 * The real delay of each link, in the order given (ms, or -1), within `timeoutMs` overall — for
 * the self-healing layer (cf-family / cf-edge-heal), which has to decide in seconds whether a
 * family carries data. Its own port range, so it never collides with a delay test the user is
 * running at the same moment.
 */
async function measureUris(uris, { timeoutMs = 10000, basePort = 26000, log = () => {}, probeUrl = null, mode = 'delay' } = {}) {
    const out = uris.map(() => -1);
    if (!uris.length) return out;
    let stop = false;
    const run = testNodes({
        nodes: uris.map((uri, i) => ({ id: i, uri })),
        // 'speed' answers KB/s (higher is better); 'delay' ms. `probeUrl` replaces the default target.
        testType: mode === 'speed' ? 'speed' : 'delay',
        settings: Object.assign({ concurrency: mode === 'speed' ? 1 : uris.length }, probeUrl ? { pingUrl: probeUrl } : {}),
        basePort,
        isAborted: () => stop,
        log,
        onResult: (r) => { if (typeof r.id === 'number' && r.val > 0) out[r.id] = r.val; },
    }).catch(() => {});
    let timer = null;
    await Promise.race([run, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
    stop = true;
    return out.slice();
}

module.exports = {
    testNodes, measureUris,
    // exported for the tests and for anything that wants one of the pieces
    reservePorts, waitForPort, tcpPing, realPing, realSpeed, portIsFree,
    BASE_PORT, PAGE_SIZE, MIN_PAGE, DEFAULT_PROBE_URL, DEFAULT_SPEED_URL, SPEED_BYTES, SPEED_MIN_BYTES,
};
