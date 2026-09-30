#!/usr/bin/env node
// Spike S0b — DEV ONLY. Deploy (or delete, with --delete) the passthrough Worker on the
// Cloudflare account the app already has connected. Writes { host, key } to OUT/pass.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NAME = 'gt-pass-svc';
const OUT = process.env.GT_SPIKE_OUT || path.join(os.tmpdir(), 'gt-spike');
fs.mkdirSync(OUT, { recursive: true });

function account() {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
    const list = typeof d.cf_accounts === 'string' ? JSON.parse(d.cf_accounts) : d.cf_accounts;
    if (!Array.isArray(list) || !list.length) throw new Error('no Cloudflare account connected in the app');
    return list[0];
}
const auth = ({ token, email }) => (token.startsWith('cfat_') || !email)
    ? { Authorization: `Bearer ${token}` } : { 'X-Auth-Email': email, 'X-Auth-Key': token };

async function api(acc, method, url, body, raw) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${url}`, {
        method, headers: { ...auth(acc), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
        body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(`${method} ${url}: ${(data.errors && data.errors[0] && data.errors[0].message) || res.status}`);
    return data.result;
}

(async () => {
    const acc = account();
    const accounts = await api(acc, 'GET', '/accounts');
    const id = accounts[0].id;

    if (process.argv.includes('--delete')) {
        await api(acc, 'DELETE', `/accounts/${id}/workers/scripts/${NAME}`);
        try { fs.rmSync(path.join(OUT, 'pass.json')); } catch (e) {}
        console.log(`deleted ${NAME}`);
        return;
    }

    const key = crypto.randomBytes(24).toString('base64url');
    const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2024-11-01',
        bindings: [{ type: 'secret_text', name: 'PASS_KEY', text: key }],
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    form.append('worker.js', new Blob([fs.readFileSync(path.join(__dirname, 'pass-worker.js'), 'utf8')], { type: 'application/javascript+module' }), 'worker.js');
    await api(acc, 'PUT', `/accounts/${id}/workers/scripts/${NAME}`, form, true);
    await api(acc, 'POST', `/accounts/${id}/workers/scripts/${NAME}/subdomain`, { enabled: true });
    const sub = (await api(acc, 'GET', `/accounts/${id}/workers/subdomain`)).subdomain;
    const host = `${NAME}.${sub}.workers.dev`;
    fs.writeFileSync(path.join(OUT, 'pass.json'), JSON.stringify({ host, key }));
    console.log(`deployed ${NAME} → ${host.replace(sub, '<sub>')}`);
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
