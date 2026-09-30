// --- «میدان کانفیگ» — the race window (Android 1.2.36 › ۴.۵–۴.۷) ---
//
// Scenes: lobby (teams, Quick/Full, sound switch, history) → confirmation (what will be installed)
// → preparation (panels + the «آی‌پی تمیز یکسان» row) → intro (each team 480 ms, then all with VS)
// → F1 start lights (5 reds 600 ms apart, a random 350–900 ms hold, out → «برو!») → the live track
// (ALWAYS left-to-right, even in RTL; car at progress × (0.55 + 0.45 × relative score), springy;
// emoji moods on the car's shoulder for ~1.8 s) → the chequered flag → podium 2-1-3 (LTR) with
// one burst of confetti → the result page. Colour only where it means something: red lights, the
// green «GO», red for a retirement, gold/silver/bronze, blue progress. No adjustment of any score.
// Sounds are synthesised with WebAudio (no files), volume 0.35, and the mute switch is remembered.
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d, minimumFractionDigits: d }));
    const LTR = (s) => '⁦' + s + '⁩';
    const TEAMS = { BPB: ['#0A84FF', 'B'], EDG: ['#30D158', 'E'], ZEU: ['#FFD60A', 'Z'], NHN: ['#BF5AF2', 'N'], MLM: ['#FF9F0A', 'M'], SPD: ['#FF375F', 'S'], NTR: ['#9B59F6', 'Nt'], GZG: ['#40C8E0', 'G'], NVA: ['#5E5CE6', 'Nv'] };
    const TEAM_NAME = { BPB: 'BPB', EDG: 'Edge', ZEU: 'Zeus', NHN: 'Nahan', MLM: 'MLM', SPD: 'Spider', NTR: 'Netra', GZG: 'Gozargah', NVA: 'Nova' };
    const PHASES = ['QUALIFY', 'LATENCY', 'REACH', 'SPEED', 'STABILITY'];
    const PHASE_FA = { PREPARING: 'آماده‌سازی', CONFIGS: 'گرفتن کانفیگ', CLEAN_IP: 'آی‌پی تمیز یکسان', QUALIFY: 'تعیین صلاحیت', LATENCY: 'تأخیر', REACH: 'دسترسی', SPEED: 'سرعت', STABILITY: 'پایداری' };
    const CAT_FA = { OVERALL: 'بهترین کلی', LATENCY: 'کم‌تأخیرترین', SPEED: 'سریع‌ترین', STABLE: 'پایدارترین', REACH: 'بهترین دسترسی' };

    const st = {
        scene: 'lobby', accId: null, mode: 'QUICK', plan: null, server: null, live: null, latest: null,
        history: [], shown: null, poll: null, introDone: false, finaleDone: false, moods: {}, err: '',
    };
    let root = null;

    // ── sounds ───────────────────────────────────────────────────────────────
    let actx = null;
    const soundOn = () => { try { return localStorage.getItem('arena-sound') !== 'off'; } catch (e) { return true; } };
    function ctx() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } } return actx; }
    function tone(freq, startMs, lenMs, { square = false, fade = true } = {}) {
        const c = ctx();
        if (!c) return;
        const t0 = c.currentTime + startMs / 1000;
        const g = c.createGain();
        g.connect(c.destination);
        const vol = 0.35;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(vol, t0 + (square ? 0.005 : 0.004));
        if (fade) g.gain.exponentialRampToValueAtTime(0.0008, t0 + lenMs / 1000);
        else { g.gain.setValueAtTime(vol, t0 + lenMs / 1000 - 0.005); g.gain.linearRampToValueAtTime(0, t0 + lenMs / 1000); }
        // A soft square from odd harmonics (1, ⅓·3f, ⅕·5f) for the start beeps; a chime otherwise.
        const parts = square ? [[1, 1], [3, 1 / 3], [5, 1 / 5]] : [[1, 1], [2, 0.25]];
        for (const [h, a] of parts) {
            const o = c.createOscillator();
            const og = c.createGain();
            og.gain.value = a / (square ? 1.53 : 1.25);
            o.frequency.value = freq * h;
            o.connect(og); og.connect(g);
            o.start(t0); o.stop(t0 + lenMs / 1000 + 0.02);
        }
    }
    function cue(name) {
        if (!soundOn()) return;
        const c = ctx(); if (c && c.state === 'suspended') c.resume();
        switch (name) {
            case 'TICK': tone(1318.5, 0, 45); break;
            case 'LIGHT': tone(660, 0, 230, { square: true, fade: false }); break;
            case 'START': tone(1320, 0, 750, { square: true, fade: false }); break;
            case 'OUT': tone(392, 0, 140); tone(311.1, 90, 200); break;
            case 'FINISH': tone(1046.5, 0, 120); tone(1318.5, 90, 180); break;
            case 'WIN': tone(523.3, 0, 180); tone(659.3, 110, 180); tone(784, 220, 200); tone(1046.5, 330, 420); break;
        }
    }

    // ── moods (Android ArenaMoods.kt) ────────────────────────────────────────
    const moodSt = { lastRank: {}, everLed: new Set(), out: new Set(), final: false, lastPhase: null };
    function moodUpdate(order, gaps, retired, progress, phase) {
        const out = {};
        const say = (id, e) => { if (!out[id]) out[id] = e; };
        for (const id of retired) if (!moodSt.out.has(id)) say(id, '😵');
        moodSt.out = new Set(retired);
        const rank = Object.fromEntries(order.map((id, i) => [id, i]));
        const last = order.length - 1;
        const prevSize = Object.keys(moodSt.lastRank).length;
        if (prevSize && order.length >= 2) {
            for (const [id, r] of Object.entries(rank)) {
                const before = moodSt.lastRank[id];
                if (before == null) continue;
                if (r < before && r === 0) say(id, moodSt.everLed.has(id) ? '😤' : '🚀');
                else if (r < before && before === prevSize - 1) say(id, '🤩');
                else if (r < before) say(id, '😎');
                else if (r > before && before === 0) say(id, '😱');
                else if (r > before && r === last) say(id, '😰');
                else if (r > before) say(id, '😠');
            }
        }
        if (order[0]) moodSt.everLed.add(order[0]);
        if (!moodSt.final && progress >= 0.75 && order.length >= 2) {
            moodSt.final = true;
            say(order[0], '🏆');
            say(order[1], ((gaps[order[0]] || 0) - (gaps[order[1]] || 0)) <= 6 ? '🔥' : '😬');
            if (order.length >= 3) say(order[last], '😓');
        } else if (phase !== moodSt.lastPhase && moodSt.lastPhase != null && order.length) {
            if (moodSt.lastRank[order[0]] === 0) say(order[0], '😏');
        }
        moodSt.lastPhase = phase;
        moodSt.lastRank = rank;
        const now = Date.now();
        for (const [id, e] of Object.entries(out)) st.moods[id] = { e, at: now };
    }

    // ── talking to the server ────────────────────────────────────────────────
    async function post(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || ('خطای ' + r.status));
        return j;
    }
    async function pull() {
        try {
            const r = await fetch('/api/arena/state');
            const j = await r.json();
            if (!j.ok) return;
            const prev = st.server;
            st.server = j.state; st.live = j.live; st.latest = j.latest;
            onState(prev, j.state);
        } catch (e) { /* next tick */ }
    }
    function startPolling() { stopPolling(); st.poll = setInterval(pull, 700); pull(); }
    function stopPolling() { if (st.poll) clearInterval(st.poll); st.poll = null; }

    const accounts = () => { try { return JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]'); } catch (e) { return []; } };

    // ── state machine ─────────────────────────────────────────────────────────
    // BPB / Edge installed by the race: merged into the Cloud window's accounts (cf_accounts is the
    // renderer's; the server only reports what the install produced). Each patch applies once.
    let patching = false;
    async function applyAccountPatches() {
        if (patching) return;
        patching = true;
        try {
            const j = await (await fetch('/api/arena/account-patches')).json();
            const todo = (j && j.patches) || [];
            if (!todo.length) return;
            const list = accounts();
            for (const p of todo) {
                const a = list.find((x) => String(x.id) === String(p.accId));
                if (a) Object.assign(a, p.fields);
            }
            PersistentStorage.setItem('cf_accounts', JSON.stringify(list));
            await post('/api/arena/account-patches/ack', { ids: todo.map((p) => p.id) });
            try { if (typeof window.renderCloudAccounts === 'function') window.renderCloudAccounts(); } catch (e) {}
        } catch (e) { /* next state */ } finally { patching = false; }
    }
    // Left over from a race the app closed during: merged on the next start.
    setTimeout(applyAccountPatches, 4000);

    function onState(prev, s) {
        if (!s) return;
        if (s.phase !== 'IDLE') applyAccountPatches();
        if (s.phase === 'IDLE') { if (st.scene !== 'lobby' && st.scene !== 'confirm' && st.scene !== 'result') { st.scene = 'lobby'; } paint(); return; }
        // Newly out: the soft «out» sound.
        if (prev && prev.lanes) {
            for (const l of s.lanes) { const p = prev.lanes.find((x) => x.id === l.id); if (p && p.lane !== 'OUT' && l.lane === 'OUT' && st.scene === 'track') cue('OUT'); }
        }
        if (PHASES.includes(s.phase) && !st.introDone && st.scene === 'prepare') { st.introDone = true; runIntro(); return; }
        if (s.phase === 'DONE' && !st.finaleDone && (st.scene === 'track' || st.scene === 'prepare')) { st.finaleDone = true; runFinale(); return; }
        if (st.scene === 'track') {
            const order = (st.live && st.live.standings || []).filter((x) => measured(x.id)).map((x) => x.id);
            const gaps = Object.fromEntries((st.live && st.live.standings || []).map((x) => [x.id, x.total]));
            moodUpdate(order, gaps, s.lanes.filter((l) => l.lane === 'OUT').map((l) => l.id), overall(s), s.phase);
        }
        if (st.scene !== 'intro' && st.scene !== 'lights' && st.scene !== 'podium') paint();
    }
    const measured = (id) => { const l = st.server && st.server.lanes.find((x) => x.id === id); return !!(l && l.entry && (l.entry.latency || []).some((s) => s.ms > 0)); };
    function overall(s) {
        const i = PHASES.indexOf(s.phase);
        const n = s.mode === 'FULL' ? 5 : 3;
        if (s.phase === 'DONE') return 1;
        if (i < 0) return 0;
        return Math.min(1, (i + (s.progress || 0)) / n);
    }

    // ── scenes ────────────────────────────────────────────────────────────────
    function teamTile(id, size = 44, name) {
        const t = TEAMS[id] || ['#8E8E93', '?'];
        return `<span class="ar-tile" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px">${t[1]}</span>${name ? `<b>${esc(name)}</b>` : ''}`;
    }

    function lobby() {
        const accs = accounts();
        if (!st.accId && accs[0]) st.accId = accs[0].id;
        const last = st.latest;
        const hist = st.history.slice(0, 8);
        return `
<div class="ar-scene ar-lobby">
  <div class="ar-hero"><svg class="ar-cup" viewBox="0 0 24 24"><use href="#g-trophy"/></svg><h1>میدان کانفیگ</h1>
    <p>پنل‌های ابری شما روی یک آی‌پی تمیز یکسان با اندازه‌گیری واقعی مسابقه می‌دهند. هیچ دستکاری‌ای در امتیاز نیست.</p></div>
  ${accs.length > 1 ? `<div class="ar-row"><label>حساب</label><select id="ar-acc">${accs.map((a) => `<option value="${esc(a.id)}" ${a.id === st.accId ? 'selected' : ''}>${esc(a.email || a.name)}</option>`).join('')}</select></div>` : ''}
  ${!accs.length ? '<div class="ar-warn">اول در بخش ابری یک حساب کلادفلر اضافه کنید.</div>' : ''}
  <div class="ar-teams">${Object.keys(TEAMS).map((id) => `<div class="ar-team">${teamTile(id, 52)}<small>${esc(TEAM_NAME[id] || id)}</small></div>`).join('')}</div>
  <div class="ar-actions">
    <button type="button" class="ar-btn is-primary" data-ar="go-QUICK" ${accs.length && !st.planning ? '' : 'disabled'}>مسابقهٔ سریع<small>صلاحیت، تأخیر و دسترسی · حدود ۱٫۵ دقیقه</small></button>
    <button type="button" class="ar-btn" data-ar="go-FULL" ${accs.length && !st.planning ? '' : 'disabled'}>مسابقهٔ کامل<small>به‌اضافهٔ سرعت و پایداری · حدود ۴ دقیقه</small></button>
  </div>
  ${st.planning ? '<div class="ar-note">بررسی پنل‌های حساب و هماهنگی با گوشی…</div>' : ''}
  <div class="ar-actions" style="display:none">
  </div>
  <label class="ar-sound"><input type="checkbox" data-ar="sound" ${soundOn() ? 'checked' : ''}> صدا</label>
  ${last ? `<div class="ar-note">نتیجهٔ فعلی این شبکه: <b>${esc(nameOf(last.board && last.board.standings[0] && last.board.standings[0].id, last))}</b> · ${new Date(last.finishedAt).toLocaleString('fa-IR')} <button type="button" class="ar-link" data-ar="show-${esc(last.id)}">دیدن</button></div>` : ''}
  ${hist.length ? `<div class="ar-hist"><h3>تاریخچه</h3>${hist.map((h) => `<button type="button" class="ar-hrow" data-ar="show-${esc(h.id)}"><span>${new Date(h.startedAt).toLocaleString('fa-IR')}</span><span>${h.mode === 'FULL' ? 'کامل' : 'سریع'} · ${esc(h.networkLabel || '')}</span><b>${esc(nameOf(h.board && h.board.standings[0] && h.board.standings[0].id, h))}</b></button>`).join('')}</div>` : ''}
  <p class="ar-dim">هر نُه پنل — BPB، Edge، زئوس، نهان، MLM، اسپایدر، نترا، گذرگاه و نوا — اگر روی حساب نصب نباشند، خود مسابقه نصبشان می‌کند (BPB ایمیل حساب کلادفلر را لازم دارد). زئوس همان پنل و دیتابیس موجود حساب را دوباره به کار می‌برد.</p>
</div>`;
    }
    const nameOf = (id, sess) => { if (!id) return '—'; const e = sess && sess.entries && sess.entries.find((x) => x.id === id); return (e && e.name) || id; };

    function confirmScene() {
        const p = st.plan || [];
        const word = { NONE: 'آماده', INSTALL: 'نصب می‌شود', SKIP: 'نصب نیست — شرکت نمی‌کند' };
        return `
<div class="ar-scene ar-confirm">
  <h2>${st.mode === 'FULL' ? 'مسابقهٔ کامل' : 'مسابقهٔ سریع'}</h2>
  <div class="ar-list">${p.map((x) => `<div class="ar-li ${x.action === 'SKIP' ? 'is-dim' : ''}">${teamTile(x.id, 34, x.name)}<span>${esc(x.action === 'SKIP' && x.note ? x.note : word[x.action])}</span></div>`).join('')}</div>
  <p class="ar-dim">نصب‌ها روی حساب کلادفلر خودتان و از آخرین کد سازندهٔ هر پنل انجام می‌شود. برای مسابقه در پنل‌هایی که کاربر دارند، کاربری به نام <b dir="ltr">mlmvpn-arena</b> ساخته می‌شود تا به کاربران خودتان دست نخورد.</p>
  ${st.err ? `<div class="ar-warn">${esc(st.err)}</div>` : ''}
  <div class="ar-actions"><button type="button" class="ar-btn" data-ar="back">انصراف</button><button type="button" class="ar-btn is-primary" data-ar="start" ${p.some((x) => x.action !== 'SKIP') ? '' : 'disabled'}>شروع</button></div>
</div>`;
    }

    function prepareScene() {
        const s = st.server || { lanes: [] };
        const laneWord = { WAITING: 'در صف', PIT: 'در پیت', READY: 'آماده', OUT: 'کنار رفت', RACING: 'آماده', FINISHED: 'آماده' };
        const ci = s.cleanIp;
        return `
<div class="ar-scene ar-prepare">
  <h2>${esc(PHASE_FA[s.phase] || 'آماده‌سازی')}</h2>
  <div class="ar-bar"><span style="width:${Math.round((s.progress || 0) * 100)}%"></span></div>
  <div class="ar-list">${s.lanes.map((l) => `<div class="ar-li ${l.lane === 'OUT' ? 'is-out' : ''}">${teamTile(l.id, 34, l.name)}<span>${esc(l.note || laneWord[l.lane] || '')}</span></div>`).join('')}
    <div class="ar-li ar-ipli"><span class="ar-tile" style="width:34px;height:34px">IP</span><b>آی‌پی تمیز یکسان</b>
      <span>${ci ? `${LTR(esc(ci.ip))} · ${fa(ci.ms)} میلی‌ثانیه${ci.mbps ? ` · ${fa(ci.mbps, 1)} مگابیت` : ''}` : esc(s.cleanNote || 'در انتظار')}</span></div>
  </div>
  <div class="ar-actions"><button type="button" class="ar-btn" data-ar="cancel">توقف مسابقه</button></div>
</div>`;
    }

    function trackScene() {
        const s = st.server;
        const live = (st.live && st.live.standings) || [];
        const best = Math.max(1e-9, ...live.map((x) => x.total));
        const prog = overall(s);
        const phaseI = PHASES.indexOf(s.phase);
        const n = s.mode === 'FULL' ? 5 : 3;
        const now = Date.now();
        const lanes = s.lanes.filter((l) => l.lane !== 'WAITING');
        const rows = lanes.map((l) => {
            const e = l.entry || {};
            const sd = live.find((x) => x.id === l.id);
            const rel = sd && measured(l.id) ? sd.total / best : 0;
            const out = l.lane === 'OUT';
            const x = out ? Math.max(0.04, prog * 0.3) : Math.max(0.02, prog * (0.55 + 0.45 * rel));
            const lat = (e.latency || []).map((q) => q.ms).filter((v) => v > 0).sort((a, b) => a - b);
            const med = lat.length ? lat[Math.floor(lat.length / 2)] : null;
            const metrics = [med ? `${fa(med)}ms` : null, e.reachTried ? (e.reachMs ? 'CF ✓' : 'CF ✗') : null, e.mbps != null ? `${e.mbps.toFixed(1)} Mbps` : null]
                .filter(Boolean).join(' · ');
            const mood = st.moods[l.id] && now - st.moods[l.id].at < 1800 ? st.moods[l.id] : null;
            return `<div class="ar-lane ${out ? 'is-out' : ''}">
                <div class="ar-lane-head"><b>${esc(l.name)}</b><span>${metrics ? LTR(esc(metrics)) : ''}</span><i>${sd && measured(l.id) ? fa(sd.total, 0) : '—'}</i></div>
                <div class="ar-road" dir="ltr"><span class="ar-finish"></span>
                  <span class="ar-car" style="left:calc(${(x * 100).toFixed(1)}% - 22px)">${teamTile(l.id, 30)}${mood ? `<em class="ar-mood" style="animation-delay:-${now - mood.at}ms">${mood.e}</em>` : ''}</span></div>
                ${out ? `<div class="ar-why">${esc(l.note || 'کنار رفت')}</div>` : ''}</div>`;
        }).join('');
        return `
<div class="ar-scene ar-track">
  <div class="ar-track-head"><span>مرحلهٔ ${fa(Math.max(1, phaseI + 1))} از ${fa(n)} · <b>${esc(PHASE_FA[s.phase] || '')}</b></span>
    <span>${s.cleanIp ? `همه روی آی‌پی ${LTR(esc(s.cleanIp.ip))}` : ''}</span>
    <button type="button" class="ar-link" data-ar="cancel">توقف</button></div>
  <div class="ar-bar"><span style="width:${Math.round(prog * 100)}%"></span></div>
  <div class="ar-lanes">${rows}</div>
</div>`;
    }

    function podiumHtml(sess, animate) {
        const b = sess.board || { standings: [] };
        const top = b.standings.slice(0, 3);
        const order = [top[1], top[0], top[2]];   // 2-1-3, always LTR
        const cls = ['is-silver', 'is-gold', 'is-bronze'];
        const h = [110, 150, 80];
        return `<div class="ar-podium ${animate ? 'is-anim' : ''}" dir="ltr">${order.map((sd, i) => sd ? `
            <div class="ar-step ${cls[i]}"><div class="ar-step-team">${teamTile(sd.id, 46)}<b>${esc(nameOf(sd.id, sess))}</b></div>
              <div class="ar-block" style="height:${h[i]}px"><span>${fa(sd.total, 0)}</span><small>${i === 1 ? '۱' : i === 0 ? '۲' : '۳'}</small></div></div>` : '<div class="ar-step"></div>').join('')}</div>`;
    }

    function resultScene() {
        const sess = st.shown || (st.server && st.server.session);
        if (!sess) return lobby();
        const b = sess.board || { standings: [], categories: {}, weights: {} };
        const win = b.standings[0];
        const winEntry = win && sess.entries.find((e) => e.id === win.id);
        const outs = sess.entries.filter((e) => e.fail);
        const W = { latency: 'تأخیر', reach: 'دسترسی', speed: 'سرعت', stability: 'پایداری' };
        const why = win ? Object.entries(win.parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${W[k]} ${fa(v, 0)} از ۱۰۰`).join('، ') : '';
        const row = (sd, i) => {
            const e = sess.entries.find((x) => x.id === sd.id) || {};
            const lat = (e.latency || []).map((q) => q.ms).filter((v) => v > 0).sort((a, b) => a - b);
            const stab = e.stability || [];
            return `<tr><td>${fa(i + 1)}</td><td>${teamTile(sd.id, 24, e.name)}</td><td>${fa(sd.total, 1)}</td>
              <td>${lat.length ? fa(lat[Math.floor(lat.length / 2)]) : '—'}</td><td>${e.reachTried ? (e.reachMs ? fa(e.reachMs) : '✗') : '—'}</td>
              <td${e.mbps == null && e.speedTried ? ' title="دانلود آزمایشی، دو بار پشت‌سرهم، نرسید"' : ''}>${e.mbps != null ? fa(e.mbps, 2) : (e.speedTried ? '✗' : '—')}</td><td>${stab.length ? `${fa(stab.filter((s) => s.ms > 0).length)}/${fa(stab.length)}` : '—'}</td></tr>`;
        };
        return `
<div class="ar-scene ar-result">
  ${podiumHtml(sess, false)}
  <div class="ar-meta">${new Date(sess.finishedAt).toLocaleString('fa-IR')} · ${esc(sess.networkLabel || '')} · ${sess.mode === 'FULL' ? 'کامل' : 'سریع'}${sess.cleanIp ? ` · آی‌پی ${LTR(esc(sess.cleanIp))}` : ' · هر پنل روی نشانی خودش'}</div>
  <div class="ar-actions">
    ${winEntry ? '<button type="button" class="ar-btn is-primary" data-ar="connect">اتصال به برنده</button>' : ''}
    ${winEntry ? '<button type="button" class="ar-btn" data-ar="save">ذخیره در برنامه</button>' : ''}
    ${b.standings.length >= 2 ? '<button type="button" class="ar-btn" data-ar="rematch">مسابقهٔ دوباره دو نفر اول</button>' : ''}
    <button type="button" class="ar-btn" data-ar="share">اشتراک نتیجه</button>
    <button type="button" class="ar-btn" data-ar="lobby">لابی</button>
  </div>
  ${st.err ? `<div class="ar-warn">${esc(st.err)}</div>` : ''}
  ${win ? `<p class="ar-why-won"><b>چرا ${esc(nameOf(win.id, sess))} برد:</b> ${esc(why)} (هر دور نسبت به بهترین همان دور).</p>` : '<p class="ar-warn">هیچ پنلی به خط پایان نرسید.</p>'}
  ${Object.keys(b.categories || {}).length ? `<div class="ar-medals">${Object.entries(b.categories).map(([k, id]) => `<span class="ar-medal">🏅 ${esc(CAT_FA[k] || k)}: <b>${esc(nameOf(id, sess))}</b></span>`).join('')}</div>` : ''}
  ${b.standings.length ? `<table class="ar-table"><thead><tr><th>#</th><th>پنل</th><th>امتیاز</th><th>تأخیر (ms)</th><th>دسترسی (ms)</th><th>سرعت (Mbps)</th><th>پایداری</th></tr></thead><tbody>${b.standings.map(row).join('')}</tbody></table>` : ''}
  ${outs.length ? `<div class="ar-outs"><h3>کنار رفته‌ها</h3>${outs.map((e) => `<div class="ar-li is-out">${teamTile(e.id, 28, e.name)}<span>${esc((({ NOT_INSTALLED: 'نصب نشد', NO_CONFIG: 'کانفیگی نداد', INVALID: 'کانفیگ نامعتبر', UNREACHABLE: 'سرور در دسترس نیست', TLS_REFUSED: 'دست‌دادن TLS رد شد', NO_RESPONSE: 'از تونل جوابی نیامد' })[e.fail] || e.fail) + (e.failDetail ? ' — ' + e.failDetail : ''))}</span></div>`).join('')}</div>` : ''}
</div>`;
    }

    // ── the animated scenes ───────────────────────────────────────────────────
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    async function runIntro() {
        st.scene = 'intro';
        const teams = (st.server.lanes || []).filter((l) => l.lane !== 'OUT');
        for (let i = 0; i < teams.length; i++) {
            root.innerHTML = `<div class="ar-scene ar-intro"><div class="ar-intro-one ${i % 2 ? 'from-left' : 'from-right'}">${teamTile(teams[i].id, 132)}<h1>${esc(teams[i].name)}</h1></div></div>`;
            cue('TICK');
            await wait(480);
        }
        root.innerHTML = `<div class="ar-scene ar-intro"><div class="ar-vs">${teams.map((t, i) => `${i ? '<i>VS</i>' : ''}<span>${teamTile(t.id, 64)}<b>${esc(t.name)}</b></span>`).join('')}</div></div>`;
        await wait(1200);
        await runLights();
    }
    async function runLights() {
        st.scene = 'lights';
        const draw = (on, go) => { root.innerHTML = `<div class="ar-scene ar-lights"><div class="ar-gantry">${[0, 1, 2, 3, 4].map((i) => `<span class="${i < on ? 'is-on' : ''}"></span>`).join('')}</div>${go ? '<div class="ar-go">برو!</div>' : ''}</div>`; };
        draw(0);
        for (let i = 1; i <= 5; i++) { await wait(600); draw(i); cue('LIGHT'); }
        await wait(350 + Math.random() * 550);
        draw(0, true); cue('START');
        await wait(900);
        st.scene = 'track'; paint();
    }
    async function runFinale() {
        cue('FINISH');
        root.insertAdjacentHTML('beforeend', '<div class="ar-flag"></div>');
        await wait(1400);
        const sess = st.server.session;
        if (!sess) { st.scene = 'result'; paint(); return; }
        st.scene = 'podium';
        const w = sess.board && sess.board.standings[0];
        root.innerHTML = `<div class="ar-scene ar-podium-scene"><svg class="ar-cup big" viewBox="0 0 24 24"><use href="#g-trophy"/></svg>
            <h1>${w ? esc(nameOf(w.id, sess)) : 'بدون برنده'}</h1>${podiumHtml(sess, true)}<div class="ar-confetti">${Array.from({ length: 70 }, (_, i) => {
                const c = ['#FFD60A', '#FFFFFF', '#C7C7CC'][i % 3];
                return `<i style="left:${Math.random() * 100}%;background:${c};animation-delay:${(Math.random() * 0.6).toFixed(2)}s;animation-duration:${(1.6 + Math.random() * 1.2).toFixed(2)}s;transform:rotate(${Math.round(Math.random() * 360)}deg)"></i>`;
            }).join('')}</div></div>`;
        cue('WIN');
        await wait(3200);
        st.scene = 'result'; st.shown = sess; loadHistory(); paint();
    }

    // ── painting and wiring ───────────────────────────────────────────────────
    function paint() {
        if (!root) return;
        const html = st.scene === 'lobby' ? lobby() : st.scene === 'confirm' ? confirmScene() : st.scene === 'prepare' ? prepareScene()
            : st.scene === 'track' ? trackScene() : st.scene === 'result' ? resultScene() : null;
        if (html == null) return;
        root.innerHTML = html;
        wire();
    }
    async function loadHistory() { try { const j = await (await fetch('/api/arena/history')).json(); st.history = j.history || []; if (st.scene === 'lobby') paint(); } catch (e) {} }

    function wire() {
        const acc = $('ar-acc'); if (acc) acc.onchange = () => { st.accId = acc.value; };
        root.querySelectorAll('[data-ar]').forEach((b) => {
            const k = b.getAttribute('data-ar');
            if (k === 'sound') { b.onchange = () => { try { localStorage.setItem('arena-sound', b.checked ? 'on' : 'off'); } catch (e) {} if (b.checked) cue('TICK'); }; return; }
            b.onclick = async () => {
                st.err = '';
                try {
                    if (k.startsWith('go-')) {
                        // The plan first syncs the account's shared installs (a few seconds): say so.
                        st.mode = k.slice(3); st.planning = true; paint();
                        try { st.plan = (await post('/api/arena/plan', { accId: st.accId })).plan; st.scene = 'confirm'; }
                        finally { st.planning = false; paint(); }
                    }
                    else if (k === 'back' || k === 'lobby') { await post('/api/arena/reset').catch(() => {}); st.scene = 'lobby'; st.shown = null; loadHistory(); paint(); }
                    else if (k === 'start' || k === 'rematch') {
                        const only = k === 'rematch' ? ((st.shown || st.server.session).board.standings.slice(0, 2).map((x) => x.id)) : null;
                        await post('/api/arena/reset').catch(() => {});
                        st.introDone = false; st.finaleDone = false; st.moods = {}; Object.assign(moodSt, { lastRank: {}, everLed: new Set(), out: new Set(), final: false, lastPhase: null });
                        st.server = (await post('/api/arena/start', { accId: st.accId, mode: st.mode, only })).state;
                        st.scene = 'prepare'; paint(); startPolling();
                    } else if (k === 'cancel') { await post('/api/arena/cancel'); st.scene = 'lobby'; paint(); }
                    else if (k.startsWith('show-')) { st.shown = st.history.find((h) => h.id === k.slice(5)) || st.latest; st.scene = 'result'; paint(); }
                    else if (k === 'connect' || k === 'save' || k === 'share') {
                        const sess = st.shown || st.server.session;
                        const w = sess.board.standings[0];
                        const e = sess.entries.find((x) => x.id === w.id);
                        if (k === 'connect') {
                            await post('/api/v2ray/start', { uri: e.uri, useSystemProxy: true, solo: true });
                            if (typeof toast === 'function') toast('به برندهٔ مسابقه (' + e.name + ') وصل شد');
                        } else if (k === 'save') {
                            const bases = JSON.parse(PersistentStorage.getItem('cf_base_configs') || '[]');
                            bases.unshift({ id: 'arena_' + Date.now(), name: `میدان کانفیگ — ${e.name}`, date: new Date().toLocaleString('fa-IR'), configs: [e.uri], metadata: { arena: sess.id } });
                            PersistentStorage.setItem('cf_base_configs', JSON.stringify(bases));
                            if (typeof toast === 'function') toast('در «کانفیگ‌های دریافتی» ذخیره شد');
                        } else {
                            // No address and no key in the shared text.
                            const lines = [`میدان کانفیگ MLM VPN — ${new Date(sess.finishedAt).toLocaleString('fa-IR')} (${sess.mode === 'FULL' ? 'کامل' : 'سریع'})`]
                                .concat(sess.board.standings.map((s, i) => `${i + 1}. ${nameOf(s.id, sess)} — ${s.total.toFixed(1)}`));
                            await navigator.clipboard.writeText(lines.join('\n'));
                            if (typeof toast === 'function') toast('نتیجه کپی شد');
                        }
                    }
                } catch (err) { st.err = err.message; paint(); }
            };
        });
    }

    window.initArenaModule = function () {
        root = $('ls-arena');
        if (!root) return;
        root.classList.add('ar-root');
        loadHistory();
        pull().then(() => {
            const s = st.server;
            if (s && s.phase !== 'IDLE' && s.phase !== 'DONE') { st.introDone = PHASES.includes(s.phase); st.scene = PHASES.includes(s.phase) ? 'track' : 'prepare'; startPolling(); }
            else paint();
        });
    };
    window.arenaRefresh = function () { if (!root) window.initArenaModule(); else { loadHistory(); pull(); } };
    /** The Cloud window's «میدان کانفیگ» card reads the last winner from here. */
    window.arenaLastWinner = async function () {
        try { const j = await (await fetch('/api/arena/state')).json(); const s = j.latest; if (!s || !s.board || !s.board.standings[0]) return null; return nameOf(s.board.standings[0].id, s); } catch (e) { return null; }
    };

    const css = document.createElement('style');
    css.id = 'ar-css';
    css.textContent = `
.ar-root { --ar-bg1:#1C1C1E; --ar-bg2:#000; --ar-lane:#2C2C2E; color:#F2F2F7; background:linear-gradient(180deg,var(--ar-bg1),var(--ar-bg2)); height:100%; overflow:auto; }
.ar-scene { min-height:100%; padding:22px 28px; display:flex; flex-direction:column; gap:14px; position:relative; }
.ar-tile { display:inline-flex; align-items:center; justify-content:center; border-radius:24%; background:#3A3A3C; color:#fff; font-weight:800; flex:none; }
.ar-hero { text-align:center; } .ar-hero h1 { font-size:26px; margin:6px 0; } .ar-hero p, .ar-dim { color:#98989D; font-size:12.5px; line-height:1.8; }
.ar-cup { display:block; margin:0 auto; width:44px; height:44px; color:#FFD60A; } .ar-cup.big { width:96px; height:96px; }
.ar-teams { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; } .ar-team { display:flex; flex-direction:column; align-items:center; gap:6px; color:#C7C7CC; }
.ar-actions { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }
.ar-btn { background:#2C2C2E; color:#fff; border:0; border-radius:12px; padding:10px 18px; font:inherit; font-weight:700; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:2px; }
.ar-btn small { font-weight:400; color:#98989D; font-size:11px; } .ar-btn.is-primary { background:#0A84FF; } .ar-btn.is-primary small { color:#D0E6FF; } .ar-btn[disabled] { opacity:.4; cursor:default; }
.ar-link { background:none; border:0; color:#0A84FF; cursor:pointer; font:inherit; }
.ar-sound { align-self:center; color:#C7C7CC; font-size:13px; } .ar-row { display:flex; gap:8px; align-items:center; justify-content:center; }
.ar-row select { background:#2C2C2E; color:#fff; border:0; border-radius:8px; padding:6px 10px; }
.ar-note { text-align:center; color:#C7C7CC; font-size:13px; } .ar-warn { color:#FF453A; text-align:center; font-size:13px; }
.ar-hist h3, .ar-outs h3 { font-size:13px; color:#98989D; margin:8px 0 4px; }
.ar-hrow { display:grid; grid-template-columns:1.2fr 1fr auto; gap:10px; width:100%; background:#1C1C1E; border:0; color:#E5E5EA; border-radius:10px; padding:8px 12px; margin-bottom:6px; cursor:pointer; font:inherit; text-align:right; }
.ar-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:8px; }
.ar-li { display:flex; align-items:center; gap:10px; background:#1C1C1E; border-radius:12px; padding:10px 12px; font-size:13px; } .ar-li span { color:#98989D; margin-inline-start:auto; text-align:left; }
.ar-li.is-dim { opacity:.45; } .ar-li.is-out span { color:#FF453A; } .ar-ipli { grid-column:1/-1; }
.ar-bar { height:5px; background:#2C2C2E; border-radius:3px; overflow:hidden; } .ar-bar span { display:block; height:100%; background:#0A84FF; transition:width .4s; }
.ar-intro { align-items:center; justify-content:center; }
.ar-intro-one { display:flex; flex-direction:column; align-items:center; gap:12px; animation:ar-in .35s cubic-bezier(.2,1.4,.4,1); } .ar-intro-one.from-left { --dx:-60px; } .ar-intro-one.from-right { --dx:60px; }
.ar-intro-one h1 { font-size:34px; } @keyframes ar-in { from { transform:translateX(var(--dx)); opacity:0; } to { transform:none; opacity:1; } }
.ar-vs { display:flex; flex-wrap:wrap; gap:14px; align-items:center; justify-content:center; } .ar-vs span { display:flex; flex-direction:column; align-items:center; gap:6px; } .ar-vs i { color:#8E8E93; font-style:normal; font-weight:800; }
.ar-lights { align-items:center; justify-content:center; } .ar-gantry { display:flex; gap:18px; background:#0b0b0c; padding:18px 24px; border-radius:18px; }
.ar-gantry span { width:54px; height:54px; border-radius:50%; background:#2C2C2E; box-shadow: inset 0 0 12px #000; } .ar-gantry span.is-on { background:#FF3B30; box-shadow:0 0 24px #FF3B30; }
.ar-go { color:#30D158; font-size:64px; font-weight:900; animation:ar-pop .5s cubic-bezier(.2,1.6,.4,1); } @keyframes ar-pop { from { transform:scale(.4); } to { transform:scale(1); } }
.ar-track-head { display:flex; justify-content:space-between; gap:10px; color:#C7C7CC; font-size:13px; flex-wrap:wrap; }
.ar-lanes { display:flex; flex-direction:column; gap:10px; }
.ar-lane { background:#1C1C1E; border-radius:12px; padding:8px 12px 10px; } .ar-lane.is-out { opacity:.55; }
.ar-lane-head { display:grid; grid-template-columns:auto 1fr auto; gap:10px; font-size:12.5px; color:#98989D; } .ar-lane-head b { color:#fff; } .ar-lane-head i { font-style:normal; color:#fff; font-weight:800; }
.ar-road { position:relative; height:40px; background:var(--ar-lane); border-radius:8px; margin-top:6px; overflow:visible;
  background-image: linear-gradient(90deg, rgba(255,255,255,.18) 50%, transparent 50%); background-size:24px 2px; background-repeat:repeat-x; background-position:0 50%; }
.ar-finish { position:absolute; right:0; top:0; bottom:0; width:12px; opacity:.35; background: repeating-conic-gradient(#fff 0 25%, #000 0 50%) 0 0/6px 6px; }
.ar-car { position:absolute; top:5px; transition:left 1.1s cubic-bezier(.2,1.3,.4,1); } .ar-lane.is-out .ar-car { transform:rotate(-25deg); transition:left 1.1s, transform .6s; }
.ar-mood { position:absolute; top:-18px; right:-12px; font-size:20px; font-style:normal; animation: ar-mood 1.8s both; }
@keyframes ar-mood { 0% { transform:scale(0); opacity:0; } 12% { transform:scale(1.2); opacity:1; } 20% { transform:scale(1); } 83% { opacity:1; } 100% { opacity:0; } }
.ar-why { color:#FF453A; font-size:12px; margin-top:4px; }
.ar-flag { position:absolute; inset:0; pointer-events:none; background: repeating-conic-gradient(#fff 0 25%, #111 0 50%) 0 0/40px 40px; opacity:.9; animation: ar-flag 1.4s ease-in-out both; }
@keyframes ar-flag { from { transform:translateX(100%); } to { transform:translateX(-100%); } }
.ar-podium-scene { align-items:center; overflow:hidden; } .ar-podium-scene h1 { font-size:30px; margin:0; }
.ar-podium { display:grid; grid-template-columns:repeat(3,minmax(90px,160px)); gap:10px; align-items:end; justify-content:center; }
.ar-step { display:flex; flex-direction:column; align-items:center; gap:6px; } .ar-step-team { display:flex; flex-direction:column; align-items:center; gap:4px; }
.ar-block { width:100%; border-radius:10px 10px 0 0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#111; font-weight:900; }
.ar-block span { font-size:20px; } .ar-block small { font-size:26px; }
.is-gold .ar-block { background:#FFD60A; } .is-silver .ar-block { background:#C7C7CC; } .is-bronze .ar-block { background:#C08B5C; }
.ar-podium.is-anim .ar-block { animation: ar-rise .8s cubic-bezier(.2,1.2,.4,1) both; } @keyframes ar-rise { from { transform:scaleY(0); transform-origin:bottom; } to { transform:scaleY(1); transform-origin:bottom; } }
.ar-confetti { position:absolute; inset:0; pointer-events:none; overflow:hidden; } .ar-confetti i { position:absolute; top:-10px; width:7px; height:12px; border-radius:2px; animation: ar-fall linear both; }
@keyframes ar-fall { to { top:110%; } }
.ar-meta { text-align:center; color:#98989D; font-size:12.5px; } .ar-why-won { color:#E5E5EA; font-size:13px; text-align:center; }
.ar-medals { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; } .ar-medal { background:#1C1C1E; border-radius:99px; padding:4px 12px; font-size:12.5px; color:#FFD60A; }
.ar-table { width:100%; border-collapse:collapse; font-size:12.5px; } .ar-table th, .ar-table td { padding:6px 8px; border-bottom:1px solid #2C2C2E; text-align:center; } .ar-table td:nth-child(2) { display:flex; align-items:center; gap:6px; }
@media (max-width: 700px) { .ar-teams { grid-template-columns:repeat(3,1fr); } }
`;
    document.head.appendChild(css);
})();
