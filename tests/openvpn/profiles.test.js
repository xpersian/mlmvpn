// «پروفایل‌ها و TunnelBear» — importing the user's own .ovpn files and the TunnelBear runtime text.
//
// A user reported they could not add their own OpenVPN configs. These are the import rules
// (Android ProfileImporter, docs/ANDROID-1.2.36-TO-WINDOWS.fa.md › ۱۱.۳) checked end to end
// against openvpn-profiles.js, in a throwaway home so no real profile or account is touched.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-ovp-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const ROOT = path.resolve(__dirname, '../..');
const prof = require(path.join(ROOT, 'openvpn-profiles.js'));

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// A real self-signed CA shape is required (isX509); take the bundled TunnelBear CA.
const CA = fs.readFileSync(path.join(ROOT, 'data/openvpn/tunnelbear/openvpn-server-ca.crt'), 'utf8');

const inline = `client\ndev tun\nproto udp\nremote vpn.example.org 1194\n<ca>\n${CA}\n</ca>\nauth-user-pass\ncipher AES-256-GCM\nverb 3\n`;
const byName = `client\ndev tun\nproto tcp-client\nremote 203.0.113.7 443\nca my-ca.crt\nremote-cert-tls server\n`;
const evil = `client\ndev tun\nremote 203.0.113.8 1194\nscript-security 2\nup /bin/sh\n<ca>\n${CA}\n</ca>\n`;

let r = prof.importFiles([{ name: 'Home server.ovpn', text: inline }]);
t('an inline-CA profile is added', r.added.length === 1 && !r.errors.length, JSON.stringify(r));
r = prof.importFiles([{ name: 'Home server.ovpn', text: inline }]);
t('…and the same file again is a duplicate, not a second copy', r.duplicates.length === 1 && !r.added.length, JSON.stringify(r));

r = prof.importFiles([{ name: 'office.ovpn', text: byName }]);
t('a profile that names its CA file without it is refused, naming the missing file',
    !r.added.length && r.errors.length === 1 && r.errors[0].missing === 'my-ca.crt', JSON.stringify(r));
r = prof.importFiles([{ name: 'office.ovpn', text: byName }, { name: 'my-ca.crt', text: CA }]);
t('…and the same profile with its CA picked alongside is added', r.added.length === 1, JSON.stringify(r));
r = prof.importFiles([{ name: 'office2.ovpn', text: byName.replace('203.0.113.7', '203.0.113.9') }]);
t('…a companion is REMEMBERED for profiles added later', r.added.length === 1, JSON.stringify(r));

r = prof.importFiles([{ name: 'evil.ovpn', text: evil }]);
t('a profile with script-security / up is refused (no script ever runs)', !r.added.length && r.errors.length === 1 && /Unsupported|script-security|up/i.test(r.errors[0].error), JSON.stringify(r));
r = prof.importFiles([{ name: 'traverse.ovpn', text: 'client\ndev tun\nremote 203.0.113.1 1194\nca ../../secret.crt\n' }]);
t('a file reference with a path is refused', !r.added.length && r.errors.length === 1, JSON.stringify(r));
r = prof.importFiles([{ name: 'tap.ovpn', text: `client\ndev tap0\nremote 203.0.113.2 1194\n<ca>\n${CA}\n</ca>\n` }]);
t('dev tap is refused (only tun)', !r.added.length && r.errors.length === 1, JSON.stringify(r));

const list = prof.list();
const home = list.find((p) => p.name === 'Home server');
t('the list shows the user\'s profiles by name, never their text', !!home && home.config === undefined && home.remotes[0].host === 'vpn.example.org', JSON.stringify(home));
t('the 47 TunnelBear countries are seeded alongside', list.filter((p) => p.tunnelbear).length === 47, String(list.filter((p) => p.tunnelbear).length));

// stored text: verb 0, no verb 3, remote-cert-tls added
const stored = JSON.parse(fs.readFileSync(path.join(prof.HOME, 'profiles.json'), 'utf8')).find((p) => p.name === 'Home server');
const text = Buffer.from(stored.config.data, 'base64').toString('utf8');   // plain outside Electron
t('the stored text carries verb 0 (the core log never holds the profile or credentials)', /^verb 0$/m.test(text) && !/^verb 3$/m.test(text), text.slice(0, 200));
t('…and remote-cert-tls server when the profile had no server check', /^remote-cert-tls server$/m.test(text));

// TunnelBear at runtime: TCP on the loopback relay, bypass routes for the relay's own sockets
const tbFile = fs.readdirSync(path.join(ROOT, 'data/openvpn/tunnelbear')).find((f) => /germany/i.test(f));
const tb = prof.parseProfile(tbFile, fs.readFileSync(path.join(ROOT, 'data/openvpn/tunnelbear', tbFile), 'utf8'), { 'openvpn-server-ca.crt': CA });
const eff = prof.effective(tb, { relayPort: 50123, relayHosts: ['198.51.100.1', '198.51.100.2'] });
t('TunnelBear runs as TCP on the loopback relay', /^proto tcp-client$/m.test(eff) && /^remote 127\.0\.0\.1 50123 tcp-client$/m.test(eff) && !/lazerpenguin\.com \d+/.test(eff.split('\n').filter((l) => /^remote /.test(l)).join('\n')), eff);
t('…each address the relay may dial gets a host route to the ORIGINAL gateway',
    /^route 198\.51\.100\.1 255\.255\.255\.255 net_gateway$/m.test(eff) && /^route 198\.51\.100\.2 255\.255\.255\.255 net_gateway$/m.test(eff));
t('…and a cipher line from data-ciphers (the core reads `cipher` for the data channel)', /^cipher AES-256-CBC$/m.test(eff), eff);

// accounts: saved without a window, credentials never listed
let a = prof.saveAccount({ username: 'bear@example.com', password: 's3cret' });
t('a TunnelBear account is saved', a.ok && prof.accounts().list.length === 1 && prof.accounts().activeId === a.id);
t('…and the listed account never carries the password', JSON.stringify(prof.accounts()).indexOf('s3cret') < 0);
t('…the account the engine dials with is the chosen one, with its password', (() => { const p = prof.pickAccount(); return p && p.username === 'bear@example.com' && p.password === 's3cret'; })());
let threw = null; try { prof.saveAccount({ username: 'x\ny', password: 'p' }); } catch (e) { threw = e.message; }
t('a username with a line break is refused (auth-user-pass is two lines)', !!threw, threw);
threw = null; try { prof.saveAccount({ id: a.id, username: 'bear@example.com', password: 'new' }, { busyId: a.id }); } catch (e) { threw = e.message; }
t('the account in use cannot be edited', !!threw && /قطع/.test(threw), threw);
prof.noteAccount(a.id, { auth: 'failed', lastError: 'x' });
const b = prof.saveAccount({ username: 'second@example.com', password: 'p2' });
t('with auto-switch, a failed account is skipped for the next that has not failed', prof.pickAccount().username === 'second@example.com');

let failed = 0;
for (const r2 of results) {
    console.log(`${r2.pass ? 'PASS' : 'FAIL'}  ${r2.name}`);
    if (!r2.pass) { failed++; if (r2.detail) console.log('      ' + String(r2.detail).slice(0, 400)); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* temp */ }
process.exit(failed ? 1 : 0);
