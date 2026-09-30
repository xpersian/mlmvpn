// --- account-patches.js — changes to the Cloud window's accounts that come from the server side ---
//
// cf_accounts (BPB's url/uuid/…, Edge's edgeUrl/edgeUuid, Zeus's zeusUrl) belongs to the renderer: it
// is its list, saved from its memory, and a write from here would be overwritten by its next save.
// So whatever the server learns about an account — a panel the arena installed, the account's panel
// registry saying the phone's BPB is the one (panel-registry.js) — is QUEUED here, on disk until the
// window has merged it (the app may close first), and read over REST only: the /ws broadcast is
// readable by any local process, and these fields are the panels' UUIDs and passwords.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.mlmvpn', 'account-patches.json');
const OLD = path.join(os.homedir(), '.mlmvpn', 'arena-account-patches.json');   // before 1.2.5's registry

function read(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return []; } }
function write(v) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(v));
    fs.renameSync(FILE + '.tmp', FILE);
}

function pending() {
    const old = read(OLD);
    if (old.length) { write(read(FILE).concat(old)); try { fs.unlinkSync(OLD); } catch (e) { /* gone */ } }
    return read(FILE);
}

/** Queue `fields` for account `accId`. `source` says who asked (arena | registry), for the log only. */
function push(accId, fields, source = '') {
    if (!accId || !fields || !Object.keys(fields).length) return null;
    const p = { id: accId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6), accId, fields, source, at: Date.now() };
    write(pending().concat([p]));
    return p.id;
}

function ack(ids) { const s = new Set(ids || []); write(pending().filter((p) => !s.has(p.id))); }

module.exports = { pending, push, ack, FILE };
