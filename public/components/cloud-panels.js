// --- «ابری» › Spider، Netra، Gozargah و Nova — rows on each account card ---
//
// The page half of cloud-panels.js. Each account card gets one row per panel: install (from the
// developer's newest code), «دریافت کانفیگ» (saved as a group like BPB's, so «به V2Ray», combine
// and the assistant work unchanged), remove, and «پنل وب» (Gozargah/Nova copy their password).
// Spider has no web panel of its own here — this app IS its panel — so its row opens an inline
// manager: users (quota, days, concurrent-IP limit), links, the Worker's status and health check,
// and the user's own exit proxies. No pop-ups; results are an inline line under the row.
(function () {
    'use strict';
    const PANELS = [
        { code: 'SPD', title: 'Spider', color: '#FF375F', letter: 'S', sub: 'پنل اسپایدر — این برنامه پنل آن است' },
        { code: 'NTR', title: 'Netra', color: '#9B59F6', letter: 'Nt', sub: 'پنل نترا (فورک BPB)' },
        { code: 'GZG', title: 'Gozargah', color: '#40C8E0', letter: 'G', sub: 'پنل گذرگاه' },
        { code: 'NVA', title: 'Nova', color: '#5E5CE6', letter: 'Nv', sub: 'پنل نوا' },
        { code: 'NHN', title: 'Nahan', color: '#BF5AF2', letter: 'N', sub: 'پنل نهان — کلید و مسیر تصادفی' },
        { code: 'MLM', title: 'MLM', color: '#FF9F0A', letter: 'M', sub: 'پنل MLM — رمز تصادفی' },
    ];
    const status = {};       // accId → { SPD: {installed,…}, … }
    const busy = {};         // accId|code → text
    const note = {};         // accId|code → { tone, html }
    const spider = {};       // accId → { open, users, status, loading }
    // «هماهنگ با گوشی» (panel-registry.js): accId → { state: 'running'|'done'|'error', result, at, error }
    const sync = {};
    const dupNote = {};      // accId|script → { tone, html, confirm }
    const CODE_TITLE = { BPB: 'BPB', EDG: 'Edge', ZEU: 'Zeus', SPD: 'Spider', NTR: 'Netra', GZG: 'Gozargah', NVA: 'Nova', NHN: 'Nahan', MLM: 'MLM' };
    const CODE_COLOR = { BPB: '#0A84FF', EDG: '#30D158', ZEU: '#FFD60A', SPD: '#FF375F', NTR: '#9B59F6', GZG: '#40C8E0', NVA: '#5E5CE6', NHN: '#BF5AF2', MLM: '#FF9F0A' };

    /**
     * What the server learned about an account (the arena installed BPB, the registry says the
     * phone's Edge is the one): merged into the Cloud window's own list, then acknowledged.
     */
    async function applyAccountPatches() {
        try {
            const j = await (await fetch('/api/account-patches')).json();
            const todo = (j && j.patches) || [];
            if (!todo.length) return 0;
            const list = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
            for (const p of todo) { const a = list.find((x) => String(x.id) === String(p.accId)); if (a) Object.assign(a, p.fields); }
            PersistentStorage.setItem('cf_accounts', JSON.stringify(list));
            await post('/api/account-patches/ack', { ids: todo.map((p) => p.id) });
            return todo.length;
        } catch (e) { return 0; }
    }
    window.cloudApplyAccountPatches = applyAccountPatches;

    async function runSync(accId, { quiet = false } = {}) {
        if (sync[accId] && sync[accId].state === 'running') return;
        const accounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
        const acc = accounts.find((a) => a.id === accId);
        if (!acc) return;
        sync[accId] = Object.assign({}, sync[accId], { state: 'running', quiet });
        rerender();
        try {
            // The automatic sync is the quick one (registry ↔ this machine). Looking for duplicates
            // reads every Worker's code on the account — megabytes on a slow line — so only the
            // button does that.
            const r = await post('/api/cloud-panels/sync', { accId, account: { email: acc.email, token: acc.token }, duplicates: !quiet });
            const n = await applyAccountPatches();
            sync[accId] = { state: 'done', result: r, at: Date.now(), patched: n, checkedDups: !quiet };
        } catch (e) {
            sync[accId] = { state: 'error', error: e.message, at: Date.now() };
        }
        loadStatus(accId);
        rerender();
    }
    window.cpSync = function (accId) { runSync(accId); };

    function syncBox(acc) {
        const s = sync[acc.id];
        if (!s) return '';
        const shared = s.result ? Object.entries(s.result.panels || {}).filter(([, v]) => v === 'same' || v === 'from-registry' || v === 'published').map(([k]) => k) : [];
        const fromPhone = s.result ? Object.entries(s.result.panels || {}).filter(([, v]) => v === 'from-registry').map(([k]) => CODE_TITLE[k] || k) : [];
        const dups = (s.result && s.result.duplicates) || [];
        const dupWord = s.state === 'done' && !s.checkedDups ? ' · «هماهنگ‌سازی» نسخه‌های تکراری را هم پیدا می‌کند'
            : s.state === 'done' && !dups.length ? ' · نسخهٔ تکراری روی حساب نیست' : '';
        const head = s.state === 'running' ? '<i class="ph-bold ph-arrows-clockwise animate-spin"></i> در حال هماهنگی با گوشی…'
            : s.state === 'error' ? 'هماهنگی نشد: ' + esc(s.error)
                : `${fa(shared.length)} پنل این حساب بین گوشی و ویندوز مشترک است${fromPhone.length ? ' · تازه از ثبت حساب: ' + esc(fromPhone.join('، ')) : ''}${dupWord}`;
        return `
          <div class="mv-form-row cp-sync">
            <span class="cp-sq" style="background:#8E8E93"><i class="ph-bold ph-arrows-left-right"></i></span>
            <span class="mv-form-label">پنل‌های مشترک با گوشی<small>${head}</small></span>
            <span class="mv-form-control"><button type="button" class="mv-btn" onclick="window.cpSync('${acc.id}')" ${s.state === 'running' ? 'disabled' : ''}>هماهنگ‌سازی</button></span>
          </div>
          ${s.removed ? `<div class="mv-form-row cp-note is-ok"><span>${s.removed}</span></div>` : ''}
          ${dups.length ? `
          <div class="mv-form-row is-stack cp-dups">
            <div class="cp-dim">روی این حساب ${fa(dups.length)} ورکر تکراری هست — پنلی که گوشی و ویندوز قبل از هماهنگی هرکدام جدا ساخته بودند. هر پنل از این به بعد فقط همان یک نصب مشترک را به کار می‌برد؛ این‌ها را می‌توانید پاک کنید تا جای دیتابیس (سقف ۱۰ D1 حساب رایگان) آزاد شود. دیتابیس یا KV فقط وقتی پاک می‌شود که ورکر دیگری از آن استفاده نکند.</div>
            ${dups.map((d) => {
                const k = acc.id + '|' + d.script;
                const n = dupNote[k];
                return `<div class="cp-dup">
                  <span class="cp-sq is-sm" style="background:${CODE_COLOR[d.code] || '#8E8E93'}">${esc((CODE_TITLE[d.code] || d.code).slice(0, 2))}</span>
                  <span><b>${esc(d.title)}</b> <bdi dir="ltr" class="cp-dim">${esc(d.script)}</bdi><small class="cp-dim">${d.d1.length ? 'D1 ' + fa(d.d1.length) : ''}${d.d1.length && d.kv.length ? ' · ' : ''}${d.kv.length ? 'KV ' + fa(d.kv.length) : ''}${!d.d1.length && !d.kv.length ? 'بدون فضای ذخیره' : ''} · نصب اصلی: <bdi dir="ltr">${esc(d.canonical || '—')}</bdi></small></span>
                  <button type="button" class="mv-btn${n && n.confirm ? ' mv-btn--danger' : ''}" onclick="window.cpDupRemove('${acc.id}','${esc(d.script)}')">${n && n.confirm ? 'تأیید حذف' : 'حذف'}</button>
                  ${n ? `<div class="cp-dup-note is-${n.tone}">${n.html}</div>` : ''}
                </div>`;
            }).join('')}
          </div>` : ''}`;
    }

    window.cpDupRemove = async function (accId, script) {
        const k = accId + '|' + script;
        const n = dupNote[k];
        if (!n || !n.confirm) {
            dupNote[k] = { tone: 'warn', confirm: true, html: 'این ورکر و داده‌هایش (کاربران آن نسخه) از حساب پاک می‌شود. برای تأیید دوباره بزنید.' };
            rerender();
            return;
        }
        const accounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
        const acc = accounts.find((a) => a.id === accId) || {};
        dupNote[k] = { tone: 'busy', html: 'در حال حذف…' };
        rerender();
        try {
            const r = await post('/api/cloud-panels/duplicate/remove', { accId, script, account: { email: acc.email, token: acc.token } });
            const freed = (r.freed.d1.length ? fa(r.freed.d1.length) + ' دیتابیس D1' : '') + (r.freed.d1.length && r.freed.kv.length ? ' و ' : '') + (r.freed.kv.length ? fa(r.freed.kv.length) + ' فضای KV' : '');
            delete dupNote[k];
            const s = sync[accId];
            if (s && s.result) s.result.duplicates = (s.result.duplicates || []).filter((d) => d.script !== script);
            // The row goes with the Worker, so the result is said on the sync row itself.
            if (s) s.removed = `<bdi dir="ltr">${esc(script)}</bdi> حذف شد` + (freed ? ' و ' + freed + ' آزاد شد' : '') + '.';
        } catch (e) { dupNote[k] = { tone: 'err', html: esc(e.message) }; }
        rerender();
    };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    async function post(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(j.error || ('خطای ' + r.status));
        return j;
    }
    function rerender() { if (typeof window.renderCloudAccounts === 'function') window.renderCloudAccounts(); }

    async function loadStatus(accId) {
        try {
            const r = await fetch('/api/cloud-panels/status?accId=' + encodeURIComponent(accId));
            const j = await r.json();
            if (r.ok && j.ok) { status[accId] = j.status; rerender(); return; }
        } catch (e) { /* retried below */ }
        // Unanswered is not «nothing installed»: ask again shortly instead of showing a lie for good.
        setTimeout(() => { delete status[accId]; rerender(); }, 8000);
    }
    window.cloudPanelsRefresh = function (accId) { loadStatus(accId); };

    function tag(p, st) {
        if (busy[st.key]) return `<span class="cp-tag is-busy"><i class="ph-bold ph-gear animate-spin"></i> ${esc(busy[st.key])}</span>`;
        return st.installed ? '<span class="cp-tag is-on">نصب شده</span>' : '<span class="cp-tag">نصب نشده</span>';
    }

    function row(acc, p) {
        const s = (status[acc.id] || {})[p.code] || { installed: false };
        const key = acc.id + '|' + p.code;
        const n = note[key];
        const sub = s.installed
            ? (s.configs ? `${fa(s.configs)} کانفیگ گرفته‌اید` : 'هنوز کانفیگی نگرفته‌اید')
            : p.sub;
        const act = (a, label, primary, extra = '') => `<button type="button" class="mv-btn${primary ? ' mv-btn--primary' : ''}" onclick="window.cpAction('${p.code}','${a}','${acc.id}',this)" ${busy[key] ? 'disabled' : ''} ${extra}>${label}</button>`;
        return `
          <div class="mv-form-row cp-row">
            <span class="cp-sq" style="background:${p.color}">${p.letter}</span>
            <span class="mv-form-label">${p.title}<small>${esc(sub)}</small></span>
            <span class="mv-form-control">
              ${tag(p, Object.assign({ key }, s))}
              ${s.installed
                ? act('configs', p.code === 'SPD' ? 'دریافت کانفیگ' : 'دریافت کانفیگ', true)
                    + (p.code === 'SPD' ? act('manage', spider[acc.id] && spider[acc.id].open ? 'بستن مدیریت' : 'مدیریت کاربران', false) : act('web', 'پنل وب', false))
                    + act('deploy', 'بروزرسانی', false, 'title="نصب دوباره از آخرین کد سازنده (تنظیمات و داده‌ها می‌مانند)"')
                    + `<button type="button" class="mv-tb-btn" title="حذف از حساب" aria-label="حذف" onclick="window.cpAction('${p.code}','remove','${acc.id}',this)" ${busy[key] ? 'disabled' : ''}><i class="ph-bold ph-trash"></i></button>`
                : act('deploy', 'نصب', true)}
            </span>
          </div>
          ${n ? `<div class="mv-form-row cp-note is-${n.tone}"><span>${n.html}</span><button type="button" class="mv-tb-btn" onclick="window.cpNoteClose('${key}')" aria-label="بستن"><i class="ph-bold ph-x"></i></button></div>` : ''}
          ${p.code === 'SPD' && s.installed && spider[acc.id] && spider[acc.id].open ? spiderBox(acc) : ''}`;
    }

    function spiderBox(acc) {
        const sp = spider[acc.id];
        const st = sp.status;
        const gb = (b) => (b > 0 ? (b / 1073741824).toFixed(2).replace(/\.00$/, '') + ' GB' : '∞');
        return `
          <div class="mv-form-row is-stack cp-spider">
            <div class="cp-sp-head">
              ${st ? `<span>کاربران ${fa(st.users || 0)} · آنلاین ${fa(st.online || 0)}${st.routing ? ` · خروجی سالم ${fa(st.routing.healthy || 0)} از ${fa(st.routing.tracked || 0)}` : ''}</span>` : '<span>وضعیت ورکر…</span>'}
              <button type="button" class="mv-btn" onclick="window.cpSpider('${acc.id}','check')">بررسی سلامت خروجی‌ها</button>
            </div>
            ${sp.loading ? '<div class="cp-dim">در حال خواندن کاربران…</div>' : (sp.users || []).map((u) => `
              <div class="cp-user">
                <b dir="auto">${esc(u.remark)}</b>
                <small>${gb(u.used_bytes || 0)} از ${gb(u.limit_bytes || 0)} · ${u.expire ? 'تا ' + new Date(u.expire * 1000).toLocaleDateString('fa-IR') : 'بدون انقضا'} · سقف آی‌پی ${u.concurrent_connections ? fa(u.concurrent_connections) : '∞'}</small>
                <span>
                  <button type="button" class="mv-btn" onclick="window.cpSpider('${acc.id}','copy','${u.uuid}')">کپی لینک</button>
                  <button type="button" class="mv-btn" onclick="window.cpSpider('${acc.id}','reset','${u.uuid}')">صفر کردن مصرف</button>
                  <button type="button" class="mv-tb-btn" onclick="window.cpSpider('${acc.id}','delete','${u.uuid}')" aria-label="حذف"><i class="ph-bold ph-trash"></i></button>
                </span>
              </div>`).join('') || '<div class="cp-dim">کاربری نیست.</div>'}
            <div class="cp-sp-form">
              <input id="cp-sp-name-${acc.id}" placeholder="نام کاربر" dir="auto">
              <input id="cp-sp-gb-${acc.id}" type="number" min="0" step="0.5" placeholder="حجم (GB، ۰ = نامحدود)">
              <input id="cp-sp-days-${acc.id}" type="number" min="0" placeholder="روز (۰ = بی‌انقضا)">
              <input id="cp-sp-ip-${acc.id}" type="number" min="0" placeholder="سقف آی‌پی هم‌زمان">
              <button type="button" class="mv-btn mv-btn--primary" onclick="window.cpSpider('${acc.id}','add')">افزودن کاربر</button>
            </div>
            <div class="cp-sp-form">
              <textarea id="cp-sp-exits-${acc.id}" rows="3" dir="ltr" placeholder="socks5://user:pass@host:port DE&#10;http://host:port NL"></textarea>
              <button type="button" class="mv-btn" onclick="window.cpSpider('${acc.id}','exits')">ثبت خروجی‌ها</button>
            </div>
            <div class="cp-dim">خروجی‌ها پراکسی‌های SOCKS5/HTTP خودتان‌اند (هر خط: نشانی و کد کشور). ورکر دوتا را هم‌زمان امتحان می‌کند و سریع‌تر را برای هر کاربر نگه می‌دارد. بدون خروجی، سایت‌هایی که خودشان پشت کلادفلرند باز نمی‌شوند — ورکر نمی‌تواند به آی‌پی کلادفلر وصل شود.</div>
          </div>`;
    }

    /** HTML for the panel rows of one account card; the first call also fetches the status and syncs. */
    window.cloudPanelsRows = function (acc) {
        if (!status[acc.id]) { status[acc.id] = {}; loadStatus(acc.id); }
        // Once per session per account: the account's registry → this machine (and our installs → it).
        if (!sync[acc.id]) setTimeout(() => runSync(acc.id, { quiet: true }), 300);
        return syncBox(acc) + PANELS.map((p) => row(acc, p)).join('');
    };
    window.cloudPanelsLamps = function (acc) {
        const s = status[acc.id] || {};
        return PANELS.map((p) => { const x = s[p.code] || {}; return `<i class="cl-lamp ${x.installed ? (x.configs ? 'is-green' : 'is-yellow') : ''}" title="${p.title}"></i>`; }).join('');
    };
    window.cloudPanelsInstalled = function (acc) {
        const s = status[acc.id] || {};
        return PANELS.filter((p) => s[p.code] && s[p.code].installed).length;
    };
    window.cpNoteClose = function (key) { delete note[key]; rerender(); };

    function saveGroup(p, acc, links) {
        const bases = JSON.parse(PersistentStorage.getItem('cf_base_configs') || '[]');
        const name = `${p.title} — ${acc.email || acc.name || 'Cloudflare'}`;
        bases.unshift({ id: 'cp_' + p.code + '_' + Date.now(), name, date: new Date().toLocaleString('fa-IR'), configs: links, metadata: { panel: p.code } });
        PersistentStorage.setItem('cf_base_configs', JSON.stringify(bases));
        try { if (typeof window.renderCloudReceivedConfigs === 'function') window.renderCloudReceivedConfigs(); } catch (e) {}
        try { if (typeof window.renderBaseConfigs === 'function') window.renderBaseConfigs(); } catch (e) {}
    }

    window.cpAction = async function (code, action, accId, btn) {
        const p = PANELS.find((x) => x.code === code);
        const accounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
        const acc = accounts.find((a) => a.id === accId);
        if (!p || !acc) return;
        const key = accId + '|' + code;
        const say = (tone, html) => { note[key] = { tone, html }; rerender(); };
        try {
            if (action === 'deploy') {
                busy[key] = 'در حال نصب…'; rerender();
                const r = await post(`/api/cloud-panels/${code}/deploy`, { accId, email: acc.email, token: acc.token });
                say('ok', `نصب شد: <bdi dir="ltr">${esc(r.url)}</bdi>${r.version ? ` · نسخهٔ سازنده ${esc(r.version)}` : ''}`);
            } else if (action === 'configs') {
                busy[key] = 'گرفتن کانفیگ…'; rerender();
                let r;
                try { r = await post(`/api/cloud-panels/${code}/configs`, { accId }); }
                catch (e) { r = await post(`/api/cloud-panels/${code}/configs`, { accId }); }   // one retry, as on the phone
                if (!r.configs.length) throw new Error('پنل کانفیگی برنگرداند.');
                saveGroup(p, acc, r.configs);
                say('ok', `${fa(r.configs.length)} کانفیگ گرفته شد و در «کانفیگ‌های دریافتی» ذخیره شد.`);
                if (typeof toast === 'function') toast(`${r.configs.length} کانفیگ از ${p.title}`);
            } else if (action === 'remove') {
                if (note[key] && note[key].confirmRemove) {
                    busy[key] = 'در حال حذف…'; rerender();
                    await post(`/api/cloud-panels/${code}/remove`, { accId, email: acc.email, token: acc.token });
                    say('ok', 'ورکر و داده‌هایش از حساب حذف شد.');
                } else {
                    note[key] = { tone: 'warn', confirmRemove: true, html: `ورکر ${p.title} و داده‌هایش (کاربران، KV/D1) از حساب کلادفلر حذف می‌شود. برای تأیید، دوباره دکمهٔ حذف را بزنید.` };
                    rerender();
                    return;
                }
            } else if (action === 'web') {
                const r = await post(`/api/cloud-panels/${code}/web`, { accId });
                if (r.password) { try { await navigator.clipboard.writeText(r.password); } catch (e) {} }
                window.open(r.url, '_blank');
                say('ok', r.password ? 'پنل وب باز شد و رمز ورودش در کلیپ‌بورد است.' : 'پنل وب باز شد.');
            } else if (action === 'manage') {
                const sp = spider[accId] = spider[accId] || {};
                sp.open = !sp.open;
                rerender();
                if (sp.open) window.cpSpider(accId, 'load');
                return;
            }
        } catch (e) {
            say('err', esc(e.message));
        } finally {
            delete busy[key];
            if (action !== 'remove' || !(note[key] && note[key].confirmRemove)) loadStatus(accId);
        }
    };

    window.cpSpider = async function (accId, action, uuid) {
        const sp = spider[accId] = spider[accId] || { open: true };
        const key = accId + '|SPD';
        const val = (id) => (document.getElementById(id) || {}).value || '';
        try {
            if (action === 'load') {
                sp.loading = true; rerender();
                const [u, s] = await Promise.all([post('/api/cloud-panels/spider/users', { accId }), post('/api/cloud-panels/spider/status', { accId }).catch(() => null)]);
                sp.users = u.users; sp.status = s && s.status;
            } else if (action === 'check') {
                const s = await post('/api/cloud-panels/spider/status', { accId, probe: true });
                sp.status = s.status;
            } else if (action === 'add') {
                const gb = parseFloat(val('cp-sp-gb-' + accId)) || 0, days = parseInt(val('cp-sp-days-' + accId), 10) || 0, ip = parseInt(val('cp-sp-ip-' + accId), 10) || 0;
                const user = { uuid: crypto.randomUUID(), remark: val('cp-sp-name-' + accId).trim() || 'user', limit_bytes: gb > 0 ? Math.round(gb * 1073741824) : 0, used_bytes: 0,
                    expire: days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0, concurrent_connections: Math.max(0, ip), proxy_ips: [] };
                await post('/api/cloud-panels/spider/save', { accId, user });
                sp.users = (await post('/api/cloud-panels/spider/users', { accId })).users;
            } else if (action === 'delete') {
                await post('/api/cloud-panels/spider/delete', { accId, uuid });
                sp.users = (sp.users || []).filter((u) => u.uuid !== uuid);
            } else if (action === 'reset') {
                const u = (sp.users || []).find((x) => x.uuid === uuid);
                if (u) { const copy = Object.assign({}, u); delete copy.link; copy.used_bytes = 0; await post('/api/cloud-panels/spider/save', { accId, user: copy }); u.used_bytes = 0; }
            } else if (action === 'copy') {
                const u = (sp.users || []).find((x) => x.uuid === uuid);
                if (u) { await navigator.clipboard.writeText(u.link); if (typeof toast === 'function') toast('لینک کپی شد'); }
            } else if (action === 'exits') {
                const exits = val('cp-sp-exits-' + accId).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
                    const [proxy, country] = l.split(/\s+/);
                    return { proxy, country: (country || 'XX').toUpperCase() };
                });
                await post('/api/cloud-panels/spider/exits', { accId, exits });
                note[key] = { tone: 'ok', html: `${fa(exits.length)} خروجی ثبت شد.` };
            }
        } catch (e) {
            note[key] = { tone: 'err', html: esc(e.message) };
        } finally {
            sp.loading = false;
            rerender();
        }
    };

    const css = document.createElement('style');
    css.id = 'cp-css';
    css.textContent = `
.cp-row { gap:10px; }
.cp-sq { flex:none; width:30px; height:30px; border-radius:9px; color:#fff; font-weight:700; font-size:12px; display:inline-flex; align-items:center; justify-content:center; }
.cp-tag { font-size:11px; padding:2px 8px; border-radius:99px; background:rgba(142,142,147,.18); color:var(--mv-label-2); white-space:nowrap; }
.cp-tag.is-on { background:rgba(48,209,88,.16); color:var(--mv-green-ink, #248a3d); }
.cp-tag.is-busy { background:rgba(10,132,255,.14); color:var(--mv-blue-ink, #0a60c0); }
.cp-note { font-size:12.5px; line-height:1.7; justify-content:space-between; }
.cp-note.is-err { background:rgba(255,69,58,.10); } .cp-note.is-ok { background:rgba(48,209,88,.10); } .cp-note.is-warn { background:rgba(255,159,10,.12); }
.cp-spider { gap:8px; }
.cp-sp-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.cp-user { display:grid; grid-template-columns: minmax(90px,1fr) 2fr auto; gap:8px; align-items:center; padding:6px 0; border-top:1px solid var(--mv-sep, rgba(127,127,127,.2)); }
.cp-user small { color:var(--mv-label-2); }
.cp-sp-form { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.cp-sp-form input { flex:1 1 120px; min-width:100px; }
.cp-sp-form textarea { flex:1 1 100%; font-family:var(--mv-font-tech, monospace); }
.cp-dim { color:var(--mv-label-2); font-size:12px; }
.cp-sync .cp-sq i { font-size:15px; }
.cp-dups { gap:6px; }
.cp-dup { display:grid; grid-template-columns: 26px 1fr auto; gap:8px; align-items:center; padding:6px 0; border-top:1px solid var(--mv-sep, rgba(127,127,127,.2)); }
.cp-dup small { display:block; }
.cp-sq.is-sm { width:24px; height:24px; border-radius:7px; font-size:10px; }
.cp-dup-note { grid-column: 1 / -1; font-size:12px; padding:4px 8px; border-radius:8px; }
.cp-dup-note.is-warn { background:rgba(255,159,10,.12); } .cp-dup-note.is-ok { background:rgba(48,209,88,.10); } .cp-dup-note.is-err { background:rgba(255,69,58,.10); } .cp-dup-note.is-busy { background:rgba(10,132,255,.10); }
.mv-btn.mv-btn--danger { background:var(--mv-red, #FF3B30); color:#fff; }
`;
    document.head.appendChild(css);
})();
