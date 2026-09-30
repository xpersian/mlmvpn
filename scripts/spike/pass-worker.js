// Spike S0b — DEV ONLY. A passthrough on the user's own workers.dev, because the first spike
// measured that *.trycloudflare.com is blocked from an Iranian line by BOTH DNS (answers with
// a refusing address) and SNI (TLS reset right after the ClientHello), while the same clean
// IPs carry the user's own *.workers.dev configs fine.
//
//   https://<this worker>/<PASS_KEY>/<quick-tunnel label>/<path>  →  https://<label>.trycloudflare.com/<path>
//
// Returning the upstream fetch() hands a WebSocket upgrade straight through; the Worker never
// touches the frames. Only the key-holder gets through, and only to *.trycloudflare.com.
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const m = url.pathname.match(/^\/([A-Za-z0-9_-]{20,64})\/([a-z0-9-]{3,63})(\/.*)?$/);
        if (!m || !env.PASS_KEY || !safeEqual(m[1], env.PASS_KEY)) {
            return new Response('Not Found', { status: 404 });
        }
        const target = `https://${m[2]}.trycloudflare.com${m[3] || '/'}${url.search}`;
        const headers = new Headers(request.headers);
        headers.delete('host');
        const init = { method: request.method, headers, redirect: 'manual' };
        if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
        return fetch(target, init);
    },
};

function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}
