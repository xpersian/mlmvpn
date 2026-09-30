// P4 — THE EXIT COUNTRY, chosen on the server (runner/exits.mjs, runner/xray-config.mjs, gt-core.js).
//
//   1. the runner: one VLESS user per exit slot, each routed to its own local port AFTER the
//      blocks; VPN Gate's list parsed and ranked; the per-slot exit Xray bound to its tun DEVICE
//      (VPN Gate) or chained to Psiphon with UDP left to the runner (Psiphon) — all accepted by
//      the real Xray
//   2. for real, with two Xrays and a stand-in exit: the SAME tunnel, a different user id, and the
//      traffic leaves by that user's exit — the direct user does not
//   3. the exit broker's bookkeeping: a country → a slot (reused while it lives), VPN Gate where it
//      has the country and Psiphon where it does not, six slots and no more, a failure reported
//   4. the client: the exit plan — the default user, site rules on their own outbounds and a domain
//      rule ahead of the default, nothing the runner did not offer
//
// Nothing leaves the machine; nothing here runs OpenVPN or Psiphon.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const SANDBOX = path.join(__dirname, 'home-exits');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const XRAY = path.join(ROOT, 'core', 'xray.exe');
const xrayTest = (cfg) => spawnSync(XRAY, ['run', '-test', '-c', 'stdin:'], { input: JSON.stringify(cfg), encoding: 'utf8', timeout: 30000 });

