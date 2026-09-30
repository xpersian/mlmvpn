/**
 * The VPN Gate server list, relayed through the user's own Cloudflare account.
 *
 * www.vpngate.net cannot be reached from an Iranian ISP by any direct route. The domain is
 * DNS-poisoned to the 10.10.34.x block page; connecting to the real address does not help either,
 * because the operator's DPI reads the plaintext HTTP Host header and answers with the block page
 * ("type=Invalid Keyword"), and port 443 to those hosts is refused outright. Public relays
 * (allorigins, codetabs) return 520/522 — they cannot reach the origin either. So the fetch has
 * to happen somewhere outside that network, and the one piece of infrastructure this app can
 * already put there is a Worker on the user's own Cloudflare account.
 *
 * Why this and not a shared relay: a single hosted proxy is a single quota and a single point of
 * failure. The one this app used before answered HTTP 402 (DEPLOYMENT_DISABLED) the day its free
 * tier ran out, and with it went the only route. A Worker on the user's own account is their
 * 100,000 requests a day, not a shared pool — and the response is cached at the edge, so in
 * practice one fetch serves everyone who asks inside the window.
 */

const UPSTREAM = 'http://www.vpngate.net/api/iphone/';

/** How long the edge may serve a cached copy. The list turns over slowly; this is generous. */
const CACHE_TTL = 900;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    // The Cache API, keyed on this Worker's own URL. A hit costs no upstream request at all,
    // which is what keeps a busy account inside the free tier.
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + '/vpngate', request);

    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        headers: {
          // Some datacentre ranges get a challenge page without an ordinary UA.
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/plain,*/*',
        },
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });
    } catch (e) {
      return new Response('relay could not reach VPN Gate: ' + (e && e.message ? e.message : e), {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (!upstream.ok) {
      return new Response('upstream ' + upstream.status, {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const body = await upstream.text();

    // A truncated body or a challenge page parses to zero servers on the client, which is
    // indistinguishable from "VPN Gate has no servers today". Refuse it here instead, and do
    // not cache the refusal.
    if (!body.includes('#HostName') || body.length < 10000) {
      return new Response('upstream returned no server list', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
        'X-Relay': 'vpngate',
      },
    });

    // Populate the cache without making this request wait for it.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
