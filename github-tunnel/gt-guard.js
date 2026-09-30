// --- GitHub Tunnel: fail-closed guard (kill-switch + IPv6 containment) ---
//
// WHAT THIS PREVENTS
// Without it, the tunnel failing is *silent and worse than being disconnected*: tailscaled
// dies or the exit node drops, Windows quietly falls back to the physical route, and the
// next packet from a browser that is already mid-session carries the user's real address.
// Nothing errors. Nothing pops up. The user finds out from the far end. For someone in the
// middle of a trade on an exchange that geo-bans them, that is the whole ballgame.
//
// HOW
// Windows firewall profiles get DefaultOutboundAction=Block, plus a narrow allow-list:
//   * anything leaving through the tunnel adapter,
//   * the engine itself (tailscaled must reach relays or it can never reconnect),
//   * this app (it needs the control plane to rebuild the session — otherwise a dropped
//     tunnel is unrecoverable without the user turning the guard off by hand),
//   * loopback and the local subnet, so LAN/printers/router UI keep working.
// Everything else, including ALL IPv6 (the exit node has no v6 egress, so v6 can only ever
// be a leak path), is dropped.
//
// THE DANGEROUS PART, AND WHY THE RESTORE PATH IS THE WAY IT IS
// A block-by-default firewall that outlives the process would leave the machine with no
// internet and no obvious cause. So the previous profile state is captured before any
// change, and restored from: normal disengage, process exit, SIGINT/SIGTERM, and an
// uncaught exception. The exit paths use SYNCHRONOUS calls on purpose — an async restore
// scheduled during 'exit' never runs.

// ── THE HOLE THIS FILE USED TO HAVE, AND WHY IT WAS THE WORST ONE ──────────────────
// Every restore path above is an in-process one. None of them run when the process does
// not get to run code: Task Manager "End task", a hard crash, a bluescreen, power loss,
// an antivirus killing the app. In every one of those the machine is left with
// DefaultOutboundAction=Block and an allow-list whose only useful entry points at a tunnel
// adapter that no longer exists — that is a PC with no internet, no error message, and no
// way for its owner to connect the two facts. Reinstalling the app does not fix it either.
//
// So the pre-change firewall state is also written to disk the moment it is captured, and
// restoreIfStale() puts it back at startup before anything else happens. The file is the
// record that survives us; the in-memory copy is only the fast path.

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RULE_PREFIX = 'MLMVPN-GT';
const GROUP = 'MLMVPN GitHub Tunnel';

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STATE_FILE = path.join(HOME_DIR, 'gt-guard-state.json');

let engaged = false;
let savedOutboundActions = null; // [{ name, action }]
let restoreHooksInstalled = false;

// The WARP-family guard (aether-guard.js) drives the very same DefaultOutboundAction. If it
// is engaged and we captured the live profiles now, we would record ITS Block as the
// machine's original state — and our restore would make block-by-default permanent: a PC
// with no internet. aether-guard.js already refuses in the mirror case; this is the other
// half. Its record also exists while it only owns DNS, which does not touch the firewall, so
// the record is read rather than merely tested for.
const AETHER_STATE_FILE = path.join(HOME_DIR, 'aether-guard-state.json');

function aetherFirewallEngaged() {
    let raw;
    try { raw = fs.readFileSync(AETHER_STATE_FILE, 'utf8'); } catch (e) { return false; }
    try {
        const s = JSON.parse(raw);
        return !!(s && (s.firewallEngaged || (Array.isArray(s.profiles) && s.profiles.length)));
    } catch (e) {
        // A record we cannot read cannot prove the firewall is ours to capture.
        return true;
    }
}

function writeStateFile(profiles) {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        const tmp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ engagedAt: Date.now(), profiles }, null, 2), 'utf8');
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { /* see clearStateFile: a missing record only costs us the safety net */ }
}

function readStateFile() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return Array.isArray(s.profiles) && s.profiles.length ? s.profiles : null;
    } catch (e) { return null; }
}

function clearStateFile() {
    try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}
}

function ps(script, { sync = false } = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    if (sync) {
        return execFileSync('powershell.exe', args, { windowsHide: true, timeout: 30000, encoding: 'utf8' });
    }
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', args, { windowsHide: true, timeout: 45000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').toString().trim()));
            resolve((stdout || '').toString());
        });
    });
}

function installRestoreHooks() {
    if (restoreHooksInstalled) return;
    restoreHooksInstalled = true;
    const bail = () => {
        try { disengageSync(); } catch (e) {}
        try { unblockLanDnsSync(); } catch (e) {}
        try { unblockIpv6Sync(); } catch (e) {}
        try { releaseEnforcingSync(); } catch (e) {}
    };
    process.on('exit', bail);
    process.on('SIGINT', () => { bail(); process.exit(130); });
    process.on('SIGTERM', () => { bail(); process.exit(143); });
    process.on('uncaughtException', (e) => { bail(); throw e; });
}

function removeRulesScript() {
    return `Remove-NetFirewallRule -Group '${GROUP}' -ErrorAction SilentlyContinue`;
}

