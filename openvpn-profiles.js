// --- openvpn-profiles.js — the user's OWN OpenVPN profiles, and TunnelBear, beside VPN Gate ---
//
// A user reported «we cannot add our own configs to OpenVPN» (2026-09-29): the Windows panel only
// ever dialled VPN Gate. This is Android 1.2.36's OpenVPN work (docs/ANDROID-1.2.36-TO-WINDOWS.fa.md
// › ۱۱), ported:
//
//  • IMPORT (ProfileImporter.kt, rule for rule). Several files at once: profiles (.ovpn / .ovpn.txt)
//    and their companions (CA, cert, key, tls-auth…) matched BY FILE NAME. Only an allow-list of
//    directives passes — never `script-security`, `up`, `plugin` or anything else that runs code;
//    file references are bare names; the CA must parse as X.509; a CA or `peer-fingerprint` is
//    required and `remote-cert-tls server` is added when neither pins the server; `auth-user-pass`
//    must carry no argument (credentials always come from an account here, never from a file);
//    `verb`/`mute`/`auth-nocache` are dropped and `verb 0` appended so the core's log never holds
//    the profile or a password. A profile's id is the SHA-256 of its final text, so a duplicate is
//    not added twice. Companions are kept, so a profile imported later still finds its CA.
//  • STORAGE. Profile text and account passwords are encrypted with Electron's safeStorage (DPAPI,
//    tied to this Windows user); outside Electron (tests) they are kept as base64, marked as such.
//  • TUNNELBEAR. The 47 profiles ship with the app (data/openvpn/tunnelbear) and are imported once.
//    Accounts are the user's own TunnelBear logins; the password lives apart from the list, under a
//    random reference that is replaced on every edit. No public API reports usage, so the last known
//    state is shown with its time.
//  • WHY TUNNELBEAR NEEDS A RELAY, measured on the phone 2026-09-27: its servers answer the OpenVPN
//    reset on UDP 443 and on TCP 7011, and then the TLS handshake inside the control channel is cut —
//    the filter reads the shape of the first records (a 2-byte length and an opcode at the start of
//    every segment, in a fixed rhythm). So the core dials a relay on loopback, and the relay dials
//    the server DIRECTLY on TCP 7011 and writes the first 6 KB in small pieces cut at random offsets
//    (the reset record whole, then 1 byte, then 3–29 bytes, 2–8 ms apart) so no segment starts on a
//    record boundary; past that it is a plain copy at full speed. Measured: connected in ~4 s,
//    11.5 Mbit/s.
//  • ONE NAME IS A POOL. Each country name resolves to one of ~20 servers per lookup, and whole
//    subnets were silent. The delay test resets up to 6 addresses at once (a fresh lookup plus the
//    last healthy ones) and keeps the ones that answered, fastest first; the relay tries them in that
//    order (4 s each) and moves a server that returned less than a certificate flight (2 KB) to the
//    back, so the core's own retry lands elsewhere.

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');

const HOME = path.join(os.homedir(), '.mlmvpn', 'openvpn');
const PROFILES_FILE = path.join(HOME, 'profiles.json');
const COMPANIONS_FILE = path.join(HOME, 'companions.json');
const ACCOUNTS_FILE = path.join(HOME, 'accounts.json');
const VAULT_FILE = path.join(HOME, 'vault.json');
const BUNDLED_TB = path.join(__dirname, 'data', 'openvpn', 'tunnelbear');

const MAX_BYTES = 1048576;
const TB_TCP_PORT = 7011;
const PROBE_TTL = 10 * 60 * 1000;

// ── the importer (Android ProfileImporter.kt) ───────────────────────────────────

const FILES = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs']);
const ALLOWED = new Set(['client', 'dev', 'dev-type', 'proto', 'remote', 'port', 'rport', 'nobind',
    'remote-cert-tls', 'verify-x509-name', 'peer-fingerprint', 'persist-key', 'persist-tun', 'reneg-sec',
    'dhcp-option', 'redirect-gateway', 'redirect-private', 'route', 'route-ipv6', 'route-metric', 'route-nopull',
    'route-delay', 'route-gateway', 'verb', 'mute', 'auth-user-pass', 'auth-nocache', 'data-ciphers', 'cipher',
    'data-ciphers-fallback', 'auth', 'tls-version-min', 'tls-version-max', 'tls-cipher', 'tls-ciphersuites',
    'tls-client', 'key-direction', 'resolv-retry', 'connect-retry', 'connect-retry-max', 'connect-timeout',
    'server-poll-timeout', 'remote-random', 'remote-random-hostname', 'explicit-exit-notify', 'tun-mtu',
    'mssfix', 'sndbuf', 'rcvbuf', 'ping', 'ping-restart', 'keepalive', 'pull', 'pull-filter',
    'topology', 'ifconfig', 'ifconfig-ipv6', 'auth-retry', 'comp-lzo', 'compress', 'allow-compression', ...FILES]);
