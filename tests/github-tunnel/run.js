#!/usr/bin/env node
/*
 * GitHub Tunnel test suite.
 *
 *   node tests/github-tunnel/run.js
 *
 * Everything here is safe to run on a working machine, by construction:
 *   * USERPROFILE is redirected to a sandbox directory before any module is required, so
 *     no test can read or write the real ~/.mlmvpn (GitHub token, broker deployment,
 *     sessions, install secret);
 *   * global.fetch is stubbed, so nothing reaches GitHub, Cloudflare or Tailscale;
 *   * PowerShell is replaced by a recorder in the kill-switch tests. That code sets
 *     DefaultOutboundAction=Block on every firewall profile — it must NEVER actually run
 *     during a test, and the recorder is what makes asserting on it possible instead.
 *
 * The suites, and what each one is guarding against:
 *
 *   kill-switch.test.js   The firewall guard, including the crash path: a process killed
 *                         while engaged used to leave the machine block-by-default with no
 *                         record and no way back. Also pins the NetSecurity.Action enum
 *                         (NotConfigured=0, Allow=2, Block=4) — reading Allow as Block made
 *                         the restore path itself set Block permanently.
 *   dns-leak.test.js      The DNS block that keeps name lookups inside the tunnel. Windows
 *                         asked the router too, the router answered first, and on an Iranian
 *                         line that answer is the filter's — «میزنه ایران». Pins what is
 *                         blocked, the self-check that rolls it back if resolution breaks,
 *                         its independence from the kill switch, and the crash path.
 *   ipv6-leak.test.js     The IPv6 block. The exit node has no v6 egress, so Tailscale
 *                         leaves the modem's ::/0 route in place and every site with an
 *                         AAAA record could read the user's real Iranian address. Pins what
 *                         is blocked (and what deliberately is not), the no-IPv4 refusal,
 *                         the user's switch, and independence from the other two guards.
 *   ownership.test.js     Things this feature does not own. The shared full-system tunnel is
 *                         stopped only when it is chained to our own engine (a disconnect used
 *                         to take down the user's V2Ray/WARP tunnel), and the kill-switch
 *                         refuses while the WARP-family guard holds the firewall (it would
 *                         have recorded that guard's Block as the machine's own and restored
 *                         it for good).
 *   session-v2.test.js    The v2 sealed hand-off: runner/seal.mjs seals, gt-session-crypto.js
 *                         opens. Pins the round trip, that only the dispatching client's key
 *                         and only that session can open it, and that tampering is detected.
 *   broker-pass.test.mjs  The Worker's /p/ passthrough to a session's quick tunnel (which is
 *                         blocked from Iran by DNS and SNI). Pins that it is not an open relay,
 *                         reaches only the tunnel the signed pass names, and dies with expiry.
 *   gtcore.test.js        v2's client engine: every rule of the Xray config it builds (Worker
 *                         SNI, http/1.1-only ALPN, no allowInsecure, mux/XUDP, signed pass in
 *                         the path, no access log), the checks on what the runner sends back,
 *                         the hash-checked private core copy, and Xray itself accepting it.
 *   deployer-v2.test.js   The v2 session hand-off end to end against a fake GitHub: no repo
 *                         secret, the key out as a dispatch input, sealed credentials back,
 *                         stored protected; relay checked before a runner is spent; a runner
 *                         with no quick tunnel cancelled without blaming the account.
 *   broker-auth.test.mjs  The Cloudflare Worker's request signing, driven through its real
 *                         default export. The Worker sits on a public URL and mints
 *                         pre-authorized, exit-node-approved Tailscale keys; it shipped
 *                         once with the signature field accepted and never checked.
 *   behaviour.test.js     Session store and state machine, the run-id dispatch matching
 *                         (which must survive a wrong local clock in both directions), the
 *                         fallback-proxy 401 distinction, workflow-template invariants and
 *                         the pinned MSI digest.
 *   routes.test.js        The HTTP surface on a throwaway express app, including a burst of
 *                         concurrent transitions that must serialise rather than interleave.
 *   accounts.test.js      The GitHub account pool: encrypted-at-rest tokens, health and
 *                         cooldown semantics, quota resolution (measured vs estimated vs
 *                         unknown), allocation ranking, session affinity, billing cycles,
 *                         and the concurrency case the leasing exists for — ten
 *                         simultaneous claims must never hand out one account twice.
 *   failover.test.js      The acceptance scenario end to end through the real
 *                         createSession(): two spent accounts, one that works, the session
 *                         bound to the account that actually ran it, and a live session
 *                         surviving its own account running out of allowance.
 *   panel-ui.test.js      The window's markup, rendered in a sandbox in every state that matters:
 *                         kit controls only (no native select/details, no inline handlers, no
 *                         legacy colours), every control wired to a registered handler — and
 *                         ui/mv.js › showBanner, which froze the whole app on a fourth banner.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
    'kill-switch.test.js',
    'dns-leak.test.js',
    'ipv6-leak.test.js',
    'ownership.test.js',
    'session-v2.test.js',
    'broker-pass.test.mjs',
    'gtcore.test.js',
    'deployer-v2.test.js',
    'fulltunnel.test.js',
    'continuity.test.js',
    'control-plane.test.js',
    'slots.test.js',
    'exits.test.js',
    'broker-auth.test.mjs',
    'behaviour.test.js',
    'routes.test.js',
    'accounts.test.js',
    'failover.test.js',
    'panel-ui.test.js',
];

// gt-net tries the app's own Xray (127.0.0.1:20809) before the edge proxy. On a developer
// machine that port may really be open, which would route stubbed calls differently from
// run to run; the suites that exercise that path set their own port.
process.env.MLMVPN_GT_LOCAL_ENGINE_PORT = '0';

let failed = 0;
for (const suite of SUITES) {
    console.log(`\n${'─'.repeat(64)}\n${suite}\n${'─'.repeat(64)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}

console.log(`\n${'═'.repeat(64)}`);
console.log(failed ? `${failed} suite(s) FAILED` : `all ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