// The only values Set-NetFirewallProfile accepts for these two. Everything read back from
// PowerShell is checked against them before it is ever interpolated into a script: a value
// that is not on this list is not a firewall setting, it is either corruption or an
// injection attempt, and either way must not be executed.
const OUTBOUND_VALUES = ['NotConfigured', 'Allow', 'Block'];
const INBOUND_VALUES = ['NotConfigured', 'Allow', 'Block'];
const ENABLED_VALUES = ['NotConfigured', 'True', 'False'];
const PROFILE_NAME = /^(Domain|Private|Public)$/;

// ── WHEN WINDOWS FIREWALL IS OFF ────────────────────────────────────────────────────
//
// Every guard in this file is a Windows Firewall rule, and a profile that is switched off
// enforces NONE of them. Measured on the reporting machine, 2026-09-23: all three profiles
// off, the full tunnel up — the IPv6 and DNS rules were in place and the panel read «قفل IPv6:
// فعال» over a firewall that enforced nothing at all. (The tunnel itself was not leaking: it
// takes IPv6 and every lookup whatever the firewall does. What was missing is the net for the
// moment the tunnel DROPS.)
//
// The WARP guard's rule stands here too: this app does not switch a user's firewall on behind
// their back — the usual reason it is off is a security suite, or the user's own choice. So the
// kill switch and both locks REPORT 'firewall-disabled' instead of pretending, and the panel
// offers one explicit choice, «روشن کردن دیوارآتش ویندوز فقط هنگام اتصال»
// (setFirewallPolicy({ enableWhenOff: true })). With it, the profiles that are off are switched
// on for the tunnel's lifetime with inbound left ALLOWED — nothing that reached this machine
// before (file sharing, a game host, «شبکه محلی») stops — and put back exactly, Enabled and
// DefaultInboundAction both, when the last guard lets go: disconnect, quit, or the next launch
// after a crash (FW_STATE_FILE, written before anything changes).
const FW_STATE_FILE = path.join(HOME_DIR, 'gt-fw-state.json');
let enableWhenOff = false;
let fwLease = null;      // [{ name, enabled, inbound }] — the profiles WE switched on, as they were
let lastFirewall = null; // { at, profiles, active, enforcing } — the last reading

function setFirewallPolicy({ enableWhenOff: v } = {}) { enableWhenOff = !!v; }