const TRANSPORTS = new Set(['udp', 'udp4', 'udp6', 'tcp-client', 'tcp4-client', 'tcp6-client', 'tcp']);

class ImportError extends Error {
    constructor(fa, dependency) { super(fa); this.dependency = dependency || null; }
}

function tokenize(line) {
    const out = [];
    let word = '';
    let quote = null;
    let escaped = false;
    let started = false;
    for (const c of line) {
        if (escaped) { word += c; escaped = false; started = true; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (quote) { if (c === quote) quote = null; else word += c; continue; }
        if (c === '\'' || c === '"') { quote = c; started = true; continue; }
        if ((c === '#' || c === ';') && !word && !started) break;
        if (/\s/.test(c)) { if (word || started) { out.push(word); word = ''; started = false; } }
        else { word += c; started = true; }
    }
    if (quote || escaped) throw new ImportError('نقل‌قول یک خط کامل نیست');
    if (word || started) out.push(word);
    return out;
}

function quoteArg(s) {
    return (/[\s'"\\]/.test(s) || s.startsWith('#') || s.startsWith(';'))
        ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
}

function isX509(text) {
    try {
        const blocks = String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
        if (!blocks.length) return false;
        for (const b of blocks) new crypto.X509Certificate(b);
        return true;
    } catch (e) { return false; }
}

/**
 * Parse one profile. `companions` maps a bare file name to its text.
 * @returns {{id, name, config, remotes: Array<{host, port, protocol}>, authenticatedControl: boolean}}
 */
function parseProfile(name, text, companions = {}) {
    if (Buffer.byteLength(String(text)) > MAX_BYTES || String(text).includes('\u0000')) throw new ImportError('پروفایل خیلی بزرگ یا خراب است');
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim());
    const out = [];
    const directives = [];
    let block = null;
    let hasCa = false;
    let control = false;
    for (const line of lines) {
        if (block) {
            out.push(line);
            if (line === `</${block}>`) block = null;
            continue;
        }
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.startsWith('<')) {
            const tag = line.replace(/^</, '').replace(/>$/, '');
            if (!FILES.has(tag) || line !== `<${tag}>`) throw new ImportError('بخش درون‌خطی پشتیبانی‌نشده: ' + line.slice(0, 40));
            if (tag === 'ca') hasCa = true;
            if (tag.startsWith('tls-')) control = true;
            block = tag;
            out.push(line);
            continue;
        }
        const words = tokenize(line);
        if (!words.length) continue;
        const key = words[0].replace(/^--/, '');
        if (!ALLOWED.has(key)) throw new ImportError('دستور پشتیبانی‌نشده (برای امنیت): ' + key);
        const parts = [key, ...words.slice(1)];
        if (key === 'auth-user-pass' && parts.length !== 1) throw new ImportError('نام کاربری و رمز باید از «حساب‌ها» بیاید، نه از فایل');
        if (key === 'dev' && !String(parts[1] || '').startsWith('tun')) throw new ImportError('فقط پروفایل‌های TUN پشتیبانی می‌شوند');
        if (FILES.has(key)) {
            if (parts.length < 2 || parts.length > 3) throw new ImportError('ارجاع فایل نامعتبر: ' + key);
            const ref = parts[1];
            if (/[/\\:]/.test(ref) || ref === '..') throw new ImportError('فایل همراه را فقط با نام انتخاب کنید: ' + ref);
            const contents = companions[ref];
            if (contents == null) throw new ImportError('فایل همراه پیدا نشد: ' + ref, ref);
            if (Buffer.byteLength(contents) > MAX_BYTES || contents.includes('\u0000') || contents.includes(`</${key}>`)) throw new ImportError('فایل همراه نامعتبر است: ' + ref);
            if (key === 'ca') {
                if (!isX509(contents)) throw new ImportError('گواهی CA معتبر نیست: ' + ref);
                hasCa = true;
            }
            if (key.startsWith('tls-')) control = true;
            const canonical = contents.trim().split(/\r?\n/).map((l) => l.trim()).join('\n');
            out.push(`<${key}>\n${canonical}\n</${key}>`);
            if (parts.length === 3) {
                if (key !== 'tls-auth' || !['0', '1'].includes(parts[2])) throw new ImportError('جهت کلید نامعتبر است');
                out.push('key-direction ' + parts[2]);
            }
        } else {
            directives.push(parts);
            // The core's diagnostics must not keep profile contents or credentials.
            if (key !== 'verb' && key !== 'mute' && key !== 'auth-nocache') out.push(parts.map(quoteArg).join(' '));
        }
    }
    if (block) throw new ImportError('یک بخش درون‌خطی بسته نشده است');
    const has = (k) => directives.some((d) => d[0] === k);
    if (!hasCa && !has('peer-fingerprint')) throw new ImportError('CA یا peer-fingerprint لازم است');
    if (!directives.some((d) => d[0] === 'remote-cert-tls' && d[1] === 'server') && !has('peer-fingerprint')) out.push('remote-cert-tls server');
    const last = (keys) => { for (let i = directives.length - 1; i >= 0; i--) if (keys.includes(directives[i][0])) return directives[i]; return null; };
    const proto = (last(['proto']) || [])[1] || 'udp';
    const port = (last(['port', 'rport']) || [])[1] || '1194';
    const remotes = directives.filter((d) => d[0] === 'remote').map((d) => {
        const host = d[1];
        if (!host) throw new ImportError('نشانی سرور (remote) ندارد');
        const p = parseInt(d[2] || port, 10);
        const transport = d[3] || proto;
        if (!(p >= 1 && p <= 65535) || /\s/.test(host) || !TRANSPORTS.has(transport)) throw new ImportError('سرور (remote) نامعتبر: ' + d.slice(1).join(' '));
        return { host, port: p, protocol: transport };
    });
    if (!remotes.length) throw new ImportError('هیچ سروری (remote) ندارد');
    const config = out.join('\n') + '\nverb 0\n';
    if (Buffer.byteLength(config) > MAX_BYTES) throw new ImportError('پروفایل بعد از جاگذاری فایل‌ها خیلی بزرگ شد');
    const id = crypto.createHash('sha256').update(config).digest('hex');
    const clean = String(name || 'profile').replace(/\.txt$/i, '').replace(/\.ovpn$/i, '').slice(0, 120);
    return { id, name: clean, config, remotes, authenticatedControl: control };
}

// ── storage ─────────────────────────────────────────────────────────────────────

function safe() {
    // Only inside Electron: in plain Node `require('electron')` is the npm package, whose loader
    // tries to download a binary every time it is asked.
    if (!process.versions || !process.versions.electron) return null;
    try {
        const { safeStorage } = require('electron');
        if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) return safeStorage;
    } catch (e) { /* not inside Electron */ }
    return null;
}
function seal(text) {
    const s = safe();
    if (s) return { enc: 'dpapi', data: s.encryptString(String(text)).toString('base64') };
    return { enc: 'plain', data: Buffer.from(String(text), 'utf8').toString('base64') };
}
function open(box) {
    if (!box) return '';
    if (typeof box === 'string') return box;
    const buf = Buffer.from(box.data || '', 'base64');
    if (box.enc === 'dpapi') {
        const s = safe();
        if (!s) throw new Error('رمزگشایی فقط داخل خود برنامه ممکن است');
        return s.decryptString(buf);
    }
    return buf.toString('utf8');
}

