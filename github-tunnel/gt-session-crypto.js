// --- GitHub Tunnel: sealed session hand-off (client side) ---
//
// The runner generates every credential of a session itself (VLESS UUIDs, secret paths,
// Hysteria2 passwords, the pin of its self-signed certificate) and publishes them by
// committing `sessions/<id>.json` to the user's private repo. That file must be useless to
// anyone who reads the repo or its history, so the runner SEALS it to a one-time X25519 key
// whose public half the client passed as a workflow_dispatch input:
//
//     shared = X25519(ephemeral_runner_priv, client_pub)
//     key    = HKDF-SHA256(shared, salt = epk || client_pub, info = INFO, 32)
//     ct     = AES-256-GCM(key, iv, JSON, aad = INFO + '|' + sessionId)
//
// Why not a repo secret, which is what v1 did with the Tailscale key: GitHub resolves repo
// secrets when a job STARTS, not when it is dispatched. With make-before-break (the next
// session dispatched while the current one runs, possibly on the same account), runner A can
// start with the secret written for runner B. A public key in the dispatch inputs belongs to
// exactly one run, needs no secrets API at all, and nothing sensitive ever sits in git.
//
// The sealing half lives in runner/seal.mjs (the runner has only Node); tests/github-tunnel
// seals with that file and opens with this one, so the two cannot drift apart silently.

const crypto = require('crypto');

const INFO = 'mlmvpn-gt-session-v2';
const ALG = 'x25519-hkdf-sha256-aes256gcm';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

/** A fresh one-time key pair. `publicKey` goes into the dispatch inputs; `privateJwk` stays here. */
function newKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pubJwk = publicKey.export({ format: 'jwk' });
    return { publicKey: pubJwk.x, privateJwk: privateKey.export({ format: 'jwk' }) };
}

function publicKeyFromRaw(x) {
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
}

/**
 * Open what the runner sealed. Throws on anything that is not exactly what we expect — a
 * tampered, truncated, replayed-for-another-session or wrongly-keyed file never yields data.
 */
function open(privateJwk, sealed, sessionId) {
    if (!sealed || sealed.alg !== ALG || sealed.v !== 2) throw new Error('sealed session: unknown format');
    if (sealed.sid !== sessionId) throw new Error('sealed session: written for another session');
    const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
    const clientPubRaw = unb64u(privateJwk.x);
    const epkRaw = unb64u(sealed.epk);
    if (epkRaw.length !== 32 || clientPubRaw.length !== 32) throw new Error('sealed session: bad key length');

    const shared = crypto.diffieHellman({ privateKey, publicKey: publicKeyFromRaw(sealed.epk) });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epkRaw, clientPubRaw]), Buffer.from(INFO), 32));
    const iv = unb64u(sealed.iv);
    const blob = unb64u(sealed.ct);
    if (iv.length !== 12 || blob.length < 17) throw new Error('sealed session: bad ciphertext');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`${INFO}|${sessionId}`));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    const plain = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

module.exports = { newKeyPair, open, INFO, ALG };
