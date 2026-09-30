#!/usr/bin/env node
// --- scripts/cf-probe.js — the two probes that settled the IPv4/IPv6 question on the phone ---
//
// Port of the BatchProbe / VlessProbe used on 2026-09-28 (docs/ANDROID-1.2.36-TO-WINDOWS.fa.md ›
// ۱.۱۰). A TLS or WebSocket pass is NOT proof that a Cloudflare address carries data — only bytes
// coming back through the tunnel are. Both probes speak TLS with tls.connect({ host: ip,
// servername }) and never tls.connect({ socket }) (access violation on this machine class).
//
//   batch  — for each IP: TCP → TLS(SNI) → GET or WebSocket upgrade. Prints `ip stage ms detail`.
//            node scripts/cf-probe.js batch --sni x.workers.dev [--path /p] [--ws] [--port 443] ip1 ip2 …
//            (or --file ips.txt; `--v6 N` adds N random Cloudflare IPv6 edges)
//   vless  — WS upgrade → VLESS header (version 0, UUID, addon 0, command 1 TCP, port, addr type 2
//            domain) → data. `--mode http` sends a plain GET to example.com:80; `--mode tls` sends a
//            real ClientHello for www.google.com:443. Counts the bytes that come back.
//            node scripts/cf-probe.js vless --sni x.workers.dev --uuid <id> --path /p [--mode tls] ip…
//            or: node scripts/cf-probe.js vless --link "vless://…" ip…
//
// Client frames are MASKED (a server must drop unmasked client frames). Arguments are trimmed of
// `\r` — Windows scripts end lines with it, and a stray one at the end of the WS path made the edge
// answer 400 and looked like a filter.

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2).map((a) => a.replace(/\r/g, ''));
const mode = args.shift();
const opt = {};
const ips = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
        const k = a.slice(2);
        if (k === 'ws') opt.ws = true;
        else opt[k] = (args[++i] || '').replace(/\r/g, '');
    } else ips.push(a.replace(/^\[|\]$/g, ''));
}
if (opt.file) fs.readFileSync(opt.file, 'utf8').split(/[\s,]+/).map((s) => s.trim().replace(/^\[|\]$/g, '')).filter(Boolean).forEach((s) => ips.push(s));
if (opt.v6) ips.push(...require('../cf-family').sampleV6(Number(opt.v6)));
if (opt.link) {
    const p = require('../public/cf-uri').parse(opt.link);
    const m = opt.link.match(/^vless:\/\/([^@]+)@/i);
    if (p) { opt.sni = opt.sni || p.sni || p.host || p.address; opt.host = opt.host || p.host; opt.path = opt.path || p.path; opt.ws = opt.ws || p.net === 'ws'; }
    if (m) opt.uuid = opt.uuid || decodeURIComponent(m[1]);
    if (!ips.length && p) ips.push(p.address);
}
const port = Number(opt.port) || 443;
const sni = opt.sni;
const host = opt.host || sni;
const pth = (opt.path || '/').startsWith('/') ? (opt.path || '/') : '/' + opt.path;
const TIMEOUT = Number(opt.timeout) || 6000;

if (!['batch', 'vless'].includes(mode) || !sni || !ips.length) {
    console.log('usage: node scripts/cf-probe.js batch|vless --sni <name> [options] ip…  (see the header of this file)');
    process.exit(1);
}

function upgradeReq() {
    return `GET ${pth} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
}

/** TCP → TLS → first request; resolves { stage, ms, detail }. */
function batchOne(ip) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let stage = 'tcp';
        let buf = '';
        let done = false;
        const fin = (ok, detail) => { if (done) return; done = true; clearTimeout(t); try { s.destroy(); } catch (e) {} resolve({ ip, stage: ok ? 'ok' : stage, ms: Date.now() - t0, detail }); };
        const t = setTimeout(() => fin(false, 'timeout'), TIMEOUT);
        const s = tls.connect({ host: ip, port, servername: sni, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
        s.once('connect', () => { stage = 'tls'; });
        s.once('secureConnect', () => {
            stage = 'http';
            s.write(opt.ws ? upgradeReq() : `GET ${pth} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
        });
        s.on('data', (d) => { buf += d.toString('latin1'); const l = buf.split('\r\n')[0]; if (l.startsWith('HTTP/')) fin(true, l); });
        s.on('error', (e) => fin(false, e.code || e.message));
        s.on('close', () => fin(false, 'closed'));
    });
}