function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }
function writeJson(file, v) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(v, null, 1));
    fs.renameSync(file + '.tmp', file);
}

function loadProfiles() { return readJson(PROFILES_FILE, []); }
function saveProfiles(list) { writeJson(PROFILES_FILE, list); }

const isTunnelBear = (p) => (p.remotes || []).some((r) => /\.lazerpenguin\.com$/i.test(r.host));

function place(p) {
    try {
        const geo = require('./geo-label');
        const bare = String(p.name).replace(/^tunnelbear\s*/i, '').trim();
        let c = geo.countryFromText([bare], 'fa');
        if (!c) {
            const host = (p.remotes[0] || {}).host || '';
            const cc = host.split('.')[0];
            if (cc.length === 2) c = geo.countryFromCode(cc.toUpperCase(), 'fa');
        }
        if (!c) return { code: null, name: bare || p.name };
        const b = bare.toLowerCase();
        const region = b.startsWith('united states') ? (b.endsWith('east') ? ' · شرق' : b.endsWith('west') ? ' · غرب' : b.endsWith('central') ? ' · مرکز' : '') : '';
        return { code: c.code, name: c.name + region };
    } catch (e) { return { code: null, name: p.name }; }
}

/** The list for the panel — never the profile text. */
function list() {
    seedTunnelBear();
    return loadProfiles().map((p) => ({
        id: p.id, name: p.name, source: p.source || 'user', favorite: !!p.favorite,
        remotes: p.remotes, tunnelbear: isTunnelBear(p), place: place(p), probe: p.probe || null,
        addedAt: p.addedAt || 0,
    }));
}

