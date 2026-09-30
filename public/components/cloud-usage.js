// --- «ابری» › مصرف روزانه — the Screen Time–style module at the top of the Cloud window ---
//
// Android 1.2.36 › ۳.۱. Every account's Worker requests for THIS Iranian week, Saturday to Friday in
// Asia/Tehran, one stacked colour per account; the selected day at full colour, the rest at 45%; a
// dashed green line for the average of the days already past; per account its day's figure against
// the free 100,000 (orange from 80%, red from 95%). An account whose token cannot read analytics
// says «آمار در دسترس نیست», never 0. Data: /api/cloud/usage-week (hourly UTC buckets, 5 min cache).
(function () {
    'use strict';
    const COLORS = ['#0A84FF', '#40C8E0', '#5E5CE6', '#FF9F0A', '#FF375F', '#BF5AF2'];
    const LABELS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
    const FREE = 100000;
    const T = 3.5 * 3600 * 1000;
    const st = { data: null, sel: null, loading: false, err: '' };
    const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Tehran-day index (0 = Saturday) of an hourly UTC bucket; a bucket straddling midnight goes by its middle. */
    function dayOf(hourIso, weekStartMs) { return Math.floor((Date.parse(hourIso) + 30 * 60000 - weekStartMs) / 86400000); }

    function model() {
        const d = st.data;
        const ws = Date.parse(d.weekStart);
        const today = Math.min(6, Math.max(0, Math.floor((Date.parse(d.now) - ws) / 86400000)));
        const accs = d.accounts.map((a, i) => {
            const days = [0, 0, 0, 0, 0, 0, 0];
            if (!a.error) for (const [h, n] of Object.entries(a.hours || {})) { const k = dayOf(h, ws); if (k >= 0 && k < 7) days[k] += n; }
            return { id: a.id, email: a.email, error: a.error, color: COLORS[i % COLORS.length], days };
        });
        const total = [0, 1, 2, 3, 4, 5, 6].map((k) => accs.reduce((s, a) => s + a.days[k], 0));
        const past = total.slice(0, today);
        const avg = past.length ? past.reduce((s, x) => s + x, 0) / past.length : null;
        return { ws, today, accs, total, avg };
    }

    function title(ws, k, today) {
        let s = '';
        try { s = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ws + k * 86400000 + 12 * 3600000)); } catch (e) { s = ''; }
        return (k === today ? 'امروز · ' : '') + s;
    }

    function html() {
        if (!st.data) {
            return `<div class="cu-card"><div class="cu-head"><b>مصرف روزانه</b><span class="cu-dim">${st.loading ? 'در حال خواندن آمار…' : esc(st.err || '')}</span></div></div>`;
        }
        if (!st.data.accounts.length) return '';
        const m = model();
        const sel = st.sel == null ? m.today : st.sel;
        const max = Math.max(1, ...m.total, m.avg || 0);
        const H = 120;
        const cols = [0, 1, 2, 3, 4, 5, 6].map((k) => {
            const future = k > m.today;
            let y = 0;
            const segs = m.accs.map((a) => {
                const h = (a.days[k] / max) * H;
                const s = `<span style="height:${h}px;background:${a.color};opacity:${k === sel ? 1 : 0.45}"></span>`;
                y += h;
                return s;
            }).join('');
            return `<button type="button" class="cu-col${k === sel ? ' is-sel' : ''}" ${future ? 'disabled' : `onclick="window.cloudUsagePick(${k})"`} aria-label="${esc(title(m.ws, k, m.today))}">
                <span class="cu-bar" style="height:${H}px">${segs}</span><small>${LABELS[k]}</small></button>`;
        }).join('');
        const avgLine = m.avg != null ? `<span class="cu-avg" style="bottom:${24 + (m.avg / max) * H}px" title="میانگین روزهای گذشتهٔ این هفته"></span>` : '';
        const rows = m.accs.map((a) => {
            if (a.error) return `<div class="cu-acc"><i style="background:${a.color}"></i><bdi dir="ltr">${esc(a.email)}</bdi><span class="cu-dim">آمار در دسترس نیست</span></div>`;
            const n = a.days[sel];
            const p = Math.min(100, (n / FREE) * 100);
            const tone = p >= 95 ? 'is-red' : p >= 80 ? 'is-orange' : '';
            return `<div class="cu-acc"><i style="background:${a.color}"></i><bdi dir="ltr">${esc(a.email)}</bdi><b>${fa(n)}</b>
                <span class="cu-share ${tone}"><span style="width:${p}%"></span></span></div>`;
        }).join('');
        return `<div class="cu-card">
            <div class="cu-head"><span><small class="cu-dim">${esc(title(m.ws, sel, m.today))}</small><b class="cu-big">${fa(m.total[sel])}</b><small class="cu-dim">درخواست</small></span>
              <button type="button" class="mv-tb-btn" onclick="window.cloudUsageLoad(true)" title="تازه کردن" aria-label="تازه کردن" ${st.loading ? 'disabled' : ''}><i class="ph-bold ph-arrow-clockwise${st.loading ? ' animate-spin' : ''}"></i></button></div>
            <div class="cu-chart" dir="rtl">${cols}${avgLine}</div>
            ${m.avg != null ? `<div class="cu-dim cu-legend"><span class="cu-avg-key"></span> میانگین روزانه: ${fa(Math.round(m.avg))}</div>` : ''}
            <div class="cu-accs">${rows}</div>
            <div class="cu-dim">کلادفلر سهمیهٔ رایگان (۱۰۰٬۰۰۰ درخواست در روز) را ساعت ۳:۳۰ بامداد به وقت تهران صفر می‌کند.</div>
          </div>`;
    }

    function paint() { const el = document.getElementById('cloud-usage-module'); if (el) el.innerHTML = html(); }

    window.cloudUsagePick = function (k) { st.sel = k; paint(); };
    window.cloudUsageLoad = async function (force) {
        if (st.loading) return;
        st.loading = true; paint();
        try {
            const r = await fetch('/api/cloud/usage-week' + (force ? '?force=1' : ''));
            const j = await r.json();
            if (!r.ok || !j.ok) throw new Error(j.error || 'خطا');
            st.data = j; st.err = '';
        } catch (e) { st.err = 'آمار خوانده نشد: ' + e.message; }
        st.loading = false; paint();
    };
    window.cloudUsagePaint = function () { if (!st.data && !st.loading) window.cloudUsageLoad(false); else paint(); };

    const css = document.createElement('style');
    css.id = 'cu-css';
    css.textContent = `
#cloud-usage-module { margin-bottom: 14px; }
.cu-card { background: var(--mv-surface, rgba(127,127,127,.06)); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.cu-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
.cu-head > span { display:flex; flex-direction:column; gap:2px; }
.cu-big { font-size: 28px; font-weight: 800; line-height: 1.1; }
.cu-dim { color: var(--mv-label-2); font-size: 12px; }
.cu-chart { position:relative; display:grid; grid-template-columns: repeat(7, 1fr); gap: 10px; align-items:end; }
.cu-col { background:none; border:0; padding:0; display:flex; flex-direction:column; align-items:center; gap:6px; cursor:pointer; color: var(--mv-label-2); }
.cu-col[disabled] { cursor: default; opacity:.5; }
.cu-col.is-sel small { color: var(--mv-label); font-weight:700; }
.cu-bar { width: min(34px, 80%); display:flex; flex-direction:column-reverse; justify-content:flex-start; border-radius:6px; overflow:hidden; background: var(--mv-fill, rgba(127,127,127,.12)); }
.cu-bar span { display:block; width:100%; transition: height .3s; }
.cu-avg { position:absolute; left:0; right:0; border-top: 2px dashed #30D158; pointer-events:none; }
.cu-legend { display:flex; align-items:center; gap:6px; }
.cu-avg-key { display:inline-block; width:18px; border-top:2px dashed #30D158; }
.cu-accs { display:flex; flex-direction:column; gap:6px; }
.cu-acc { display:grid; grid-template-columns: 10px minmax(0,1.4fr) auto minmax(80px,1fr); gap:8px; align-items:center; font-size:12.5px; }
.cu-acc i { width:10px; height:10px; border-radius:50%; display:inline-block; }
.cu-acc bdi { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cu-share { height:6px; border-radius:3px; background: var(--mv-fill, rgba(127,127,127,.15)); overflow:hidden; }
.cu-share > span { display:block; height:100%; background: var(--mv-accent, #0A84FF); }
.cu-share.is-orange > span { background:#FF9F0A; } .cu-share.is-red > span { background:#FF453A; }
`;
    document.head.appendChild(css);
})();