/** A masked binary WebSocket frame. */
function frame(payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x82, 0x80 | len])
        : len < 65536 ? Buffer.concat([Buffer.from([0x82, 0x80 | 126]), Buffer.from([len >> 8, len & 255])])
            : (() => { const b = Buffer.alloc(10); b[0] = 0x82; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([head, mask, body]);
}

function vlessHeader(uuid, dest, dport) {
    const id = Buffer.from(uuid.replace(/-/g, ''), 'hex');
    const d = Buffer.from(dest);
    return Buffer.concat([Buffer.from([0]), id, Buffer.from([0, 1, dport >> 8, dport & 255, 2, d.length]), d]);
}

/** A real TLS ClientHello for `name`, taken from Node itself (never sent to a live socket). */
function clientHello(name) {
    return new Promise((resolve) => {
        const { Duplex } = require('stream');
        let got = null;
        const fake = new Duplex({ read() {}, write(chunk, enc, cb) { if (!got) { got = Buffer.from(chunk); resolve(got); } cb(); } });
        const s = tls.connect({ socket: fake, servername: name, ALPNProtocols: ['http/1.1'] });
        s.on('error', () => {});
        setTimeout(() => { try { s.destroy(); } catch (e) {} if (!got) resolve(Buffer.alloc(0)); }, 1000);
    });
}

async function vlessOne(ip) {
    const vmode = opt.mode === 'tls' ? 'tls' : 'http';
    const inner = vmode === 'tls' ? await clientHello('www.google.com')
        : Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    const dest = vmode === 'tls' ? 'www.google.com' : 'example.com';
    const dport = vmode === 'tls' ? 443 : 80;
    return new Promise((resolve) => {
        const t0 = Date.now();
        let stage = 'tcp';
        let buf = Buffer.alloc(0);
        let upgraded = false;
        let bytes = 0;
        let done = false;
        const fin = (detail) => { if (done) return; done = true; clearTimeout(t); try { s.destroy(); } catch (e) {} resolve({ ip, stage: bytes > 2 ? 'data' : stage, ms: Date.now() - t0, detail: `${detail}; ${bytes} بایت برگشت` }); };
        const t = setTimeout(() => fin('timeout'), TIMEOUT + 4000);
        const s = tls.connect({ host: ip, port, servername: sni, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false });
        s.once('connect', () => { stage = 'tls'; });
        s.once('secureConnect', () => { stage = 'ws'; s.write(upgradeReq()); });
        s.on('data', (d) => {
            if (!upgraded) {
                buf = Buffer.concat([buf, d]);
                const end = buf.indexOf('\r\n\r\n');
                if (end < 0) return;
                const line = buf.subarray(0, end).toString('latin1').split('\r\n')[0];
                if (!/ 101 /.test(line)) return fin(line);
                upgraded = true;
                stage = 'vless';
                s.write(frame(Buffer.concat([vlessHeader(opt.uuid, dest, dport), inner])));
                bytes += buf.length - end - 4;
                return;
            }
            bytes += d.length;
            if (bytes > 64 * 1024) fin('enough');
        });
        s.on('error', (e) => fin(e.code || e.message));
        s.on('close', () => fin('closed'));
    });
}

(async () => {
    if (mode === 'vless' && !opt.uuid) { console.log('vless needs --uuid or --link'); process.exit(1); }
    const one = mode === 'batch' ? batchOne : vlessOne;
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(16, ips.length) }, async () => {
        while (i < ips.length) { const r = await one(ips[i++]); out.push(r); console.log(`${r.ip}\t${r.stage}\t${r.ms}\t${r.detail}`); }
    }));
    const ok = out.filter((r) => r.stage === (mode === 'batch' ? 'ok' : 'data')).length;
    console.log(`— ${ok} از ${out.length} ${mode === 'batch' ? 'جواب HTTP دادند' : 'داده برگرداندند'}`);
})();
