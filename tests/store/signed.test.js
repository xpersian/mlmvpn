// Installing a publisher's SIGNED file — store/net.js › downloadSigned, store/authenticode.js,
// store/sfx.js.
//
// SoftEther publishes its Windows client only as its own installer, and GitHub has no digest for
// it. So «گیت‌وی MLM»'s engine is anchored on SoftEther Corporation's Authenticode signature
// instead, and its files are read out of the installer's PE resources without running it.
//
// The download cases run against a loopback HTTP server with the signature check stubbed, so they
// are exact about ORDER: nothing may be kept before the check says yes. The Windows cases use real
// files: the installer SoftEther's own setup leaves in its folder (installer.cache) when this
// machine has one, and a file nobody signed. Nothing reaches the internet.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-signed-'));
process.env.MLMVPN_STORE_ROOT = path.join(sandbox, 'store');

const net = require('../../store/net');
const sfx = require('../../store/sfx');
const authenticode = require('../../store/authenticode');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const BODY = crypto.randomBytes(300 * 1024);
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BODY.length });
    res.end(BODY);
});

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port + '/softether-vpnclient.exe';
    const dest = path.join(sandbox, 'dl', 'signed-installer.exe');

    // ── the anchor is required ──────────────────────────────────────────────
    let err = null;
    try { await net.downloadSigned({ urls: [url], signedBy: '', dest }); } catch (e) { err = e; }
    t('no signer named, no download', !!err && !fs.existsSync(dest), err && err.message);

    // ── a file the publisher signed ─────────────────────────────────────────
    const checked = [];
    const yes = async (f, who) => { checked.push({ f, who, existsAtDest: fs.existsSync(dest) }); return { status: 'Valid', subject: 'CN=SOFTETHER CORPORATION, O=SOFTETHER CORPORATION, C=JP' }; };
    const got = await net.downloadSigned({ urls: [url], signedBy: 'SOFTETHER CORPORATION', dest, verify: yes });
    t('a signed file is kept', fs.existsSync(dest) && got.file === dest && got.bytes === BODY.length);
    t('…the check ran on the download BEFORE it was kept', checked.length === 1 && /\.part$/.test(checked[0].f) && checked[0].existsAtDest === false,
        JSON.stringify(checked));
    t('…against the signer the catalogue named', checked[0] && checked[0].who === 'SOFTETHER CORPORATION');
    t('…and the digest is measured for the record', got.sha256 === sha(BODY));
    t('…no partial file left behind', !fs.existsSync(dest + '.part'));

    // ── the cache is checked again, never trusted ───────────────────────────
    checked.length = 0;
    const again = await net.downloadSigned({ urls: [url], signedBy: 'SOFTETHER CORPORATION', dest, verify: yes });
    t('a copy already on disk is re-verified', checked.length === 1 && checked[0].f === dest && again.route === 'حافظهٔ محلی');

    // ── a file that is not the publisher's ──────────────────────────────────
    const no = async () => { throw new Error('فایل دانلودشده امضای معتبر دارد ولی متعلق به «SOFTETHER CORPORATION» نیست.'); };
    err = null;
    try { await net.downloadSigned({ urls: [url], signedBy: 'SOFTETHER CORPORATION', dest, verify: no }); } catch (e) { err = e; }
    t('a cached copy that no longer verifies is not returned', !!err);
    t('…the refusal is a signature failure, not a network one', !!err && err.code === 'bad-signature', err && err.code);
    t('…and nothing is kept: not the file, not the part', !fs.existsSync(dest) && !fs.existsSync(dest + '.part'));

    // ── SoftEther's CompressBuf, undone ─────────────────────────────────────
    const plain = Buffer.from('vpnclient '.repeat(500));
    const len = Buffer.alloc(4); len.writeUInt32BE(plain.length);
    t('a 4-byte big-endian length + zlib stream comes back as the original', sfx.uncompress('X.EXE', Buffer.concat([len, zlib.deflateSync(plain)])).equals(plain));
    len.writeUInt32BE(plain.length + 1);
    err = null;
    try { sfx.uncompress('X.EXE', Buffer.concat([len, zlib.deflateSync(plain)])); } catch (e) { err = e; }
    t('…and a length that does not match is refused', !!err);
    const notPe = path.join(sandbox, 'not-pe.exe');
    fs.writeFileSync(notPe, 'MZ but nothing after it');
    err = null;
    try { sfx.extract(notPe, path.join(sandbox, 'x0')); } catch (e) { err = e; }
    t('a file that is not a PE image is refused, not half-extracted', !!err);

    // ── the real thing, when this machine has it ────────────────────────────
    const cache = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'SoftEther VPN Client', 'installer.cache');
    if (fs.existsSync(cache)) {
        const out = path.join(sandbox, 'x1');
        const names = sfx.extract(cache, out);
        t('SoftEther\'s real installer unpacks without running', ['vpnclient_x64.exe', 'vpncmd.exe', 'hamcore.se2'].every((n) => names.includes(n)), names.join(','));
        const { SHIPPED } = require('../../store/shipped');
        const same = ['vpnclient_x64.exe', 'vpncmd_x64.exe', 'vpnclient.exe', 'vpncmd.exe', 'hamcore.se2']
            .filter((f) => sha(fs.readFileSync(path.join(out, f))) === SHIPPED.softether.files[f]);
        t('…and for the version this build ships, the files are byte-for-byte the shipped ones', same.length === 5, same.join(','));
        t('…every name a bare file name inside the scratch folder', names.every((n) => !/[\\/]/.test(n)));
        const sig = await authenticode.verify(cache, 'SOFTETHER CORPORATION');
        t('the installer\'s signature is Valid and SoftEther Corporation\'s', sig.status === 'Valid' && /SOFTETHER CORPORATION/i.test(sig.subject), sig.subject);
        const inner = await authenticode.verify(path.join(out, 'vpnclient_x64.exe'), 'SOFTETHER CORPORATION');
        t('…and so is the service binary that comes out of it', inner.status === 'Valid', inner.subject);
        err = null;
        try { await authenticode.verify(cache, 'SOMEBODY ELSE LTD'); } catch (e) { err = e; }
        t('a valid signature from the WRONG publisher is refused', !!err);
    } else {
        t('(no SoftEther installer cache on this machine — the real-file cases were skipped)', true);
    }
    err = null;
    try { await authenticode.verify(notPe, 'SOFTETHER CORPORATION'); } catch (e) { err = e; }
    t('an unsigned file is refused', !!err, err && err.message);

    server.close();
    let bad = 0;
    for (const r of results) {
        if (r.pass) console.log('PASS  ' + r.name);
        else { bad++; console.log('FAIL  ' + r.name + (r.detail ? ' — ' + r.detail : '')); }
    }
    console.log('\n' + (results.length - bad) + '/' + results.length + ' passed');
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL  suite threw — ' + e.stack); process.exit(1); });
