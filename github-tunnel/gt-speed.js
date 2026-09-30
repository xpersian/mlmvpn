// --- GitHub Tunnel v2: how much of the user's own line the tunnel delivers ---
//
// The v1 test measured 10 MB from speed.cloudflare.com with Node's default routing, which in
// proxy mode is the bare line, not the tunnel — and that host is one Cloudflare configs are
// known to fake or detour (memory: worker-speed-test-target). This one downloads a Google file
// with a Range header through the tunnel's own SOCKS port, over plain HTTP (TLS over a socket
// crashes on this machine class), 1 and 4 streams, and measures the line itself the same way
// in the same minute — so the only number that matters, tunnel ÷ line, is honest.
//
// Result shape matches gt-speedtest.js so the panel renders either.

const http = require('http');
const { socksHttpGet, probeDelay } = require('./gt-cleanip');

const HOST = 'dl.google.com';
const FILE = '/linux/direct/google-chrome-stable_current_amd64.deb';
const CHUNK = 25000000;

function directGet(range, seconds, onData) {
    return new Promise((resolve) => {
        const req = http.get({ host: HOST, path: FILE, headers: { Range: `bytes=${range}`, 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            res.on('data', (d) => onData(d.length));
            res.on('end', resolve);
            res.on('error', resolve);
        });
        req.on('error', resolve);
        setTimeout(() => { req.destroy(); resolve(); }, seconds * 1000);
    });
}

/** Mbit/s over `n` parallel streams, counted from the first byte. */
async function rate(socksPort, n, seconds = 8) {
    let bytes = 0;
    let first = 0;
    const onData = (b) => { if (!first) first = Date.now(); bytes += b; };
    const started = Date.now();
    await Promise.all(Array.from({ length: n }, (_, i) => {
        const range = `${i * CHUNK}-${i * CHUNK + CHUNK - 1}`;
        return socksPort
            ? socksHttpGet(socksPort, HOST, FILE, { timeoutMs: seconds * 1000, range, onData })
            : directGet(range, seconds, onData);
    }));
    const secs = Math.max(0.5, (Date.now() - (first || started)) / 1000);
    return bytes > 32 * 1024 ? +(bytes * 8 / secs / 1e6).toFixed(1) : 0;
}

const fa = (n) => Number(n).toLocaleString('fa-IR');

async function run({ socksPort = null, exit = null } = {}) {
    const results = [];
    const add = (name, verdict, detail, hint) => results.push({ name, verdict, detail, hint: hint || '' });

    if (!socksPort) {
        const one = await rate(null, 1), four = await rate(null, 4);
        add('سرعت خط (بدون تونل)', one || four ? 'PASS' : 'WARN', `${fa(one)} مگابیت با یک اتصال، ${fa(four)} با چهار اتصال`,
            'حالا تونل را روشن کنید و دوباره تست بگیرید تا معلوم شود تونل چقدر از این را می‌رساند.');
        return { pathKind: 'baseline', pingMs: null, results, summary: 'PASS' };
    }

    const delayMs = await probeDelay(socksPort, 12000);
    add('تأخیر از داخل تونل', delayMs == null ? 'FAIL' : delayMs < 800 ? 'PASS' : 'WARN',
        delayMs == null ? 'پاسخی نیامد' : `${fa(delayMs)} میلی‌ثانیه`);
    if (exit) add('خروجی', 'PASS', `${exit.countryName || exit.country || '?'}${exit.city ? ` — ${exit.city}` : ''} (${exit.ip})`);

    // Line first, tunnel second, line again — both halves ride the same minute of this line.
    const lineA = await rate(null, 4);
    const t1 = await rate(socksPort, 1);
    const t4 = await rate(socksPort, 4);
    const lineB = await rate(null, 4);
    const line = Math.max(lineA, lineB);

    add('سرعت تونل', t4 || t1 ? 'PASS' : 'FAIL', `${fa(t1)} مگابیت با یک اتصال، ${fa(t4)} با چهار اتصال`);
    if (line > 0) {
        const pct = Math.round((Math.max(t1, t4) / line) * 100);
        add('نسبت به خط شما', pct >= 70 ? 'PASS' : pct >= 40 ? 'WARN' : 'FAIL',
            `${fa(pct)}٪ از ${fa(line)} مگابیتِ همین خط در همین دقیقه`,
            pct >= 70 ? 'تونل تقریباً همهٔ سرعت خط را می‌رساند؛ سقف از خودِ اینترنت است.' : 'تونل بخشی از سرعت را می‌گیرد — «اتصال دوباره» آی‌پی‌های تمیز را از نو می‌سنجد.');
    } else {
        add('نسبت به خط شما', 'WARN', 'خط بدون تونل سنجیده نشد (احتمالاً فیلترشکن دیگری زیر آن است).');
    }
    return {
        pathKind: 'cloudflare', pingMs: delayMs, results,
        summary: results.some((r) => r.verdict === 'FAIL') ? 'FAIL' : results.some((r) => r.verdict === 'WARN') ? 'WARN' : 'PASS',
    };
}

module.exports = { run, rate };