function writeFwState(list) {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        const tmp = `${FW_STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ leasedAt: Date.now(), profiles: list }, null, 2), 'utf8');
        fs.renameSync(tmp, FW_STATE_FILE);
        return true;
    } catch (e) { return false; }
}
function readFwState() {
    try {
        const s = JSON.parse(fs.readFileSync(FW_STATE_FILE, 'utf8'));
        return Array.isArray(s.profiles) && s.profiles.length ? s.profiles : null;
    } catch (e) { return null; }
}
function clearFwState() { try { fs.rmSync(FW_STATE_FILE, { force: true }); } catch (e) {} }

/**
 * The profiles, and which of them the machine's networks are on right now. «Enforcing» means
 * every profile a live network uses is switched on — the only state in which a rule here
 * does anything. Strings, for the reason captureProfiles() below gives.
 */
async function readFirewall() {
    const raw = await ps(
        `$p = @(Get-NetFirewallProfile | Select-Object -Property Name,` +
        `@{Name='Enabled';Expression={$_.Enabled.ToString()}},` +
        `@{Name='Inbound';Expression={$_.DefaultInboundAction.ToString()}});` +
        `$c = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { $_.NetworkCategory.ToString() });` +
        `@{ profiles = $p; categories = $c } | ConvertTo-Json -Compress -Depth 3`,
    );
    const j = JSON.parse(String(raw || '').trim() || '{}');
    const list = Array.isArray(j.profiles) ? j.profiles : (j.profiles ? [j.profiles] : []);
    const profiles = list
        .filter((p) => p && PROFILE_NAME.test(String(p.Name || '')))
        .map((p) => ({
            name: p.Name,
            enabled: ENABLED_VALUES.includes(p.Enabled) ? p.Enabled : 'NotConfigured',
            inbound: INBOUND_VALUES.includes(p.Inbound) ? p.Inbound : 'NotConfigured',
        }));
    const cats = Array.isArray(j.categories) ? j.categories : (j.categories ? [j.categories] : []);
    // DomainAuthenticated is the Domain profile.
    const active = [...new Set(cats.map((c) => (c === 'DomainAuthenticated' ? 'Domain' : String(c))).filter((n) => PROFILE_NAME.test(n)))];
    const isOn = (n) => (profiles.find((p) => p.name === n) || {}).enabled === 'True';
    const judged = active.length ? active : profiles.map((p) => p.name);
    lastFirewall = { at: Date.now(), profiles, active, enforcing: judged.length > 0 && judged.every(isOn) };
    return lastFirewall;
}

/**
 * Make sure the rules about to be written will be enforced. On a machine whose firewall is off
 * that means switching it on — only when the user chose that (see above); otherwise the answer
 * is 'firewall-disabled' and nothing is touched.
 */
async function ensureEnforcing(log) {
    let fw;
    try { fw = await readFirewall(); }
    catch (e) { return { ok: true, unknown: true }; }   // cannot read it: let the rule build say what is wrong
    if (fw.enforcing) return { ok: true };
    const off = fw.profiles.filter((p) => p.enabled !== 'True');
    if (!enableWhenOff) return { ok: false, reason: 'firewall-disabled', off: off.map((p) => p.name) };
    // Recorded BEFORE anything changes. A lease left by a run that died holding it is the only
    // honest record of how these profiles were — reading them now would record our own «on».
    const had = fwLease || readFwState() || [];
    const known = new Set(had.map((p) => p.name));
    fwLease = [...had, ...off.filter((p) => !known.has(p.name)).map((p) => ({ name: p.name, enabled: p.enabled, inbound: p.inbound }))];
    if (!writeFwState(fwLease)) return { ok: false, reason: 'state-file' };
    await ps(`$ErrorActionPreference = 'Stop'\n` + off.map((p) => `Set-NetFirewallProfile -Name '${p.name}' -Enabled True -DefaultInboundAction Allow`).join('\n'));
    lastFirewall = Object.assign({}, fw, { enforcing: true });
    try {
        log && log(`دیوارآتش ویندوز (${off.map((p) => p.name).join('، ')}) خاموش بود و فقط برای مدت اتصال روشن شد — ورودی‌ها مثل قبل باز می‌مانند و با قطع اتصال همه‌چیز به حالت قبل برمی‌گردد.`);
    } catch (e) {}
    return { ok: true, enabledNow: off.map((p) => p.name) };
}

function fwRestoreScript(list) {
    return '$ErrorActionPreference = \'SilentlyContinue\'\n' + (list || [])
        .filter((p) => p && PROFILE_NAME.test(p.name || '') && ENABLED_VALUES.includes(p.enabled))
        .map((p) => `Set-NetFirewallProfile -Name '${p.name}' -Enabled ${p.enabled}`
            + (INBOUND_VALUES.includes(p.inbound) ? ` -DefaultInboundAction ${p.inbound}` : ''))
        .join('\n');
}

/** Put the profiles we switched on back — once nothing here still needs them. */
async function releaseEnforcing(log) {
    if (engaged || dnsBlocked || ipv6Blocked) return;
    const lease = fwLease || readFwState();
    if (!lease) return;
    try { await ps(fwRestoreScript(lease)); } catch (e) { return; }   // the record stays; the next launch retries
    fwLease = null;
    clearFwState();
    lastFirewall = null;
    try { log && log('دیوارآتش ویندوز به حالت قبلش برگشت.'); } catch (e) {}
}

function releaseEnforcingSync() {
    if (engaged || dnsBlocked || ipv6Blocked) return;
    const lease = fwLease || readFwState();
    if (!lease) return;
    try { ps(fwRestoreScript(lease), { sync: true }); } catch (e) { return; }
    fwLease = null;
    clearFwState();
}

/** What the panel shows: whether the rules are enforced, and whether we switched it on. */
function firewallStatus() {
    return {
        enforcing: lastFirewall ? lastFirewall.enforcing : null,
        off: lastFirewall ? lastFirewall.profiles.filter((p) => p.enabled !== 'True').map((p) => p.name) : [],
        autoEnable: enableWhenOff,
        leased: !!(fwLease && fwLease.length),
        checkedAt: lastFirewall ? lastFirewall.at : 0,
    };
}
async function refreshFirewall() {
    try { await readFirewall(); } catch (e) {}
    return firewallStatus();
}

/**
 * What the firewall looked like before this feature touched it.
 *
 * Read as STRINGS, deliberately.
 *
 * The numeric form of this enum is a trap, and the previous version fell straight into it.
 * Microsoft's NetSecurity.Action is NotConfigured=0, **Allow=2, Block=4** — while the code
 * treated 2 as Block. So on any machine that had an explicit Allow (value 2) the guard
 * recorded "Block", and then its own restore path — the thing whose entire job is to give
 * the user their internet back — set DefaultOutboundAction=Block permanently. The safety
 * mechanism was the thing that bricked the machine, and it would have done it on
 * disengage, on quit, and on crash recovery alike. Reading '.ToString()' removes the whole
 * class of bug, and the strings it produces are exactly the values Set-NetFirewallProfile
 * takes back.
 */
async function captureProfiles() {
    const raw = await ps(
        `Get-NetFirewallProfile | Select-Object -Property Name,` +
        `@{Name='Outbound';Expression={$_.DefaultOutboundAction.ToString()}},` +
        `@{Name='Enabled';Expression={$_.Enabled.ToString()}} | ConvertTo-Json -Compress`,
    );
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed])
        .filter(p => p && typeof p.Name === 'string' && /^[A-Za-z]+$/.test(p.Name))
        .map(p => ({
            name: p.Name,
            // Anything unrecognised falls back to the value that cannot leave a user
            // offline. Being briefly less strict than they were is recoverable; being
            // stricter is the failure with no way out.
            action: OUTBOUND_VALUES.includes(p.Outbound) ? p.Outbound : 'Allow',
            enabled: ENABLED_VALUES.includes(p.Enabled) ? p.Enabled : 'NotConfigured',
        }));
}

/**
 * Turn the guard on.
 * @param adapterName  the tunnel adapter (traffic through it is always allowed)
 * @param allowPrograms absolute paths permitted to talk outside the tunnel
 */
async function engage({ adapterName, allowPrograms = [], onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    // Refuse before anything is captured or written: see AETHER_STATE_FILE above.
    if (aetherFirewallEngaged()) {
        log('محافظ نشت ماسک/وایرگارد/وارپ در وارپ فعال است؛ محافظ نشت GitHub روشن نشد تا تنظیمات دیوارآتش خراب نشود.');
        return { ok: false, reason: 'aether-guard-engaged' };
    }
    installRestoreHooks();

    // A record left by a run that died engaged is put back FIRST, completely, by the rules it
    // was written under. It is the only honest source for what the machine looked like — but
    // an older build's record also carries the profiles' Enabled switch, which the firewall
    // lease below now owns, so it is settled before a new state is taken rather than mixed in.
    if (!savedOutboundActions && readStateFile()) {
        savedOutboundActions = readStateFile();
        try { await ps(buildRestoreScript()); } catch (e) { /* the record stays; we refuse below */ }
        savedOutboundActions = null;
        if (!(await ps('Get-NetFirewallRule -Group \'' + GROUP + '\' -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count').then((n) => Number(String(n).trim()) === 0, () => false))) {
            log('محافظ نشتِ باقی‌مانده از اجرای قبلی برداشته نشد؛ محافظ تازه روشن نشد تا تنظیمات دیوارآتش خراب نشود.');
            return { ok: false, reason: 'stale-state' };
        }
        clearStateFile();
    }

    // A profile that is switched OFF enforces none of this (see WHEN WINDOWS FIREWALL IS OFF).
    const fw = await ensureEnforcing(log);
    if (!fw.ok) {
        if (fw.reason === 'firewall-disabled') {
            log('دیوارآتش ویندوز روی این سیستم خاموش است، پس محافظ نشت نمی‌تواند کار کند. برنامه دیوارآتش شما را خودسرانه روشن نمی‌کند — در پنل «روشن کردن دیوارآتش ویندوز فقط هنگام اتصال» را بزنید.');
        }
        return { ok: false, reason: fw.reason };
    }

    // Outbound actions only: the Enabled switch belongs to the lease above.
    savedOutboundActions = (await captureProfiles()).map((p) => ({ name: p.name, action: p.action }));
    // Written BEFORE the firewall is touched. Written after, a crash in between is exactly
    // the case with no record and no way back.
    writeStateFile(savedOutboundActions);

    const progRules = allowPrograms
        .filter(Boolean)
        .map((p, i) => `New-NetFirewallRule -DisplayName '${RULE_PREFIX}-prog-${i}' -Group '${GROUP}' -Direction Outbound -Program '${p.replace(/'/g, "''")}' -Action Allow -Profile Any | Out-Null`)
        .join('\n');

    const script = `
$ErrorActionPreference = 'Stop'
${removeRulesScript()}

# Allow-list FIRST, block-by-default LAST. Doing it the other way round means a window,
# however short, where the machine has no working network path at all.
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-tunnel' -Group '${GROUP}' -Direction Outbound -InterfaceAlias '${adapterName}' -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-loopback' -Group '${GROUP}' -Direction Outbound -RemoteAddress 127.0.0.1/8 -Action Allow -Profile Any | Out-Null
# NO ::1 RULE — the WARP guard found this first. Windows rejects a loopback address as
# -RemoteAddress outright ("An unspecified, multicast, broadcast, or loopback IPv6 address was
# specified", HRESULT 0x80070057), $ErrorActionPreference='Stop' then aborts the script here,
# and the block-by-default line at the end never runs. That is exactly what shipped in 1.2.3:
# the kill switch built two rules and never engaged, on every machine. Windows does not filter
# loopback traffic anyway, so the rule bought nothing even in theory.
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-lan' -Group '${GROUP}' -Direction Outbound -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-dhcp' -Group '${GROUP}' -Direction Outbound -Protocol UDP -RemotePort 67,68 -Action Allow -Profile Any | Out-Null
${progRules}

# IPv6 is not carried by the exit node, so every v6 packet that leaves this machine is by
# definition outside the tunnel. It is already dropped by DefaultOutboundAction=Block
# below — that default is address-family agnostic — and the two -Program allow rules are
# the only holes, which is deliberate: the daemon and this app must reach the control
# plane over whatever the machine has.
#
# (An earlier version claimed this next rule was what blocked IPv6. It is not: -Protocol
# ICMPv6 matches ICMPv6 only, not TCP or UDP over v6. It is kept because dropping Router
# Advertisement / Neighbor Discovery chatter stops Windows re-deriving a v6 default route
# and re-trying AAAA behind our back, which is the actual cause of the stalls.)
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-block-v6' -Group '${GROUP}' -Direction Outbound -Protocol ICMPv6 -Action Block -Profile Any | Out-Null

# The block action only. Whether each profile is ON is the firewall lease's business
# (ensureEnforcing): on, or the user said we may switch it on, or we never got this far.
Set-NetFirewallProfile -All -DefaultOutboundAction Block
`;
    try {
        await ps(script);
    } catch (e) {
        // Half an allow-list is the dangerous state: undo whatever landed instead of leaving it
        // for a disconnect that may never come. The profiles go back to their outbound action,
        // the rules go, and a lease taken only for this goes too.
        try { await ps(buildRestoreScript()); } catch (_) {}
        savedOutboundActions = null;
        clearStateFile();
        await releaseEnforcing(log);
        const why = String((e && e.message) || e).split('\n')[0].slice(0, 200);
        log(`محافظ نشت روشن نشد و هر چه ساخته بود برداشته شد: ${why}`);
        return { ok: false, reason: 'script-failed', detail: why };
    }
    engaged = true;
    log('محافظ نشت فعال شد — اگر تونل قطع شود، هیچ ترافیکی با آی‌پی واقعی خارج نمی‌شود.');
    return { ok: true };
}

