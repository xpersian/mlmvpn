// --- safe-json.js — «خطای سینتکس» becomes a sentence the user can act on ---
//
// A user reported «Syntax error» while picking panels in the Cloud window. The page calls
// `await res.json()` in hundreds of places; when the answer is NOT JSON — an HTML error page from
// a worker, Cloudflare's own «error code: 1042», an Iranian block page (10.10.34.36), a proxy's
// «502 Bad Gateway», an empty body — the browser throws
//     SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
// and that raw sentence reaches a toast. It names neither the request nor what came back, so
// neither the user nor a bug report can tell a filtered line from a broken panel.
//
// One wrapper for every call: Response.prototype.json still parses exactly as before, and only a
// failure is rewritten — into a message that says which address answered, with which HTTP status,
// and what the answer looked like. The original error rides along as `cause`.
(function () {
    'use strict';
    if (typeof Response === 'undefined' || !Response.prototype || Response.prototype.__mlmSafeJson) return;
    const original = Response.prototype.json;

    function describe(text, res) {
        const t = String(text || '').trim();
        const head = t.slice(0, 400).toLowerCase();
        if (!t) return 'پاسخ خالی بود';
        if (/10\.10\.34\.3[4-6]|peyvandha|internet\.ir|ممنوع|filtered/.test(head)) return 'صفحهٔ مسدودی فیلترینگ برگشت (این نشانی روی خط شما فیلتر است)';
        if (/error code: ?10\d\d/.test(head)) return 'کلادفلر خطا داد (' + (head.match(/error code: ?(\d+)/) || [])[1] + ')';
        if (/cloudflare/.test(head) && /<html|<!doctype/.test(head)) return 'صفحهٔ خطای کلادفلر برگشت';
        if (/<html|<!doctype/.test(head)) {
            const title = (t.match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1];
            return 'یک صفحهٔ HTML برگشت' + (title ? ' («' + title.trim() + '»)' : '');
        }
        return 'پاسخ JSON نبود: «' + t.slice(0, 80).replace(/\s+/g, ' ') + (t.length > 80 ? '…' : '') + '»';
    }

    Response.prototype.json = async function () {
        // Read once as text, then parse — the body can be consumed only once.
        const text = await this.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            let where = '';
            try { const u = new URL(this.url); where = u.origin === location.origin ? u.pathname : u.host + u.pathname; } catch (x) { where = this.url || ''; }
            const err = new Error(describe(text, this) + ' — ' + (this.status ? 'HTTP ' + this.status + ' از ' : 'از ') + where);
            err.name = 'ResponseNotJson';
            err.cause = e;
            err.status = this.status;
            err.bodyPreview = String(text || '').slice(0, 300);
            try { console.warn('[safe-json]', err.message, err.bodyPreview); } catch (x) {}
            throw err;
        }
    };
    Response.prototype.__mlmSafeJson = true;
})();
