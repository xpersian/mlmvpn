// GitHub Tunnel v2's client engine (gt-core.js): the configuration it hands Xray, the checks on
// what the runner sends back, and the private core copy. Nothing here connects anywhere; the
// generated config is validated by the real Xray when one is installed.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');

const SANDBOX = path.join(__dirname, 'home-gtcore');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
process.env.MLMVPN_GT_CORE_DIR = path.join(SANDBOX, 'core');
assert.strictEqual(os.homedir(), SANDBOX);

const core = require(ROOT + '/github-tunnel/gt-core');
const secret = require(ROOT + '/github-tunnel/gt-secret');
const corePaths = require(ROOT + '/core-paths');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

(async () => {
    const session = { id: 'GT-2026-A1B2C3D4', expiresAt: Date.now() + 3 * 3600e3 };
    const transport = {
        hosts: [{ host: 'prot-homeland-disabilities-ada.trycloudflare.com' }, { host: 'abc-def-ghi.trycloudflare.com' }],
        wsPath: '/AbCdEf123456', uuids: { direct: crypto.randomUUID() },
    };
    const HOST = 'gt-relay-svc.example.workers.dev';
    const cfg = core.buildConfig({ session, transport, host: HOST, ips: ['104.25.0.134', '104.19.49.187'], frag: false, mux: 8 });
    const gts = cfg.outbounds.filter((o) => /^gt-\d+$/.test(o.tag));
    const all = JSON.stringify(cfg);

    // ── the shape of every tunnel outbound ──────────────────────────────────────
    t('one outbound per tunnel host × clean IP', gts.length === 4, String(gts.length));
    t('SNI and Host are the user\'s Worker, never trycloudflare (blocked from Iran)',
        gts.every((o) => o.streamSettings.tlsSettings.serverName === HOST && o.streamSettings.wsSettings.host === HOST));
    t('ALPN is http/1.1 only — offered h2, Cloudflare picks it and a WebSocket cannot ride it',
        gts.every((o) => JSON.stringify(o.streamSettings.tlsSettings.alpn) === '["http/1.1"]'));
    t('allowInsecure appears nowhere (fatal in Xray ≥ 26.7.28)', !/allowInsecure/.test(all));
    t('TCP is multiplexed (quick tunnels cap in-flight requests), UDP rides XUDP, QUIC is refused',
        gts.every((o) => o.mux.enabled && o.mux.concurrency === 8 && o.mux.xudpConcurrency === 16 && o.mux.xudpProxyUDP443 === 'reject'));
    t('the fragment profile is off unless asked for', gts.every((o) => !o.streamSettings.finalmask && !o.streamSettings.tlsSettings.cipherSuites));

    // ── the pass in the path ────────────────────────────────────────────────────
    const m = gts[0].streamSettings.wsSettings.path.match(/^\/p\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})(\/AbCdEf123456)\?ed=2560$/);
    t('the path is /p/<pass>/<the runner\'s secret path>?ed=2560', !!m, gts[0].streamSettings.wsSettings.path.slice(0, 80));
    const claims = m ? JSON.parse(Buffer.from(m[1], 'base64url').toString()) : {};
    t('each host\'s pass names that host\'s own tunnel', claims.h === 'prot-homeland-disabilities-ada'
        && JSON.parse(Buffer.from(gts[2].streamSettings.wsSettings.path.match(/^\/p\/([A-Za-z0-9_-]+)\./)[1], 'base64url').toString()).h === 'abc-def-ghi');
    t('…and dies with the session', claims.s === session.id && claims.e === session.expiresAt);
    t('…signed with this installation\'s secret', m && crypto.createHmac('sha256', secret.getInstallSecret()).update(m[1]).digest('base64url') === m[2]);

    // ── the rest of the config ──────────────────────────────────────────────────
    const inb = Object.fromEntries(cfg.inbounds.map((i) => [i.tag, i]));
    t('SOCKS 20812 with UDP, HTTP 20813, stats API 20814 on loopback',
        inb.socks.port === 20812 && inb.socks.settings.udp === true && inb.http.port === 20813 && inb.api.port === 20814 && inb.api.listen === '127.0.0.1');
    t('no access log — every site the user visits would otherwise be written down', cfg.log.access === 'none');
    t('the user\'s own network never leaves through the runner',
        cfg.routing.rules.some((r) => r.outboundTag === 'block' && r.ip.includes('192.168.0.0/16') && r.ip.includes('10.0.0.0/8')));
    t('everything else goes to one balancer over every tunnel outbound, with a fallback',
        cfg.routing.balancers[0].selector[0] === 'gt-' && cfg.routing.balancers[0].fallbackTag === 'gt-0'
        && cfg.routing.rules.some((r) => r.balancerTag === 'gt' && r.network === 'tcp,udp'));
    t('the balancer\'s probe avoids Cloudflare hosts a worker can fake', !/cloudflare/.test(cfg.observatory.probeUrl));

    const fragCfg = core.buildConfig({ session, transport, host: HOST, ips: ['104.25.0.134'], frag: true, mux: 8 });
    const fo = fragCfg.outbounds[0];
    t('fragment on applies finalmask, the cipher list and the fingerprint together',
        // cipherSuites is Xray's colon-separated string, exactly as tls-fingerprint.js exports it.
        !!fo.streamSettings.finalmask && /^TLS_[A-Z0-9_]+(:TLS_[A-Z0-9_]+)+$/.test(fo.streamSettings.tlsSettings.cipherSuites || '')
        && fo.streamSettings.tlsSettings.fingerprint === 'unsafe');

    // ── what the runner sends back is checked before it is used ─────────────────
    t('a valid transport passes', core.validateTransport(transport) === true);
    const bad = (patch) => throws(() => core.validateTransport({ ...transport, ...patch }));
    t('a host outside *.trycloudflare.com is refused', bad({ hosts: [{ host: 'evil.com' }] }) && bad({ hosts: [{ host: 'x.trycloudflare.com.evil.com' }] }));
    t('a host with path or port tricks is refused', bad({ hosts: [{ host: 'abc.trycloudflare.com/../x' }] }) && bad({ hosts: [{ host: 'abc.trycloudflare.com:8443' }] }));
    t('no hosts at all is refused', bad({ hosts: [] }));
    t('a path that could escape the URL is refused', bad({ wsPath: '/../admin' }) && bad({ wsPath: '/a?x=1' }) && bad({ wsPath: 'no-slash-xxxx' }));
    t('a malformed id is refused', bad({ uuids: { direct: 'not-a-uuid' } }) && bad({ uuids: {} }));

    // ── modes ───────────────────────────────────────────────────────────────────
    let modeErr = null;
    try { await core.connect({ session: { ...session, dataPlane: 'v2', v2: {} }, mode: 'warp-in-a-box' }); } catch (e) { modeErr = e; }
    t('an unknown mode is refused with its own code, before anything starts',
        modeErr && modeErr.code === 'MODE_UNSUPPORTED' && core.getStatus().running === false);
    // 'tun' is a real mode now (P2): refused only for what is wrong with the SESSION, not the mode.
    let tunErr = null;
    try { await core.connect({ session: { ...session, dataPlane: 'v2', v2: {} }, mode: 'tun' }); } catch (e) { tunErr = e; }
    t('the full-tunnel mode is accepted (the session is what is refused here)',
        tunErr && tunErr.code !== 'MODE_UNSUPPORTED' && core.getStatus().running === false, tunErr && tunErr.message);
    // The repair loop's hooks exist, and an outside disconnect is what ends a repair.
    t('the watchdog has a liveness hook for the shared adapter and a give-up handler',
        typeof core.setLivenessCheck === 'function' && typeof core.setGaveUpHandler === 'function' && typeof core.pokeWatchdog === 'function');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'github-tunnel', 'gt-core.js'), 'utf8');
    t('a repair keeps its count across the reconnect it starts (connect no longer zeroes it)',
        /if \(!repairing\) repairs = 0;/.test(coreSrc) && /repairing = true;[\s\S]*?await \(onRebuild/.test(coreSrc));
    t('a repair stops when somebody else disconnected or connected meanwhile',
        /if \(generation !== seen \|\| intent !== mode\) return;/.test(coreSrc)
        && /async function disconnect\(onLog\) \{\s*intent = null;\s*generation\+\+;/.test(coreSrc));
    t('a dead adapter is acted on at once, not after a second bad look',
        /if \(!v\.immediate && badVerdicts < BAD_VERDICTS_BEFORE_DEGRADE\) return;/.test(coreSrc));
    // WHICH SIDE FAILED: what the Worker answered decides the finding (and its button).
    const why = (status) => core.noPathError({ tried: 12, refused: status ? { status, frag: false, ips: ['104.19.1.1'] } : null }).code;
    t('nothing reached the Worker → a line problem: find a clean IP', why(null) === 'NO_CLEAN_IP');
    t('the Worker reached, the tunnel behind it failing (500/502/530) → the cloud session, not the line',
        why(500) === 'TUNNEL_UNREACHABLE' && why(502) === 'TUNNEL_UNREACHABLE' && why(530) === 'TUNNEL_UNREACHABLE');
    t('…a pass the Worker does not know (404) or a Worker without its secret (503) → redeploy the Worker',
        why(404) === 'BROKER_NEEDS_UPDATE' && why(503) === 'BROKER_NEEDS_UPDATE');
    t('…an expired pass (401) → the session ended; the daily cap (429) is named as such',
        why(401) === 'SESSION_ENDED' && why(429) === 'BROKER_LIMIT' && why(418) === 'BROKER_REFUSED');
    const connectSrc = (coreSrc.match(/async function connect\([\s\S]*?\n\}\n/) || [''])[0];
    const warmSrc = (coreSrc.match(/async function pickWarm[\s\S]*?\n\}\n/) || [''])[0];
    t('a tunnel still warming up is waited out on the addresses that REACHED the Worker, a bounded number of times',
        /for \(let i = 0; !picked\.ips\.length && farSideWarming\(picked\.refused\) && i < tries; i\+\+\)/.test(warmSrc)
        && /ips: r\.ips, buildOutbound: make, frag: r\.frag, diag/.test(warmSrc)
        && /pickWarm\(\{ exe: core\.exe, make: p\.make, tries: p\.via === 'slot' \? 2 : WARMUP_TRIES/.test(connectSrc)
        && /throw err;/.test(connectSrc) && /const err = noPathError\(picked\);/.test(connectSrc));
    t('the stable slot is measured first; the quick tunnels only when the Worker answered for the slot (not for a line that reaches nothing)',
        /if \(picked\.ips\.length\) \{ via = p\.via; break; \}\s*if \(!picked\.refused\) break;/.test(connectSrc)
        && /const useSlot = via === 'slot';/.test(connectSrc));

    // ── THE STABLE TUNNEL (gt-slots.js) on the client ──
    const slotSession = { ...session, v2: { slot: 'a' } };
    const slotTransport = { ...transport, slot: { name: 'a', ready: true } };
    const sc = core.buildConfig({ session: slotSession, transport: slotTransport, host: HOST, ips: ['104.25.0.134', '104.19.49.187'], frag: false, mux: 8 });
    const sgts = sc.outbounds.filter((o) => /^gt-s?\d+$/.test(o.tag));
    const passOf = (o) => JSON.parse(Buffer.from(o.streamSettings.wsSettings.path.split('/')[2].split('.')[0], 'base64url').toString());
    const slotOuts = sc.outbounds.filter((o) => /^gt-s\d+$/.test(o.tag));
    t('a ready slot gets its own outbounds, gt-s0/gt-s1, each with a pass for slot a',
        sgts.length === 6 && slotOuts.length === 2 && slotOuts.every((o) => passOf(o).k === 'a' && !passOf(o).h)
        && sc.outbounds.filter((o) => /^gt-\d+$/.test(o.tag)).every((o) => passOf(o).h), JSON.stringify(sgts.map((o) => [o.tag, passOf(o)])));
    const bal = sc.routing.balancers[0];
    t('…the balancer takes ONLY the stable path, and falls back to a quick tunnel when the observatory finds it dead',
        JSON.stringify(bal.selector) === '["gt-s"]' && bal.fallbackTag === 'gt-0' && sc.observatory.subjectSelector.includes('gt-'), JSON.stringify(bal));
    t('…with TCP un-multiplexed on it (a cancelled download must not stall the others), UDP still over XUDP',
        slotOuts.every((o) => o.mux.concurrency === -1 && o.mux.xudpConcurrency === 16)
        && sc.outbounds.filter((o) => /^gt-\d+$/.test(o.tag)).every((o) => o.mux.concurrency === 8));
    t('…and it is still the Worker that is dialled (SNI, Host), never a tunnel name',
        slotOuts.every((o) => o.streamSettings.tlsSettings.serverName === HOST && o.streamSettings.wsSettings.host === HOST));
    const onlySlot = core.buildConfig({ session: slotSession, transport: { ...slotTransport, hosts: [] }, host: HOST, ips: ['104.25.0.134'], frag: false, mux: 8 });
    t('no quick tunnel left: the stable path is its own fallback', onlySlot.routing.balancers[0].fallbackTag === 'gt-s0');
    const noUse = core.buildConfig({ session: slotSession, transport: slotTransport, host: HOST, ips: ['104.25.0.134'], frag: false, mux: 8, useSlot: false });
    t('a slot that failed its measurement is left out of the connection', noUse.outbounds.filter((o) => /^gt-\d+$/.test(o.tag)).every((o) => passOf(o).h));
    const notReady = core.buildConfig({ session: slotSession, transport: { ...transport, slot: { name: 'a', ready: false } }, host: HOST, ips: ['104.25.0.134'], frag: false, mux: 8 });
    const otherSlot = core.buildConfig({ session: slotSession, transport: { ...transport, slot: { name: 'b', ready: true } }, host: HOST, ips: ['104.25.0.134'], frag: false, mux: 8 });
    t('…as is a slot whose connector is not up, or one the session was not dispatched with',
        [notReady, otherSlot].every((c) => c.outbounds.filter((o) => /^gt-\d+$/.test(o.tag)).every((o) => passOf(o).h)));
    t('no quick tunnel at all is accepted only when the slot answers',
        !throws(() => core.validateTransport({ ...transport, hosts: [], slot: { name: 'a', ready: true } }))
        && throws(() => core.validateTransport({ ...transport, hosts: [], slot: { name: 'a', ready: false } }))
        && throws(() => core.validateTransport({ ...transport, hosts: [] })));
    t('a slot named anything but a or b is refused', throws(() => core.validateTransport({ ...transport, slot: { name: 'evil.com', ready: true } }))
        && throws(() => core.validateTransport({ ...transport, slot: { name: 'a', ready: 'yes' } })));

    // MAKE-BEFORE-BREAK: the next session is proven BEFORE the running core is touched.
    const swapSrc = (coreSrc.match(/async function swapSession[\s\S]*?\n\}\n/) || [''])[0];
    const proveSrc = (coreSrc.match(/async function proveSession[\s\S]*?\n\}\n/) || [''])[0];
    t('the hot swap proves the next session on the addresses in use before it stops anything',
        /cleanip\.measure\(\{ exe: core\.exe, ips: state\.ips, buildOutbound: p\.make, frag: state\.frag, diag \}\)/.test(proveSrc)
        && /const paths = pathsOf\(session, transport, host\);/.test(proveSrc)
        && swapSrc.indexOf('await proveSession(session, { onLog, tries: 1 })') > 0
        && swapSrc.indexOf('await proveSession(') < swapSrc.indexOf('await killChild(old)')
        && /if \(!proof\.ok\) return \{ ok: false, stopped: false/.test(swapSrc));
    t('…a proof that meets a warming tunnel waits it out; any other answer ends it at once',
        /if \(!farSideWarming\(refused\)\) break;/.test(proveSrc) && /await sleep\(spacingMs\);/.test(proveSrc));
    t('…restarts only the core, on the same ports and fragment choice, then watches the NEW session',
        /buildConfig\(\{ session, transport, host, ips, frag: state\.frag/.test(swapSrc)
        && /startWatchdog\(\);\s*startStatusWatch\(session\);\s*return \{ ok: true/.test(swapSrc));
    t('…and a repair still waiting out its backoff belongs to the old session', /generation\+\+;[^\n]*\n\s*stopWatchdog\(\);\s*stopStatusWatch\(\);/.test(swapSrc));
    t('…refused while nothing is connected or a repair is running',
        /if \(repairing\) return \{ ok: false, stopped: false/.test(swapSrc)
        && /if \(!child \|\| !state\.connected \|\| repairing\) return \{ ok: false, stopped: false/.test(swapSrc)
        && /if \(!child \|\| !state\.connected \|\| !state\.ips\.length\) return \{ ok: false, reason: 'not-connected' \}/.test(proveSrc));
    t('a restarted core is probed as soon as its port listens (not after a failed probe and 1.5 s)',
        (coreSrc.match(/await cleanip\.waitPort\(SOCKS_PORT, 5000\);\s*const (verdict|v) = await verifyTunnel/g) || []).length === 3);
    t('status says which data plane it is and that nothing runs', core.getStatus().dataPlane === 'v2' && core.getStatus().connected === false);

    // ── the private core copy ───────────────────────────────────────────────────
    const src = corePaths.file('xray', 'xray.exe', corePaths.bundled('core', 'xray.exe'));
    if (fs.existsSync(src)) {
        const c1 = await core.ensureCore();
        const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        t('the core is a byte-identical copy named gtcore.exe', path.basename(c1.exe) === 'gtcore.exe' && hash(c1.exe) === hash(src));
        fs.appendFileSync(c1.exe, Buffer.from('tampered'));
        const c2 = await core.ensureCore();
        t('a copy that no longer matches is replaced before launch', hash(c2.exe) === hash(src));

        // The real Xray, on the real config.
        let ok = false; let out = '';
        try {
            out = execFileSync(c2.exe, ['run', '-test', '-c', 'stdin:'], { input: JSON.stringify(cfg), encoding: 'utf8', windowsHide: true });
            ok = /Configuration OK/.test(out);
            out = execFileSync(c2.exe, ['run', '-test', '-c', 'stdin:'], { input: JSON.stringify(fragCfg), encoding: 'utf8', windowsHide: true });
            ok = ok && /Configuration OK/.test(out);
        } catch (e) { out = String(e.stdout || e.message); }
        t('Xray itself accepts both configs (fragment off and on)', ok, out.slice(-200));
    } else {
        t('(no Xray on this machine — core copy and live config checks skipped)', true);
    }

    fs.rmSync(SANDBOX, { recursive: true, force: true });
    module.exports = results;
    if (require.main === module) {
        results.forEach((x) => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter((x) => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})().catch((e) => { console.error(e); process.exit(1); });