function buildRestoreScript() {
    const restores = (savedOutboundActions || [])
        // Re-validated at USE time, not only at capture time: this list can also come off
        // disk, written by an older build or edited by hand, and it is about to become a
        // PowerShell command line.
        .filter(p => p && /^[A-Za-z]+$/.test(p.name || '') && OUTBOUND_VALUES.includes(p.action))
        .map((p) => {
            const enabled = ENABLED_VALUES.includes(p.enabled) ? p.enabled : null;
            // Records written before profile Enabled was tracked have no `enabled` field.
            // Leave the switch alone rather than guessing at it.
            return `Set-NetFirewallProfile -Name '${p.name}' -DefaultOutboundAction ${p.action}`
                + (enabled ? ` -Enabled ${enabled}` : '');
        })
        .join('\n');
    // If the saved state was somehow never captured, fall back to Allow: leaving a user
    // with no internet is a worse failure than briefly leaving the guard off.
    return `
$ErrorActionPreference = 'SilentlyContinue'
${restores || 'Set-NetFirewallProfile -All -DefaultOutboundAction Allow'}
${removeRulesScript()}
`;
}

async function disengage(onLog) {
    if (!engaged && !savedOutboundActions) return;
    try { await ps(buildRestoreScript()); } catch (e) {}
    engaged = false;
    savedOutboundActions = null;
    // Last: while this file exists, the machine is considered "possibly still firewalled",
    // and clearing it before the restore actually ran would throw away the only record of
    // how to undo a change that is still in place.
    clearStateFile();
    try { onLog && onLog('محافظ نشت غیرفعال شد.'); } catch (e) {}
    await releaseEnforcing(onLog);
}

