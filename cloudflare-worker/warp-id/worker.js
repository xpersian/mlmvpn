/**
 * The WARP identity relay: Cloudflare's WARP account API, reached through the user's own Worker.
 *
 * WireGuard, WARP-in-WARP and MASQUE all start from an identity — a device registered with
 * `api.cloudflareclient.com`. Iran now filters that one host: the direct request and the tunnel
 * core's own camouflaged route (random edge address, split ClientHello) both die at the ISP, so no
 * identity can be made and none of the three transports can start, even though their data path to
 * Cloudflare's edge still works.
 *
 * So the phone asks this Worker instead, and the Worker asks Cloudflare. The same idea as the
 * Gemini exit: the filtered hop is taken by something that is not in Iran.
 *
 *   POST  /<KEY>/v0a4471/reg            register a device (WireGuard key)
 *   PATCH /<KEY>/v0a4471/reg/<id>       enroll the MASQUE key for that device
 *   GET   /<KEY>/v0a4471/reg/<id>       read the device back
 *
 * Only the WARP registration API, only under the random KEY the app deployed with: anyone who
 * finds the address gets a 404, not a free proxy. Nothing is stored — the request goes through and
 * the answer comes back.
 */

const UPSTREAM = 'https://api.cloudflareclient.com';
const ALLOWED = /^\/v0a\d+\/reg(\/[A-Za-z0-9-]+)?$/;
const PASS_HEADERS = ['content-type', 'authorization', 'cf-client-version', 'user-agent', 'accept'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = String(env.KEY || '');
    const prefix = '/' + key;

    if (url.pathname === '/_health') {
      return json({ ok: true, service: 'warp-id' });
    }
    if (!key || !url.pathname.startsWith(prefix + '/')) {
      return new Response('not found', { status: 404 });
    }

    const path = url.pathname.slice(prefix.length);
    if (!ALLOWED.test(path) || !['GET', 'POST', 'PATCH'].includes(request.method)) {
      return new Response('not found', { status: 404 });
    }

    const headers = new Headers();
    for (const name of PASS_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has('user-agent')) headers.set('user-agent', 'WARP for Android');

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + path, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
      });
    } catch (e) {
      return json({ success: false, errors: [{ message: 'relay could not reach the WARP API: ' + (e && e.message ? e.message : e) }] }, 502);
    }

    // The answer as it came, status included: the app reads Cloudflare's own errors from it.
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
