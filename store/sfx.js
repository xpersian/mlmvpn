// --- «ام‌ال‌ام استور» — unpacking SoftEther's own Windows installer, without running it ---
//
// SoftEther publishes its Windows client ONLY as its installer
// (softether-vpnclient-v<ver>-<build>-rtm-<date>-windows-x86_x64-intel.exe). There is no zip. So for
// «گیت‌وی MLM»'s engine to update straight from the developer, the store has to get the files out
// of that .exe — and running a setup program is exactly what the store must never do.
//
// It does not need to. SoftEther's build tool packs every file into the installer as a PE RESOURCE
// (src/Cedar/SW.c › SwCompileSfx, via UpdateResource):
//   * resource type "DATAFILE", one resource per file, named by the UPPER-CASED file name;
//   * each one CompressBuf'd (src/Mayaqua/Memory.c): a 4-byte BIG-endian original length, then a
//     zlib stream from compress2;
//   * except hamcore.se2, already compressed, stored as-is under "RAW_HAMCORE.SE2".
// The installer extracts them the same way (SwSfxExtractProcess). Reading the resource table here
// yields the same bytes with no setup program, no UI and nothing written outside `outDir`.
//
// Resources live inside the signed image, so the installer's Authenticode signature covers every
// one of them — which is why the store verifies that signature BEFORE this runs (net.js ›
// downloadSigned), and the executables that come out are verified again after.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TYPE = 'DATAFILE';
const RAW = 'RAW_';

function fail(msg) { return new Error('بستهٔ نصب سافت‌اتر خوانده نشد: ' + msg); }

/** Section table and the resource directory's location. */
function readPe(buf) {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw fail('فایل PE نیست');
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw fail('امضای PE پیدا نشد');
    const sections = buf.readUInt16LE(pe + 6);
    const optSize = buf.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const magic = buf.readUInt16LE(opt);
    const ddBase = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
    if (ddBase < 0) throw fail('سرآیند اختیاری ناشناخته');
    const count = buf.readUInt32LE(ddBase - 4);
    if (count < 3) throw fail('جدول منابع ندارد');
    const rsrcRva = buf.readUInt32LE(ddBase + 2 * 8);
    const rsrcSize = buf.readUInt32LE(ddBase + 2 * 8 + 4);
    if (!rsrcRva || !rsrcSize) throw fail('جدول منابع خالی است');

    const table = [];
    for (let i = 0, at = opt + optSize; i < sections; i++, at += 40) {
        table.push({
            va: buf.readUInt32LE(at + 12),
            vsize: buf.readUInt32LE(at + 8),
            rawSize: buf.readUInt32LE(at + 16),
            raw: buf.readUInt32LE(at + 20),
        });
    }
    const off = (rva) => {
        for (const s of table) {
            const span = Math.max(s.vsize, s.rawSize);
            if (rva >= s.va && rva < s.va + span) return rva - s.va + s.raw;
        }
        throw fail('آدرس ' + rva + ' در هیچ بخشی نیست');
    };
    return { off, rsrc: off(rsrcRva) };
}

/** Every resource of `type`: [{ name, data }]. */
function resources(buf, type) {
    const { off, rsrc } = readPe(buf);
    const str = (o) => {
        const at = rsrc + o;
        const len = buf.readUInt16LE(at);
        return buf.toString('utf16le', at + 2, at + 2 + len * 2);
    };
    const entries = (dirOff) => {
        const at = rsrc + dirOff;
        const n = buf.readUInt16LE(at + 12) + buf.readUInt16LE(at + 14);
        const out = [];
        for (let i = 0; i < n; i++) {
            const e = at + 16 + i * 8;
            const name = buf.readUInt32LE(e);
            const data = buf.readUInt32LE(e + 4);
            out.push({
                name: name & 0x80000000 ? str(name & 0x7fffffff) : name,
                dir: !!(data & 0x80000000),
                ptr: data & 0x7fffffff,
            });
        }
        return out;
    };
    const typeEntry = entries(0).find((e) => typeof e.name === 'string' && e.name.toUpperCase() === type && e.dir);
    if (!typeEntry) throw fail('منبعی از نوع ' + type + ' ندارد');
    const found = [];
    for (const named of entries(typeEntry.ptr)) {
        if (!named.dir || typeof named.name !== 'string') continue;
        const lang = entries(named.ptr).find((e) => !e.dir);
        if (!lang) continue;
        const de = rsrc + lang.ptr;
        const at = off(buf.readUInt32LE(de));
        const size = buf.readUInt32LE(de + 4);
        if (at + size > buf.length) throw fail('منبع ' + named.name + ' از فایل بیرون می‌زند');
        found.push({ name: named.name, data: buf.subarray(at, at + size) });
    }
    return found;
}

/** SoftEther's CompressBuf, undone: 4-byte big-endian length, then zlib. */
function uncompress(name, data) {
    if (data.length < 4) throw fail(name + ' خالی است');
    const want = data.readUInt32BE(0);
    const out = zlib.inflateSync(data.subarray(4));
    if (out.length !== want) throw fail(name + ': اندازهٔ باز شده ' + out.length + ' است، نه ' + want);
    return out;
}

/**
 * Write every file packed into a SoftEther installer to `outDir`, under its real (lower-case) name.
 * @returns {string[]} the names written
 */
function extract(file, outDir) {
    const buf = fs.readFileSync(file);
    const items = resources(buf, TYPE);
    if (!items.length) throw fail('هیچ فایلی داخلش نیست');
    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    for (const r of items) {
        const upper = r.name.toUpperCase();
        const raw = upper.startsWith(RAW);
        const name = (raw ? r.name.slice(RAW.length) : r.name).toLowerCase();
        // A resource name is data from the file. It must be a bare file name — nothing that could
        // climb out of the scratch directory.
        if (!/^[a-z0-9_.\-]+$/.test(name) || name === '.' || name === '..') throw fail('نام نامعتبر: ' + r.name);
        fs.writeFileSync(path.join(outDir, name), raw ? r.data : uncompress(r.name, r.data));
        written.push(name);
    }
    return written;
}

module.exports = { extract, resources, uncompress, TYPE };