/** Synchronous twin of disengage(), for exit handlers where promises never settle. */
function disengageSync() {
    if (!engaged && !savedOutboundActions) return;
    try { ps(buildRestoreScript(), { sync: true }); } catch (e) {}
    engaged = false;
    savedOutboundActions = null;
    clearStateFile();
    releaseEnforcingSync();
}

// ── THE DNS LEAK, AND WHY IT NEEDS RULES OF ITS OWN ────────────────────────────────
//
// Reported 2026-09-22 as «تونل گیت هاب نشتی داره — وارد یکسری سایت ها میشن میزنه ایران».
// The tunnel itself was fine; the NAME LOOKUPS were not going through it.
//
// Windows sends a lookup to the DNS server of EVERY adapter at once and takes the first
// answer (smart multi-homed name resolution). While the tunnel is up those servers are
// Tailscale's 100.100.100.100 — which forwards through the exit node — and whatever the
// physical adapter was given. A public server like 1.1.1.1 is routed into the tunnel like any
// other address. But the ROUTER is on-link, so its lookups leave straight through the Wi-Fi,
// one hop away: it answers first, every time. And nothing stops it:
//   * Tailscale's own kill switch PERMITS port 53 to any address on every interface
//     (tailscale/wf firewall.go › permitDNS) — so `--exit-node-allow-lan-access=false`
//     would not have closed this, and it would have cost the user their printer;
//   * the guard above allows LocalSubnet, for the same printers.
// On the reporting machine the router's DNS was an IPv6 link-local address its line had
// started handing out (fe80::…, from the router advertisement), which is also why «قبلا
// اینطوری نبود»: before the line had IPv6, the only DNS on that adapter was 1.1.1.1. On an
// Iranian line every plain lookup that leaves directly is answered by the filter — measured
// the same day, even one addressed to 1.1.1.1 came back 10.10.34.36 for x.com — and the
// tunnel's own log showed connections to 10.10.34.36 through the exit node. Sites that decide
// by DNS answered for Iran.
//
// The fix is a firewall BLOCK on DNS to on-link destinations while the tunnel is up. A
// block wins over every allow above it and over Tailscale's permit: Tailscale's rules are
// ordinary permits in its lowest-weight sublayer, with no hard-permit flag. The tunnel's own
// resolvers are never on-link — Tailscale gives its adapter the node's /32 and /128 only
// (osrouter/ifconfig_windows.go › syncAddresses) — and the rule proves it did not break
// resolution before it is kept.
//
// Independent of the kill switch on purpose: turning the kill switch off accepts a leak when
// the tunnel DROPS, not a leak while it is up.