function get(id) { return loadProfiles().find((p) => p.id === id) || null; }

function addParsed(parsed, source) {
    const all = loadProfiles();
    if (all.some((p) => p.id === parsed.id)) return { duplicate: true, id: parsed.id };
    all.push({ id: parsed.id, name: parsed.name, config: seal(parsed.config), remotes: parsed.remotes,
        authenticatedControl: parsed.authenticatedControl, source, favorite: false, probe: null, addedAt: Date.now() });
    saveProfiles(all);
    return { added: true, id: parsed.id };
}

/**
 * Import several files at once: profiles and companions, by file name. Companions are remembered
 * for later imports. @param files [{ name, text }]
 * @returns {{ added: string[], duplicates: string[], errors: Array<{file, error}> }}
 */
function importFiles(files) {
    const comps = readJson(COMPANIONS_FILE, {});
    const profiles = [];
    for (const f of files || []) {
        const name = path.basename(String(f.name || ''));
        if (!name) continue;
        if (Buffer.byteLength(String(f.text || '')) > MAX_BYTES) continue;
        if (/\.ovpn(\.txt)?$/i.test(name)) profiles.push({ name, text: String(f.text || '') });
        else comps[name] = { text: seal(String(f.text || '')), at: Date.now() };
    }
    writeJson(COMPANIONS_FILE, comps);
    const plain = {};
    for (const [k, v] of Object.entries(comps)) { try { plain[k] = open(v.text); } catch (e) { /* unreadable */ } }
    const res = { added: [], duplicates: [], errors: [] };
    for (const p of profiles) {
        try {
            const parsed = parseProfile(p.name, p.text, plain);
            const r = addParsed(parsed, 'user');
            (r.duplicate ? res.duplicates : res.added).push(parsed.name);
        } catch (e) {
            res.errors.push({ file: p.name, error: e.message, missing: e.dependency || null });
        }
    }
    return res;
}

let seeded = false;
function seedTunnelBear() {
    if (seeded) return;
    seeded = true;
    const marker = path.join(HOME, 'tunnelbear-seeded');
    if (fs.existsSync(marker)) return;
    try {
        const ca = fs.readFileSync(path.join(BUNDLED_TB, 'openvpn-server-ca.crt'), 'utf8');
        for (const f of fs.readdirSync(BUNDLED_TB)) {
            if (!/\.ovpn$/i.test(f)) continue;
            try { addParsed(parseProfile(f, fs.readFileSync(path.join(BUNDLED_TB, f), 'utf8'), { 'openvpn-server-ca.crt': ca }), 'tunnelbear'); }
            catch (e) { console.warn('[OpenVPN] TunnelBear profile skipped:', f, e.message); }
        }
        fs.mkdirSync(HOME, { recursive: true });
        fs.writeFileSync(marker, String(Date.now()));
    } catch (e) { seeded = false; console.warn('[OpenVPN] TunnelBear profiles not found:', e.message); }
}

function setFavorite(id, value) {
    const all = loadProfiles();
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error('پروفایل پیدا نشد');
    p.favorite = !!value;
    saveProfiles(all);
    return { ok: true };
}

function remove(id, { connectedId } = {}) {
    if (connectedId && connectedId === id) throw new Error('پروفایلی که به آن وصل هستید حذف نمی‌شود — اول قطع کنید.');
    const all = loadProfiles();
    const next = all.filter((p) => p.id !== id);
    if (next.length === all.length) throw new Error('پروفایل پیدا نشد');
    saveProfiles(next);
    return { ok: true };
}

// ── accounts (the user's own TunnelBear logins) ─────────────────────────────────

function loadAccounts() { return readJson(ACCOUNTS_FILE, { list: [], activeId: null, autoSwitch: true }); }
function saveAccounts(a) { writeJson(ACCOUNTS_FILE, a); }
function vault() { return readJson(VAULT_FILE, {}); }

