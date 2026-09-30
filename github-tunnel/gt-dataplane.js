// --- GitHub Tunnel: which data plane is live ---
//
// v1 (gt-engine.js, Tailscale/WireGuard) and v2 (gt-core.js, Xray through the user's Worker to
// Cloudflare quick tunnels) implement the same contract, and exactly one of them can be up at a
// time — routes.js tears one down before bringing the other up. Everything OUTSIDE the feature
// that needs "the GitHub Tunnel" (traffic accounting in server.js, the quit path in main.js)
// asks here, so it follows whichever is actually running instead of being welded to v1.

const v1 = require('./gt-engine');
const v2 = require('./gt-core');

function isUp(engine) {
    try { const s = engine.getStatus(); return !!(s.running || s.connected); } catch (e) { return false; }
}

/** The engine that is running, or v1 when neither is (its idle status is the old default). */
function active() { return isUp(v2) ? v2 : v1; }

/** The engine a session belongs to. Sessions from before v2 carry no marker and are v1. */
function forSession(session) { return session && session.dataPlane === 'v2' ? v2 : v1; }

module.exports = {
    v1, v2, active, forSession,
    getStatus: () => active().getStatus(),
    readTrafficCounters: () => active().readTrafficCounters(),
    // Both, always: on the way out nobody gets to guess which one was up.
    bailSync: () => {
        try { v2.bailSync(); } catch (e) {}
        try { v1.bailSync(); } catch (e) {}
    },
};