const DNS_GROUP = 'MLMVPN GitHub Tunnel DNS';
const DNS_STATE_FILE = path.join(HOME_DIR, 'gt-dns-block.json');
let dnsBlocked = false;

function writeDnsState() {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(DNS_STATE_FILE, JSON.stringify({ blockedAt: Date.now() }), 'utf8');
        return true;
    } catch (e) { return false; }
}
const hasDnsState = () => { try { return fs.existsSync(DNS_STATE_FILE); } catch (e) { return false; } };
function clearDnsState() { try { fs.rmSync(DNS_STATE_FILE, { force: true }); } catch (e) {} }

const removeDnsRulesScript = () => `Remove-NetFirewallRule -Group '${DNS_GROUP}' -ErrorAction SilentlyContinue`;

function blockDnsScript() {
    return `
$ErrorActionPreference = 'Stop'
${removeDnsRulesScript()}
# LocalSubnet follows the adapters as they change (a new Wi-Fi, a new LAN) — a snapshot of
# today's prefixes would not. Link-local is listed as well, whatever LocalSubnet makes of it:
# that is exactly where the router's IPv6 DNS lives.
foreach ($proto in @('UDP', 'TCP')) {
    $ports = if ($proto -eq 'TCP') { @('53', '853') } else { @('53') }
    New-NetFirewallRule -DisplayName "${RULE_PREFIX}-dns-lan-$proto" -Group '${DNS_GROUP}' -Direction Outbound -Protocol $proto -RemotePort $ports -RemoteAddress LocalSubnet -Action Block -Profile Any | Out-Null
    New-NetFirewallRule -DisplayName "${RULE_PREFIX}-dns-link-$proto" -Group '${DNS_GROUP}' -Direction Outbound -Protocol $proto -RemotePort $ports -RemoteAddress @('fe80::/10', '169.254.0.0/16') -Action Block -Profile Any | Out-Null
}
# PROOF IT DID NOT BREAK RESOLUTION. A name nobody has ever looked up, so no cache can answer
# for it: any reply — NXDOMAIN included — means a server was reached through the tunnel. Only
# silence means the block took the tunnel's resolver too, and then it comes straight back off.
$probe = 'mlmvpn-' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '.example.com'
$reached = $false
foreach ($i in 1..3) {
    try { Resolve-DnsName -Name $probe -DnsOnly -ErrorAction Stop | Out-Null; $reached = $true }
    catch { if ($_.Exception.NativeErrorCode -in @(9003, 9501)) { $reached = $true } }
    if ($reached) { break }
    Start-Sleep -Milliseconds 700
}
if (-not $reached) {
    ${removeDnsRulesScript()}
    'ROLLED_BACK'
} else {
    # The servers now refused, for the log: what would have been leaking to.
    $lan = Get-DnsClientServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notlike 'mlmvpn*' -and $_.InterfaceAlias -notlike 'Loopback*' } | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -like 'fe80*' -or $_ -like '192.168.*' -or $_ -like '10.*' -or $_ -match '^172\\.(1[6-9]|2[0-9]|3[01])\\.' -or $_ -like '169.254.*' } | Select-Object -Unique
    'OK ' + ($lan -join ',')
}
`;
}

/**
 * Stop name lookups escaping to the router while the tunnel is up.
 * @returns {Promise<{ok: boolean, rolledBack?: boolean, blocked?: string[], error?: string}>}
 */