function validCred(username, password) {
    const u = String(username || '');
    const p = String(password || '');
    if (!u || u.length > 320 || /[\r\n\u0000]/.test(u)) throw new Error('نام کاربری نامعتبر است (حداکثر ۳۲۰ کاراکتر، بدون خط‌شکن)');
    if (!p || p.length > 4096 || /[\r\n\u0000]/.test(p)) throw new Error('رمز نامعتبر است (حداکثر ۴۰۹۶ کاراکتر، بدون خط‌شکن)');
}

function accounts() {
    const a = loadAccounts();
    return { list: a.list.map((x) => ({ id: x.id, username: x.username, auth: x.auth || 'unknown', lastError: x.lastError || null,
        lastConnected: x.lastConnected || null, checkedAt: x.checkedAt || null })), activeId: a.activeId, autoSwitch: a.autoSwitch !== false };
}

function saveAccount({ id, username, password }, { busyId } = {}) {
    validCred(username, password);
    const a = loadAccounts();
    const v = vault();
    if (id) {
        if (busyId && busyId === id) throw new Error('حسابی که با آن وصل هستید را نمی‌شود ویرایش کرد — اول قطع کنید.');
        const acc = a.list.find((x) => x.id === id);
        if (!acc) throw new Error('حساب پیدا نشد');
        delete v[acc.credRef];
        acc.credRef = crypto.randomBytes(12).toString('hex');
        acc.username = username;
        acc.auth = 'unknown';
        acc.lastError = null;
        v[acc.credRef] = seal(password);
    } else {
        const ref = crypto.randomBytes(12).toString('hex');
        const acc = { id: 'tb_' + crypto.randomBytes(6).toString('hex'), username, credRef: ref, auth: 'unknown', addedAt: Date.now() };
        v[ref] = seal(password);
        a.list.push(acc);
        if (!a.activeId) a.activeId = acc.id;
        id = acc.id;
    }
    writeJson(VAULT_FILE, v);
    saveAccounts(a);
    return { ok: true, id };
}

function deleteAccount(id, { busyId } = {}) {
    if (busyId && busyId === id) throw new Error('حسابی که با آن وصل هستید حذف نمی‌شود — اول قطع کنید.');
    const a = loadAccounts();
    const acc = a.list.find((x) => x.id === id);
    if (!acc) throw new Error('حساب پیدا نشد');
    const v = vault();
    delete v[acc.credRef];
    writeJson(VAULT_FILE, v);
    a.list = a.list.filter((x) => x.id !== id);
    if (a.activeId === id) a.activeId = a.list[0] ? a.list[0].id : null;
    saveAccounts(a);
    return { ok: true };
}

function setAccountPrefs({ activeId, autoSwitch }) {
    const a = loadAccounts();
    if (activeId !== undefined) {
        if (activeId && !a.list.some((x) => x.id === activeId)) throw new Error('حساب پیدا نشد');
        a.activeId = activeId || null;
    }
    if (autoSwitch !== undefined) a.autoSwitch = !!autoSwitch;
    saveAccounts(a);
    return accounts();
}

/** The account to dial with: the chosen one, or with auto-switch the first that has not failed. */
function pickAccount() {
    const a = loadAccounts();
    const usable = (x) => x && x.auth !== 'failed';
    let acc = a.list.find((x) => x.id === a.activeId);
    if (!usable(acc) && a.autoSwitch !== false) acc = a.list.find(usable) || acc;
    if (!acc) return null;
    return { id: acc.id, username: acc.username, password: open(vault()[acc.credRef]) };
}

function noteAccount(id, patch) {
    const a = loadAccounts();
    const acc = a.list.find((x) => x.id === id);
    if (!acc) return;
    Object.assign(acc, patch, { checkedAt: Date.now() });
    saveAccounts(a);
}

// ── delay (Android OpenVpnLatency.kt) ───────────────────────────────────────────

function resetPacket(session) { return Buffer.concat([Buffer.from([0x38]), session, Buffer.alloc(5)]); }
function acceptsReply(pkt, session) {
    if (pkt.length < 26 || pkt[0] !== 0x40) return false;
    const count = pkt[9];
    if (count < 1 || count > 32 || pkt.length < 10 + count * 4 + 12) return false;
    const off = 10 + count * 4;
    if (!pkt.subarray(off, off + 8).equals(session)) return false;
    for (let i = 0; i < count; i++) if (pkt.readUInt32BE(10 + i * 4) === 0) return true;
    return false;
}

