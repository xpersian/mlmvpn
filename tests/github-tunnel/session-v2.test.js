// The sealed session hand-off: runner/seal.mjs seals, gt-session-crypto.js opens.
// They are two files in two module systems (the runner has nothing but Node), so this suite
// is what stops them drifting apart — and what proves a sealed file is useless to anyone else.
const ROOT = require('path').resolve(__dirname, '..', '..');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const client = require(ROOT + '/github-tunnel/gt-session-crypto');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

(async () => {
    const runner = await import(pathToFileURL(ROOT + '/github-tunnel/runner/seal.mjs').href);

    t('client and runner agree on the format constants', runner.INFO === client.INFO && runner.ALG === client.ALG);

    const kp = client.newKeyPair();
    t('the public half is a raw 32-byte X25519 key, safe to put in a dispatch input',
        /^[A-Za-z0-9_-]{43}$/.test(kp.publicKey) && Buffer.from(kp.publicKey, 'base64url').length === 32);

    const payload = { hosts: ['abc-def.trycloudflare.com'], uuid: crypto.randomUUID(), wsPath: '/x7Kq2', n: 3 };
    const sealed = runner.seal(kp.publicKey, 'GT-2026-a1b2c3d4', payload);

    t('the sealed file carries no plaintext',
        !JSON.stringify(sealed).includes(payload.uuid) && !JSON.stringify(sealed).includes('trycloudflare'));
    t('the right key opens it, byte for byte',
        JSON.stringify(client.open(kp.privateJwk, sealed, 'GT-2026-a1b2c3d4')) === JSON.stringify(payload));

    const other = client.newKeyPair();
    t('another client\'s key cannot open it', throws(() => client.open(other.privateJwk, sealed, 'GT-2026-a1b2c3d4')));
    t('a file sealed for one session is refused for another', throws(() => client.open(kp.privateJwk, sealed, 'GT-2026-ffffffff')));

    const flipped = { ...sealed, ct: Buffer.from(sealed.ct, 'base64url').map((b, i) => (i === 5 ? b ^ 1 : b)).toString('base64url') };
    t('a single flipped bit is detected (authenticated encryption)', throws(() => client.open(kp.privateJwk, flipped, 'GT-2026-a1b2c3d4')));

    const relabelled = { ...sealed, sid: 'GT-2026-ffffffff' };
    t('relabelling the session id inside the file does not help — the id is bound into the AAD',
        throws(() => client.open(kp.privateJwk, relabelled, 'GT-2026-ffffffff')));

    t('an unknown format is refused before any crypto', throws(() => client.open(kp.privateJwk, { ...sealed, v: 1 }, 'GT-2026-a1b2c3d4')));
    t('the runner refuses a client key that is not a raw X25519 key',
        throws(() => runner.seal('not-a-key', 'GT-2026-a1b2c3d4', {})) && throws(() => runner.seal("'; rm -rf /", 's', {})));

    const again = runner.seal(kp.publicKey, 'GT-2026-a1b2c3d4', payload);
    t('every seal uses a fresh ephemeral key and IV', again.epk !== sealed.epk && again.iv !== sealed.iv);

    module.exports = results;
    if (require.main === module) {
        results.forEach(x => console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.detail ? '' : '\n      ' + x.detail)));
        const bad = results.filter(x => !x.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})().catch((e) => { console.error(e); process.exit(1); });