async function blockLanDns({ onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    installRestoreHooks();
    // A rule nothing enforces is a claim, not a lock (see WHEN WINDOWS FIREWALL IS OFF).
    const fw = await ensureEnforcing(log);
    if (!fw.ok) {
        if (fw.reason === 'firewall-disabled') log('جلوگیری از نشت DNS اعمال نشد: دیوارآتش ویندوز خاموش است و هیچ قانونی را اجرا نمی‌کند.');
        return { ok: false, error: fw.reason };
    }
    // Written BEFORE the rules exist, as with the guard: a crash in between must still be
    // undone at startup. No record, no rules — a block nobody can find is the failure with
    // no way back (a PC whose only DNS is its router would have none at all).
    if (!writeDnsState()) {
        log('جلوگیری از نشت DNS فعال نشد: نوشتن فایل وضعیت ممکن نبود.');
        return { ok: false, error: 'state-file' };
    }
    let out = '';
    try {
        out = String(await ps(blockDnsScript())).trim();
    } catch (e) {
        try { await ps(removeDnsRulesScript()); } catch (_) {}
        clearDnsState();
        log(`جلوگیری از نشت DNS فعال نشد: ${e.message}`);
        return { ok: false, error: e.message };
    }
    if (/ROLLED_BACK/.test(out)) {
        clearDnsState();
        log('جلوگیری از نشت DNS برداشته شد: با آن هیچ نامی از داخل تونل هم جواب نمی‌گرفت.');
        return { ok: false, rolledBack: true };
    }
    dnsBlocked = true;
    const blocked = ((out.match(/^OK\s*(.*)$/m) || [])[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    log(blocked.length
        ? `جلوگیری از نشت DNS فعال شد — درخواست‌های DNS به مودم (${blocked.join('، ')}) دیگر بیرون از تونل نمی‌روند.`
        : 'جلوگیری از نشت DNS فعال شد — هیچ درخواست DNS بیرون از تونل نمی‌رود.');
    return { ok: true, blocked };
}

async function unblockLanDns(onLog) {
    if (!dnsBlocked && !hasDnsState()) return;
    try { await ps(removeDnsRulesScript()); } catch (e) {
        // Keep the record: removing it now would throw away the only way to undo a block that
        // may still be in place. The next launch tries again.
        return;
    }
    dnsBlocked = false;
    clearDnsState();
    try { onLog && onLog('جلوگیری از نشت DNS برداشته شد.'); } catch (e) {}
    await releaseEnforcing(onLog);
}

function unblockLanDnsSync() {
    if (!dnsBlocked && !hasDnsState()) return;
    try { ps(removeDnsRulesScript(), { sync: true }); } catch (e) { return; }
    dnsBlocked = false;
    clearDnsState();
}

// ── THE IPv6 LEAK, AND WHY IT NEEDS ITS OWN SWITCH ─────────────────────────────────
//
// Measured on the reporting machine 2026-09-22, with the tunnel up and carrying traffic:
//   Wi-Fi 3   2a02:4540:7057:7ca7:…   (global, from the ISP's router advertisement)
//   ::/0      via fe80::…  on Wi-Fi 3          ← a working native IPv6 default route
// and NO ::/1 + 8000::/1 pair from Tailscale. The exit node has no v6 egress, so Tailscale
// never takes the v6 default route away — it just leaves it there. Every IPv6-capable
// destination is therefore one AAAA record away from being reached over the user's real
// Iranian address while the panel says «connected».
//
// It is not leaking TODAY only because the kill-switch happens to be engaged: that guard
// blocks all IPv6 as a side effect of its allow-list (see the header of this file). So the
// protection against the worst leak this feature has is a side effect of a switch the user
// is free to turn off — and turning the kill-switch off means «I accept a leak if the tunnel
// DROPS», not «I accept my real address on every dual-stack site while it is UP».
//
// Hence a block of its own, on the same terms as the DNS one: independent of the kill
// switch, undone on every exit path, and recorded on disk before the rules exist so a hard
// kill can still be cleaned up at the next launch.
//
// Only 2000::/3 — global unicast — is blocked. Link-local (fe80::/10) and ULA (fc00::/7,
// which is where Tailscale's own fd7a:115c:a1e0::/48 overlay lives) are left alone, so the
// LAN, the router UI and the tunnel's own addressing keep working.

const IPV6_GROUP = 'MLMVPN GitHub Tunnel IPv6';
const IPV6_STATE_FILE = path.join(HOME_DIR, 'gt-ipv6-block.json');
let ipv6Blocked = false;

function writeIpv6State() {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(IPV6_STATE_FILE, JSON.stringify({ blockedAt: Date.now() }), 'utf8');
        return true;
    } catch (e) { return false; }
}
const hasIpv6State = () => { try { return fs.existsSync(IPV6_STATE_FILE); } catch (e) { return false; } };
function clearIpv6State() { try { fs.rmSync(IPV6_STATE_FILE, { force: true }); } catch (e) {} }

const removeIpv6RulesScript = () => `Remove-NetFirewallRule -Group '${IPV6_GROUP}' -ErrorAction SilentlyContinue`;

function blockIpv6Script() {
    return `
$ErrorActionPreference = 'Stop'
${removeIpv6RulesScript()}
# Taking IPv6 away is only safe while IPv4 can carry the machine on its own. On a v6-only
# network this would be the difference between a leak and no internet at all.
if (-not (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)) {
    'NO_V4'
} else {
    New-NetFirewallRule -DisplayName "${RULE_PREFIX}-ipv6-out" -Group '${IPV6_GROUP}' -Direction Outbound -RemoteAddress 2000::/3 -Action Block -Profile Any | Out-Null
    # The addresses that would have been carrying traffic, for the log.
    $a = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notlike 'mlmvpn*' -and $_.IPAddress -notlike 'fe80*' -and $_.IPAddress -notlike 'f[cd]*' } | Select-Object -ExpandProperty IPAddress -Unique
    'OK ' + ($a -join ',')
}
`;
}

/**
 * Stop IPv6 reaching the internet outside the tunnel while the tunnel is up.
 * @returns {Promise<{ok: boolean, noV4?: boolean, addresses?: string[], error?: string}>}
 */
async function blockIpv6({ onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    installRestoreHooks();
    const fw = await ensureEnforcing(log);
    if (!fw.ok) {
        if (fw.reason === 'firewall-disabled') log('قفل IPv6 اعمال نشد: دیوارآتش ویندوز خاموش است و هیچ قانونی را اجرا نمی‌کند.');
        return { ok: false, error: fw.reason };
    }
    if (!writeIpv6State()) {
        log('قفل IPv6 فعال نشد: نوشتن فایل وضعیت ممکن نبود.');
        return { ok: false, error: 'state-file' };
    }
    let out = '';
    try {
        out = String(await ps(blockIpv6Script())).trim();
    } catch (e) {
        try { await ps(removeIpv6RulesScript()); } catch (_) {}
        clearIpv6State();
        log(`قفل IPv6 فعال نشد: ${e.message}`);
        return { ok: false, error: e.message };
    }
    if (/NO_V4/.test(out)) {
        clearIpv6State();
        log('قفل IPv6 اعمال نشد: این شبکه مسیر IPv4 ندارد و بستن IPv6 اینترنت را قطع می‌کرد.');
        return { ok: false, noV4: true };
    }
    ipv6Blocked = true;
    const addresses = ((out.match(/^OK\s*(.*)$/m) || [])[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    log(addresses.length
        ? `قفل IPv6 فعال شد — آدرس واقعی IPv6 شما (${addresses.join('، ')}) دیگر به هیچ سایتی نمی‌رسد.`
        : 'قفل IPv6 فعال شد — هیچ ترافیک IPv6 بیرون از تونل نمی‌رود.');
    return { ok: true, addresses };
}

async function unblockIpv6(onLog) {
    if (!ipv6Blocked && !hasIpv6State()) return;
    try { await ps(removeIpv6RulesScript()); } catch (e) { return; }
    ipv6Blocked = false;
    clearIpv6State();
    try { onLog && onLog('قفل IPv6 برداشته شد.'); } catch (e) {}
    await releaseEnforcing(onLog);
}

function unblockIpv6Sync() {
    if (!ipv6Blocked && !hasIpv6State()) return;
    try { ps(removeIpv6RulesScript(), { sync: true }); } catch (e) { return; }
    ipv6Blocked = false;
    clearIpv6State();
}

/**
 * Undo a guard that outlived the process that engaged it.
 *
 * Called once at startup, before anything else this feature does. If the previous run was
 * killed while engaged, this is the ONLY thing standing between the user and a PC that
 * has no internet for reasons nothing on screen explains — so it runs even when the app
 * has no session, no GitHub account, and the user has never opened the panel.
 *
 * @returns {Promise<{restored: boolean, error?: string}>}
 */
async function restoreIfStale(onLog) {
    // The DNS block first and on its own: it does not depend on the guard's record, and a
    // machine left with it (and a router as its only DNS) cannot resolve anything.
    if (hasDnsState()) {
        try {
            await ps(removeDnsRulesScript());
            clearDnsState();
            try { onLog && onLog('قانون جلوگیری از نشت DNS که از اجرای قبلی باقی مانده بود برداشته شد.'); } catch (e) {}
        } catch (e) { /* the record stays; the next launch tries again */ }
    }
    // Same treatment, same reason: a machine left with IPv6 blocked by a run that never got
    // to clean up would quietly lose every v6-only destination with nothing to explain it.
    if (hasIpv6State()) {
        try {
            await ps(removeIpv6RulesScript());
            clearIpv6State();
            try { onLog && onLog('قفل IPv6 که از اجرای قبلی باقی مانده بود برداشته شد.'); } catch (e) {}
        } catch (e) { /* the record stays; the next launch tries again */ }
    }
    const stale = readStateFile();
    if (stale) {
        savedOutboundActions = stale;
        try {
            await ps(buildRestoreScript());
        } catch (e) {
            // Leave the file in place: not restoring is recoverable on the next launch, losing
            // the record is not.
            savedOutboundActions = null;
            return { restored: false, error: e.message };
        }
        engaged = false;
        savedOutboundActions = null;
        clearStateFile();
        try { onLog && onLog('محافظ نشت که از اجرای قبلی باقی مانده بود برداشته شد — اینترنت سیستم آزاد شد.'); } catch (e) {}
    }
    // Last, after every rule it was held for: the profiles a crashed run switched on go back off.
    const lease = readFwState();
    if (lease) {
        try {
            await ps(fwRestoreScript(lease));
            clearFwState();
            try { onLog && onLog('دیوارآتش ویندوز که اجرای قبلی موقتاً روشن کرده بود، به حالت قبلش برگشت.'); } catch (e) {}
        } catch (e) { /* the record stays; the next launch tries again */ }
    }
    return { restored: !!stale };
}

function isEngaged() { return engaged; }

function isDnsBlocked() { return dnsBlocked; }

function isIpv6Blocked() { return ipv6Blocked; }

module.exports = {
    engage, disengage, disengageSync, restoreIfStale, isEngaged, STATE_FILE,
    // Windows Firewall switched off: what the panel shows, and the user's one explicit choice.
    setFirewallPolicy, firewallStatus, refreshFirewall, FW_STATE_FILE,
    blockLanDns, unblockLanDns, unblockLanDnsSync, isDnsBlocked, DNS_STATE_FILE, DNS_GROUP,
    blockIpv6, unblockIpv6, unblockIpv6Sync, isIpv6Blocked, IPV6_STATE_FILE, IPV6_GROUP,
};