/** One OpenVPN reset over TCP to ip:port; its round trip in ms, or null. */
function tcpReset(ip, port, timeoutMs = 3500) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const sock = net.connect({ host: ip, port });
        sock.setNoDelay(true);
        const session = crypto.randomBytes(8);
        let buf = Buffer.alloc(0);
        let done = false;
        const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch (e) {} resolve(v); };
        const t = setTimeout(() => fin(null), timeoutMs);
        sock.once('connect', () => {
            const p = resetPacket(session);
            sock.write(Buffer.concat([Buffer.from([0, p.length]), p]));
        });
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (buf.length < 2) return;
            const len = buf.readUInt16BE(0);
            if (len < 26 || len > 2048) return fin(null);
            if (buf.length < 2 + len) return;
            fin(acceptsReply(buf.subarray(2, 2 + len), session) ? Math.max(1, Date.now() - t0) : null);
        });
        sock.on('error', () => fin(null));
    });
}

function udpReset(ip, port, timeoutMs = 3500) {
    return new Promise((resolve) => {
        const s = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4');
        const session = crypto.randomBytes(8);
        const t0 = Date.now();
        let done = false;
        const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch (e) {} resolve(v); };
        const t = setTimeout(() => fin(null), timeoutMs);
        s.on('message', (m) => { if (acceptsReply(m, session)) fin(Math.max(1, Date.now() - t0)); });
        s.on('error', () => fin(null));
        s.send(resetPacket(session), port, ip, (e) => { if (e) fin(null); });
    });
}

function tcpConnect(ip, port, timeoutMs = 3500) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const sock = net.connect({ host: ip, port });
        let done = false;
        const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy(); } catch (e) {} resolve(v); };
        const t = setTimeout(() => fin(null), timeoutMs);
        sock.once('connect', () => fin(Math.max(1, Date.now() - t0)));
        sock.once('error', () => fin(null));
    });
}

function lookup4(host) {
    return new Promise((resolve) => dns.lookup(host, { all: true, family: 4 }, (e, list) => resolve(e ? [] : list.map((a) => a.address))));
}

async function measureOne(p) {
    const now = Date.now();
    if (isTunnelBear(p)) {
        const prev = (p.probe && p.probe.healthy) || [];
        const cands = [...new Set([...(await lookup4(p.remotes[0].host)), ...prev])].slice(0, 6);
        const timed = (await Promise.all(cands.map(async (ip) => [ip, await tcpReset(ip, TB_TCP_PORT)])))
            .filter((x) => x[1] != null).sort((a, b) => a[1] - b[1]);
        return timed.length
            ? { millis: timed[0][1], checkedAt: now, method: 'OPENVPN_TCP_RESET', healthy: timed.map((x) => x[0]) }
            : { millis: null, checkedAt: now, method: 'OPENVPN_TCP_RESET', error: 'NO_RESPONSE', healthy: [] };
    }
    const r = p.remotes[0];
    const tcp = r.protocol.startsWith('tcp');
    const method = tcp ? 'TCP_CONNECT' : 'OPENVPN_UDP_RESET';
    if (!tcp && p.authenticatedControl) return { millis: null, checkedAt: now, method, error: 'UNSUPPORTED_CONTROL_AUTH' };
    const ips = net.isIP(r.host) ? [r.host] : await lookup4(r.host);
    if (!ips.length) return { millis: null, checkedAt: now, method, error: 'NO_ADDRESS' };
    const ms = tcp ? await tcpConnect(ips[0], r.port) : await udpReset(ips[0], r.port);
    return ms ? { millis: ms, checkedAt: now, method, healthy: [ips[0]] } : { millis: null, checkedAt: now, method, error: 'NO_RESPONSE' };
}

/** Measure the given profiles (all when none), 8 at a time; results are saved on each profile. */
async function measure(ids, { onResult = () => {} } = {}) {
    seedTunnelBear();
    const all = loadProfiles();
    const targets = ids && ids.length ? all.filter((p) => ids.includes(p.id)) : all;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, async () => {
        while (i < targets.length) {
            const p = targets[i++];
            let probe;
            try { probe = await measureOne(p); } catch (e) { probe = { millis: null, checkedAt: Date.now(), method: 'ERROR', error: e.message }; }
            const fresh = loadProfiles();
            const row = fresh.find((x) => x.id === p.id);
            if (row) { row.probe = probe; saveProfiles(fresh); }
            onResult({ id: p.id, probe });
        }
    }));
    return list();
}