/** One GET through a SOCKS5 port to any host and port (domain names resolved at the far end). */
function socksAsk(socksPort, host, port, reqPath, timeoutMs = 6000) {
    return new Promise((resolve) => {
        const sock = net.connect(socksPort, '127.0.0.1');
        let stage = 0;
        let got = Buffer.alloc(0);
        const done = (extra = {}) => { clearTimeout(timer); sock.destroy(); resolve({ text: got.toString('latin1'), ...extra }); };
        const timer = setTimeout(() => done({ timedOut: true }), timeoutMs);
        sock.on('error', (e) => done({ error: e.code || e.message }));
        sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
        sock.on('data', (b) => {
            if (stage === 0) { stage = 1; const h = Buffer.from(host); const p = Buffer.alloc(2); p.writeUInt16BE(port, 0); sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p])); return; }
            if (stage === 1) { stage = 2; if (b[1] !== 0) return done({ refused: b[1] }); sock.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`); return; }
            got = Buffer.concat([got, b]);
        });
        sock.on('end', () => done());
    });
}

(async () => {
    const exits = await import(pathToFileURL(path.join(ROOT, 'github-tunnel', 'runner', 'exits.mjs')).href);
    const xc = await import(pathToFileURL(path.join(ROOT, 'github-tunnel', 'runner', 'xray-config.mjs')).href);

    // ════ 1. the runner's pieces ════
    const uuids = Array.from({ length: exits.EXIT_SLOTS }, () => crypto.randomUUID());
    const slotsPub = exits.exitSlots(uuids);
    t('six exit slots, x1…x6, each its own user and its own local port',
        slotsPub.length === 6 && slotsPub.every((s, i) => s.id === `x${i + 1}` && s.uuid === uuids[i] && s.port === exits.EXIT_BASE_PORT + i + 1));
    const main = xc.buildXrayConfig({ uuid: crypto.randomUUID(), wsPath: '/abcdEFGH1234', exits: slotsPub });
    const users = main.inbounds[0].settings.clients;
    t('the main Xray knows every exit user by its own email', users.length === 7 && slotsPub.every((s) => users.some((u) => u.id === s.uuid && u.email === `${s.id}@gt`)));
    t('…each routed to its own local SOCKS port', slotsPub.every((s) => main.outbounds.some((o) => o.tag === `exit-${s.id}` && o.protocol === 'socks' && o.settings.servers[0].address === '127.0.0.1' && o.settings.servers[0].port === s.port)));
    const rules = main.routing.rules;
    const firstExitRule = rules.findIndex((r) => r.user);
    t('…AFTER the status channel and every block (an exit is another way out, never a way around them)',
        firstExitRule > rules.findIndex((r) => (r.ip || []).includes('geoip:private')) && firstExitRule > rules.findIndex((r) => r.protocol) && firstExitRule > rules.findIndex((r) => r.port)
        && rules[0].outboundTag === 'status');
    let r = xrayTest(main);
    t('the real Xray accepts the runner config with its exits', r.status === 0 && /Configuration OK/.test(r.stdout || ''), (r.stdout || r.stderr || '').slice(-200));

    const vg = exits.buildExitXrayConfig({ port: 21101, provider: 'vpngate', dev: 'tun11' });
    t('a VPN Gate exit binds its sockets to the tun DEVICE (two servers can hand out one address)',
        vg.outbounds[0].streamSettings.sockopt.interface === 'tun11' && !vg.outbounds[0].sendThrough && vg.inbounds[0].listen === '127.0.0.1' && vg.inbounds[0].settings.udp === true);
    let bad = null;
    try { exits.buildExitXrayConfig({ port: 21101, provider: 'vpngate', dev: 'eth0; rm -rf /' }); } catch (e) { bad = e; }
    t('…and nothing but a tun device name gets into that config', !!bad);
    const ps = exits.buildExitXrayConfig({ port: 21102, provider: 'psiphon', psiphonPort: 21202 });
    t('a Psiphon exit chains TCP to Psiphon and sends UDP out of the runner (Psiphon has none)',
        ps.outbounds[0].protocol === 'socks' && ps.outbounds[0].settings.servers[0].port === 21202
        && ps.routing.rules.some((x) => x.network === 'udp' && !x.port && x.outboundTag === 'udp-direct'));
    const dnsRule = ps.routing.rules.findIndex((x) => x.port === '53' && x.outboundTag === 'dns-out');
    t('…except DNS: answered on the exit over TCP THROUGH Psiphon, so names resolve for the chosen country',
        dnsRule >= 0 && dnsRule < ps.routing.rules.findIndex((x) => x.outboundTag === 'udp-direct')
        && ps.outbounds.some((o) => o.tag === 'dns-out' && o.protocol === 'dns') && ps.dns.servers.every((u) => /^tcp:\/\//.test(u)) && ps.outbounds[0].tag === 'out');
    r = xrayTest(vg);
    const r2 = xrayTest(ps);
    t('the real Xray accepts both exit configs', r.status === 0 && r2.status === 0, (r.stdout || r.stderr || '').slice(-160) + (r2.stdout || r2.stderr || '').slice(-160));

    const b64 = Buffer.from('client\nremote 1.2.3.4 1194\n').toString('base64');
    const csv = [
        '*vpn_servers', '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64',
        `a,219.100.37.1,100,10,20000000,Japan,JP,1,1,1,1,x,y,z,${b64}`,
        `b,219.100.37.2,300,12,90000000,Japan,JP,1,1,1,1,x,y,z,${b64}`,
        `c,1.2.3.4,50,40,5000000,Korea Republic of,KR,1,1,1,1,x,y,z,${b64}`,
        `d,not-an-ip,50,40,5000000,Nowhere,XX,1,1,1,1,x,y,z,${b64}`,
        `e,5.6.7.8,50,40,5000000,Bad,jpn,1,1,1,1,x,y,z,${b64}`,
        '*',
    ].join('\r\n');
    const parsed = exits.parseVpngate(csv);
    t('VPN Gate\'s list: grouped by country, fastest first, junk rows refused',
        Object.keys(parsed).sort().join() === 'JP,KR' && parsed.JP[0].ip === '219.100.37.2' && parsed.JP.length === 2 && parsed.KR.length === 1, JSON.stringify(Object.keys(parsed)));

    // ════ 2. for real: a user id picks the exit ════
    if (fs.existsSync(XRAY)) {
        const [wsPort, exitPort, standInPort, socksPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
        const uDirect = crypto.randomUUID();
        const uExit = crypto.randomUUID();
        const wsPath = '/abcdEFGH1234';
        const standIn = http.createServer((req, res) => { const b = `EXIT-X1 ${req.headers.host}`; res.writeHead(200, { 'Content-Length': Buffer.byteLength(b) }); res.end(b); });
        await new Promise((res) => standIn.listen(standInPort, '127.0.0.1', res));
        const runner = xc.buildXrayConfig({ uuid: uDirect, wsPath, wsPort, exits: [{ id: 'x1', uuid: uExit, port: exitPort }] });
        // The stand-in exit: whatever it is asked for lands on the local server that says «EXIT-X1».
        const exitX = { log: { loglevel: 'none' }, inbounds: [{ listen: '127.0.0.1', port: exitPort, protocol: 'socks', settings: { auth: 'noauth', udp: true } }],
            outbounds: [{ protocol: 'freedom', settings: { redirect: `127.0.0.1:${standInPort}` } }] };
        const client = (id) => ({ log: { loglevel: 'none' }, inbounds: [{ listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { auth: 'noauth' } }],
            outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: '127.0.0.1', port: wsPort, users: [{ id, encryption: 'none' }] }] }, streamSettings: { network: 'ws', wsSettings: { path: wsPath } } }] });
        const run = (c) => { const p = spawn(XRAY, ['run', '-c', 'stdin:'], { stdio: ['pipe', 'ignore', 'ignore'] }); p.stdin.end(JSON.stringify(c)); return p; };
        const procs = [run(runner), run(exitX)];
        const cleanip = require(ROOT + '/github-tunnel/gt-cleanip');
        try {
            await cleanip.waitPort(wsPort, 6000);
            await cleanip.waitPort(exitPort, 6000);
            let c = run(client(uExit));
            await cleanip.waitPort(socksPort, 6000);
            const viaExit = await socksAsk(socksPort, 'example.test', 80, '/');
            c.kill(); await sleep(400);
            c = run(client(uDirect));
            await cleanip.waitPort(socksPort, 6000);
            const viaDirect = await socksAsk(socksPort, 'example.test', 80, '/', 4000);
            c.kill();
            t('the SAME tunnel with the exit\'s user id leaves by that exit', /EXIT-X1 example\.test/.test(viaExit.text), JSON.stringify(viaExit).slice(0, 200));
            t('…and the direct user does not (it leaves by the runner itself)', !/EXIT-X1/.test(viaDirect.text), JSON.stringify(viaDirect).slice(0, 200));
        } finally {
            procs.forEach((p) => { try { p.kill(); } catch (e) {} });
            standIn.close();
        }
    }

    const agentSrc = fs.readFileSync(path.join(ROOT, 'github-tunnel', 'runner', 'gt-agent.mjs'), 'utf8');
    const wf = require(ROOT + '/github-tunnel/gt-workflow-template').buildWorkflowYamlV2();
    t('the chosen countries reach the runner as an input (codes only) and are started at boot',
        /\n      exits:\n        description: '[^']*'\n        required: false\n        type: string\n        default: ''/.test(wf) && /EXITS: \$\{\{ inputs\.exits \}\}/.test(wf)
        && /\/\^\[A-Z\]\{2\}\(:\(vpngate\|psiphon\)\)\?\$\/\.test\(s\)\)\.slice\(0, 6\)/.test(agentSrc) && /exitBroker\.request\(cc, provider \|\| ''\)/.test(agentSrc));
    t('the runner\'s exits end with the session (OpenVPN and Psiphon stopped before it exits)', /if \(exitBroker\) await exitBroker\.stopAll\(\);/.test(agentSrc));

    // ════ 3. the broker's bookkeeping (nothing is really brought up: every command fails) ════
    const logs = [];
    let hang = false;
    const broker = exits.createExitBroker({
        work: path.join(SANDBOX, 'work'), log: (m) => logs.push(m), sleep, xrayBin: 'xray',
        pexec: () => (hang ? new Promise(() => {}) : Promise.reject(Object.assign(new Error('no openvpn here'), { stdout: '' }))),
        fetchPinned: () => (hang ? new Promise(() => {}) : Promise.reject(new Error('no psiphon here'))),
        onChange: () => {},
    });
    fs.mkdirSync(path.join(SANDBOX, 'work'), { recursive: true });
    broker.init(uuids);
    const realFetch = global.fetch;
    global.fetch = async () => new Response(csv, { status: 200 });
    await broker.refreshCatalog();
    global.fetch = realFetch;
    t('the catalog: VPN Gate countries with their server counts, and Psiphon\'s regions', broker.publicState().catalog.vpngate.JP === 2 && broker.publicState().catalog.psiphon.includes('DE'));
    const jp = broker.request('jp');
    const de = broker.request('DE');
    t('a country VPN Gate has goes to VPN Gate; one it lacks, to Psiphon', jp.provider === 'vpngate' && jp.country === 'JP' && de.provider === 'psiphon' && jp.id !== de.id, JSON.stringify([jp, de]));
    t('…starting at once, each on its own slot', jp.state === 'starting' && de.state === 'starting');
    await sleep(50);
    const st = broker.publicState().exits;
    const jpNow = st.find((x) => x.id === jp.id);
    t('asked for the COUNTRY: VPN Gate failing falls back to Psiphon for the same country', jpNow && jpNow.provider === 'psiphon' && jpNow.country === 'JP', JSON.stringify(jpNow));
    t('…and when both fail, the slot says so with BOTH reasons', jpNow && jpNow.state === 'failed' && /VPN Gate: .*openvpn/i.test(jpNow.error) && /Psiphon: .*psiphon/i.test(jpNow.error), JSON.stringify(jpNow));
    let err = null;
    try { broker.request('../etc'); } catch (e) { err = e; }
    t('anything but a country code is refused', err && err.status === 400);
    hang = true;
    const again = broker.request('JP');
    t('a failed slot is free again', again.state === 'starting');
    t('…and asking twice for the same country while it comes up gives the same slot', broker.request('JP').id === again.id);
    for (const cc of ['KR', 'FR', 'NL', 'SE', 'GB']) { try { broker.request(cc); } catch (e) { err = e; } }
    err = null;
    try { broker.request('SG'); } catch (e) { err = e; }
    t('six exits at once and no more — the seventh is refused with a reason', err && err.status === 409 && broker.publicState().exits.filter((x) => x.state === 'starting').length === 6);

    // ════ 3b. supervision looks at WHERE an exit leaves from, not only whether it answers ════
    // Measured 2026-09-24: a VPN Gate JP exit stayed 'ready' for minutes while everything through it
    // left from the runner's own Azure address; the liveness probe alone never noticed.
    const supLogs = [];
    const egress = {};
    const sup = exits.createExitBroker({
        work: path.join(SANDBOX, 'work-sup'), log: (m) => supLogs.push(m), sleep, xrayBin: 'xray',
        pexec: (cmd, args) => {
            const port = ((args || []).find((a) => /^127\.0\.0\.1:\d+$/.test(a)) || '').split(':')[1];
            // A real round trip is never 0 ms, and rttOf reads 0 as "no answer".
            if (cmd === 'curl' && args.some((a) => /generate_204/.test(a))) return new Promise((res) => setTimeout(() => res({ stdout: '' }), 5));
            if (cmd === 'curl' && args.some((a) => /ip-api\.com/.test(a))) return Promise.resolve({ stdout: JSON.stringify(egress[port]) });
            return new Promise(() => {}); // bringing an exit up for real: never answers here
        },
        fetchPinned: () => new Promise(() => {}), onChange: () => {}, ownIp: () => '20.169.100.246',
    });
    fs.mkdirSync(path.join(SANDBOX, 'work-sup'), { recursive: true });
    sup.init(uuids);
    const [leaky, moved, fine] = sup.slots;
    const ready = (s, cc, ip) => Object.assign(s, { state: 'ready', country: cc, provider: 'vpngate', seenCountry: cc, ip, busy: false, h: {}, server: `vpn-${cc.toLowerCase()}-1` });
    ready(leaky, 'JP', '59.138.6.218'); egress[leaky.port] = { status: 'success', countryCode: 'US', query: '20.169.100.246' };
    ready(moved, 'DE', '92.209.6.141'); egress[moved.port] = { status: 'success', countryCode: 'US', query: '99.92.86.247' };
    ready(fine, 'KR', '121.140.51.111'); egress[fine.port] = { status: 'success', countryCode: 'KR', query: '121.140.51.111' };
    await sup.supervise();
    t('an exit leaving from the runner\'s own address is brought up again at once — not after two misses',
        leaky.state === 'starting' && supLogs.some((m) => new RegExp(`exit ${leaky.id}: leaves from this runner's own address; bringing JP up again`).test(m)), JSON.stringify(supLogs));
    t('…so is one that now leaves from another country than it was built in',
        moved.state === 'starting' && supLogs.some((m) => new RegExp(`exit ${moved.id}: now leaves from US`).test(m)), JSON.stringify(supLogs));
    t('…and one leaving from where it should is left alone', fine.state === 'ready' && fine.misses === 0);
    t('a VPN Gate server caught leaking is not picked again this session', sup.avoidedFor('JP').includes('vpn-jp-1') && sup.avoidedFor('DE').includes('vpn-de-1') && !sup.avoidedFor('KR').length);
    await sup.stop(fine.id, { leak: true });
    t('…the same when the CLIENT saw the leak and says so on stop (leak=1)', sup.avoidedFor('KR').includes('vpn-kr-1') && fine.state === 'idle');
    const agentNow = fs.readFileSync(path.join(ROOT, 'github-tunnel', 'runner', 'gt-agent.mjs'), 'utf8');
    t('…and the status channel passes that on', /exitBroker\.stop\(url\.searchParams\.get\('id'\), \{ leak: url\.searchParams\.get\('leak'\) === '1' \}\)/.test(agentNow)
        && /ownIp: \(\) => \(result\.runner && result\.runner\.ip\) \|\| ''/.test(agentNow));

    // ════ 4. the client's exit plan ════
    const core = require(ROOT + '/github-tunnel/gt-core');
    const session = { id: 'GT-2026-A1B2C3D4', expiresAt: Date.now() + 3 * 3600e3 };
    const transport = { hosts: [{ host: 'prot-homeland-disabilities-ada.trycloudflare.com' }], wsPath: '/AbCdEf123456',
        uuids: { direct: crypto.randomUUID(), x1: crypto.randomUUID(), x2: crypto.randomUUID() } };
    const HOST = 'gt-relay-svc.example.workers.dev';
    const idOf = (o) => o.settings.vnext[0].users[0].id;
    const cfg = core.buildConfig({ session, transport, host: HOST, ips: ['104.25.0.134', '104.19.49.187'], frag: false, mux: 8,
        exitPlan: { use: 'x1', rules: [{ id: 'x2', domains: ['mexc.com', 'www.mexc.co', 'bad domain'] }, { id: 'x9', domains: ['a.com'] }] } });
    const mainOuts = cfg.outbounds.filter((o) => /^gt-/.test(o.tag));
    const ruleOuts = cfg.outbounds.filter((o) => /^gx-/.test(o.tag));
    t('the default exit is the user every main outbound carries', mainOuts.length === 2 && mainOuts.every((o) => idOf(o) === transport.uuids.x1));
    t('a site rule gets its own outbounds as ITS user, outside every main balancer', ruleOuts.length === 2 && ruleOuts.every((o) => idOf(o) === transport.uuids.x2)
        && cfg.routing.balancers[0].selector.every((s) => !'gx-r0-0'.startsWith(s)), JSON.stringify(cfg.routing.balancers));
    const domRule = cfg.routing.rules.find((x) => x.balancerTag === 'gx-r0');
    t('…and a domain rule AHEAD of the default one, with only valid names in it',
        domRule && JSON.stringify(domRule.domain) === JSON.stringify(['domain:mexc.com', 'domain:www.mexc.co'])
        && cfg.routing.rules.indexOf(domRule) < cfg.routing.rules.findIndex((x) => x.balancerTag === 'gt'), JSON.stringify(cfg.routing.rules));
    t('a rule naming a user the runner never offered is dropped', !cfg.routing.balancers.some((b) => b.tag === 'gx-r1') && cfg.routing.balancers.length === 2);
    t('the observatory watches the rule outbounds too', cfg.observatory.subjectSelector.includes('gx-'));
    const plain = core.buildConfig({ session, transport, host: HOST, ips: ['104.25.0.134'], frag: false, mux: 8 });
    t('no plan: the runner\'s own address (the direct user), nothing else', plain.outbounds.filter((o) => /^gt-/.test(o.tag)).every((o) => idOf(o) === transport.uuids.direct) && !plain.outbounds.some((o) => /^gx-/.test(o.tag)));
    t('a plan naming a missing exit falls back to direct', core.normalizePlan({ use: 'x5', rules: [] }, transport).use === 'direct');
    r = xrayTest(cfg);
    t('the real Xray accepts a client config with an exit and a site rule', r.status === 0 && /Configuration OK/.test(r.stdout || ''), (r.stdout || r.stderr || '').slice(-200));
    let v = null;
    try { core.validateTransport({ ...transport, uuids: { ...transport.uuids, admin: crypto.randomUUID() } }); } catch (e) { v = e; }
    t('a sealed transport naming any user but direct and x1…x6 is refused', !!v);

    const store = require(ROOT + '/github-tunnel/gt-config');
    const prefs = store.setExitPrefs({ country: 'jp', provider: 'nope', rules: [{ country: 'kr', domains: ['https://www.mexc.com/login', 'not a domain'] }] });
    t('the saved choice keeps only what can be acted on (codes, a known provider, plain domains, no www.)',
        prefs.country === 'JP' && prefs.provider === '' && prefs.rules.length === 1 && prefs.rules[0].country === 'KR' && JSON.stringify(prefs.rules[0].domains) === '["mexc.com"]', JSON.stringify(prefs));

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