/** The fastest profile measured in the last 10 minutes — the auto-switch pick. */
function fastest() {
    const now = Date.now();
    return loadProfiles().filter((p) => p.probe && p.probe.millis && !p.probe.error && now - p.probe.checkedAt < PROBE_TTL)
        .sort((a, b) => a.probe.millis - b.probe.millis)[0] || null;
}

// ── the relay (Android OpenVpnSplitRelay.kt) ────────────────────────────────────

const SPLIT_BYTES = 6 * 1024;
const HANDSHAKE_BYTES = 2048;

class SplitRelay {
    constructor(hosts, port, log = () => {}) {
        if (!hosts.length) throw new Error('هیچ نشانی‌ای برای سرور نیست');
        this.hosts = hosts;
        this.port = port;
        this.next = 0;
        this.closed = false;
        this.open = new Set();
        this.log = log;
        this.server = net.createServer((c) => this.serve(c));
    }
    start() {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
        });
    }
    track(s) { this.open.add(s); s.once('close', () => this.open.delete(s)); }
    async connect() {
        const start = this.next;
        for (let i = 0; i < this.hosts.length && !this.closed; i++) {
            const at = (start + i) % this.hosts.length;
            const host = this.hosts[at];
            const s = await new Promise((resolve) => {
                const sock = net.connect({ host, port: this.port });
                sock.setNoDelay(true);
                const t = setTimeout(() => { sock.destroy(); resolve(null); }, this.hosts.length > 1 ? 4000 : 8000);
                sock.once('connect', () => { clearTimeout(t); resolve(sock); });
                sock.once('error', () => { clearTimeout(t); resolve(null); });
            });
            if (s) { this.next = at; return { host, s }; }
            this.log(`رله: ${host}:${this.port} وصل نشد`);
        }
        throw new Error('هیچ سروری وصل نشد');
    }
    skip(host) {
        if (this.hosts.length > 1 && this.hosts[this.next] === host) {
            this.next = (this.next + 1) % this.hosts.length;
            this.log(`رله: ${host} چیزی برنگرداند؛ اتصال بعدی به ${this.hosts[this.next]}`);
        }
    }
    async serve(client) {
        this.track(client);
        client.setNoDelay(true);
        client.pause();
        let up;
        try { up = await this.connect(); } catch (e) { client.destroy(); return; }
        const { host, s } = up;
        this.track(s);
        const t0 = Date.now();
        this.log(`رله به ${host}:${this.port} وصل شد`);
        let down = 0;
        s.on('data', (d) => { down += d.length; client.write(d); });
        const finish = () => {
            if (down < HANDSHAKE_BYTES) this.skip(host);
            try { client.destroy(); } catch (e) {}
            try { s.destroy(); } catch (e) {}
        };
        s.once('close', finish);
        s.once('error', finish);
        client.once('close', finish);
        client.once('error', finish);
        // Client → server: the reset record whole, then the first 6 KB in 1 then 3–29 byte pieces.
        let budget = SPLIT_BYTES;
        let resetLeft = -1;
        let first = true;
        const queue = [];
        let busy = false;
        const pump = async () => {
            if (busy) return;
            busy = true;
            while (queue.length && !this.closed) {
                const buf = queue.shift();
                let at = 0;
                if (resetLeft !== 0) {
                    if (resetLeft < 0) resetLeft = buf.length >= 2 ? 2 + buf.readUInt16BE(0) : 0;
                    const whole = Math.min(resetLeft, buf.length);
                    if (whole) s.write(buf.subarray(0, whole));
                    resetLeft -= whole;
                    at = whole;
                    if (resetLeft < 0) resetLeft = 0;
                }
                while (at < buf.length) {
                    if (budget <= 0) { s.write(buf.subarray(at)); break; }
                    const size = first ? 1 : 3 + crypto.randomInt(0, 27);
                    first = false;
                    const end = Math.min(buf.length, at + size);
                    s.write(buf.subarray(at, end));
                    budget -= end - at;
                    at = end;
                    if (at < buf.length && budget > 0) await new Promise((r) => setTimeout(r, 2 + crypto.randomInt(0, 6)));
                }
            }
            busy = false;
        };
        client.on('data', (d) => { queue.push(Buffer.from(d)); pump(); });
        client.resume();
        void t0;
    }
    close() {
        this.closed = true;
        try { this.server.close(); } catch (e) {}
        for (const s of this.open) { try { s.destroy(); } catch (e) {} }
        this.open.clear();
    }
}

// ── the text the core gets (Android ProfileRuntime.kt) ──────────────────────────

/**
 * What a stored profile becomes at connect time; the stored text never changes.
 *  - a `cipher` line from the first `data-ciphers` entry when there is none (the TunnelBear profiles
 *    name their cipher only there);
 *  - TunnelBear moves to TCP on the loopback relay, `explicit-exit-notify` goes (it means nothing on
 *    TCP), and every address the relay may dial gets a host route to the ORIGINAL gateway — the relay's
 *    own socket must not be captured by `redirect-gateway` (on Windows that is a route, not a socket
 *    flag, unlike Android's protect()).
 */
function effective(p, { relayPort = null, relayHosts = [] } = {}) {
    const text = open(p.config);
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const dir = (l) => l.trim().split(/\s+/)[0].toLowerCase();
    if (!lines.some((l) => dir(l) === 'cipher')) {
        const dc = lines.find((l) => dir(l) === 'data-ciphers');
        const first = dc ? dc.trim().split(/\s+/)[1].split(':')[0] : '';
        if (first) lines.push('cipher ' + first);
    }
    if (relayPort && isTunnelBear(p)) {
        for (let i = 0; i < lines.length; i++) {
            const d = dir(lines[i]);
            if (d === 'proto') lines[i] = 'proto tcp-client';
            else if (d === 'remote') lines[i] = `remote 127.0.0.1 ${relayPort} tcp-client`;
            else if (d === 'explicit-exit-notify') lines[i] = '';
        }
        for (const ip of relayHosts) if (net.isIPv4(ip)) lines.push(`route ${ip} 255.255.255.255 net_gateway`);
    }
    return lines.join('\n');
}

/**
 * Everything the engine needs to dial a stored profile: the text, the credentials, and for
 * TunnelBear a started relay (the caller closes it when the process exits).
 */
async function prepare(id, { log = () => {} } = {}) {
    seedTunnelBear();
    const p = get(id);
    if (!p) throw new Error('پروفایل پیدا نشد');
    const needsAuth = /^\s*auth-user-pass\s*$/m.test(open(p.config));
    let account = null;
    if (needsAuth || isTunnelBear(p)) {
        account = pickAccount();
        if (!account) throw new Error(isTunnelBear(p)
            ? 'برای سرورهای TunnelBear اول یک حساب TunnelBear در بخش «حساب‌ها» اضافه کنید.'
            : 'این پروفایل نام کاربری و رمز می‌خواهد — در بخش «حساب‌ها» یک حساب اضافه کنید.');
    }
    let relay = null;
    let text;
    if (isTunnelBear(p)) {
        let hosts = (p.probe && p.probe.healthy && Date.now() - p.probe.checkedAt < PROBE_TTL) ? p.probe.healthy : [];
        if (!hosts.length) {
            log('سنجش سریع سرورهای این کشور (TCP 7011)…');
            const probe = await measureOne(p);
            const all = loadProfiles(); const row = all.find((x) => x.id === p.id); if (row) { row.probe = probe; saveProfiles(all); }
            hosts = probe.healthy || [];
        }
        if (!hosts.length) hosts = await lookup4(p.remotes[0].host);
        if (!hosts.length) throw new Error('نشانی سرورهای این کشور پیدا نشد (DNS).');
        relay = new SplitRelay(hosts, TB_TCP_PORT, log);
        const port = await relay.start();
        log(`رلهٔ محلی روی 127.0.0.1:${port} → ${hosts.length} سرور، TCP ${TB_TCP_PORT}`);
        text = effective(p, { relayPort: port, relayHosts: hosts });
    } else {
        text = effective(p);
    }
    return {
        id: p.id, name: p.name, place: place(p), profile: text, relay, account,
        // null: the profile authenticates by certificate alone and gets no --auth-user-pass.
        creds: account ? `${account.username}\n${account.password}\n` : null,
        host: 'profile:' + p.id,
    };
}

module.exports = {
    parseProfile, importFiles, list, get, setFavorite, remove, measure, fastest, prepare, effective,
    accounts, saveAccount, deleteAccount, setAccountPrefs, pickAccount, noteAccount, isTunnelBear,
    tcpReset, acceptsReply, resetPacket, SplitRelay, ImportError, seedTunnelBear, HOME,
};
