// --- «ام‌ال‌ام استور» — verifying a download by its Authenticode signature ---
//
// WHY THIS EXISTS. Every direct-from-developer install in this store is anchored on GitHub's own
// SHA-256 for the asset (store/direct.js). SoftEther has no such anchor: their Windows client is
// published as one self-extracting installer, uploaded in 2025, before GitHub computed digests for
// release assets. `store/direct.js` therefore refused it, and «گیت‌وی MLM» could only be updated
// when we repacked and re-signed the files ourselves.
//
// There is a better anchor on that file than a digest would have been. The installer carries
// **SoftEther Corporation's own Authenticode signature**, and — this is the part that makes it
// work — every file it installs is a PE RESOURCE inside that same signed image (see store/sfx.js).
// So one signature check covers the installer AND all twelve files that come out of it. A GitHub
// digest only ever proved "these are the bytes GitHub received"; this proves who built them.
//
// WHAT IS CHECKED, and in this order:
//   1. the signature is present and Windows says it is Valid — not expired-but-trusted, not
//      UnknownError, not NotSigned;
//   2. the signing certificate's subject contains the expected organisation, so a validly signed
//      file from somebody else is refused as loudly as an unsigned one;
//   3. only then does anything read the file's contents.
//
// HOW. `Get-AuthenticodeSignature` is Windows' own answer and needs nothing installed. It is run
// with execFile (never a shell) and always asynchronously — this runs on the store's background
// job, and a synchronous spawn anywhere reachable from a click freezes the window and the HTTP
// server the page is loading from (see docs/ARCHITECTURE.md, rule 1).
//
// A NOTE ON WHAT THIS IS NOT. It says the file is the publisher's, unmodified. It does not say the
// publisher's build is good — nobody has run this version against this app before the user does.
// That is the same trade `store/direct.js` describes, which is why both are opt-in per catalogue
// item rather than how the store behaves in general.

'use strict';

const { execFile } = require('child_process');

const POWERSHELL = 'powershell.exe';
const TIMEOUT_MS = 30000;

/**
 * What Windows says about a file's signature.
 *
 * Returns `{ status, subject, issuer, thumbprint }`. Never throws for an unsigned or badly signed
 * file — that is an answer, not an error — but does throw when PowerShell itself could not run,
 * because "we could not check" must never be mistaken for "it checked out".
 */
function inspect(file) {
    return new Promise((resolve, reject) => {
        // The path travels in an ENVIRONMENT VARIABLE, not in the command text. Two reasons, and
        // the first one cost an hour: with -Command, `$args` is never populated — anything after
        // the script is appended to it, so `$args[0]` is null and the cmdlet refuses. (`$args`
        // only works with -File.) And a path interpolated into a script string is an injection
        // waiting for a file name with a quote in it; an environment variable cannot be escaped out of.
        //
        // -OutputFormat is not used: its XML is huge. One line of controlled text is enough, and
        // the separator is a character no certificate subject contains.
        const script =
            '$ErrorActionPreference = "Stop";' +
            '$s = Get-AuthenticodeSignature -LiteralPath $env:MLM_SIGCHECK_PATH;' +
            '$c = $s.SignerCertificate;' +
            '[Console]::OutputEncoding = [Text.Encoding]::UTF8;' +
            'Write-Output ("{0}`t{1}`t{2}`t{3}" -f $s.Status, $c.Subject, $c.Issuer, $c.Thumbprint)';

        execFile(POWERSHELL,
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            {
                timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20,
                env: Object.assign({}, process.env, { MLM_SIGCHECK_PATH: file }),
            },
            (err, stdout) => {
                if (err) return reject(new Error('بررسی امضای فایل انجام نشد: ' + (err.message || err)));
                const parts = String(stdout).trim().split('\t');
                if (!parts[0]) return reject(new Error('بررسی امضای فایل پاسخی نداد'));
                resolve({
                    status: parts[0].trim(),
                    subject: (parts[1] || '').trim(),
                    issuer: (parts[2] || '').trim(),
                    thumbprint: (parts[3] || '').trim(),
                });
            });
    });
}

/**
 * Throw unless `file` is validly signed by an organisation whose subject contains `expect`.
 *
 * `expect` is matched case-insensitively against the certificate subject. It is deliberately a
 * substring and not a full subject: certificate subjects carry an address that changes between
 * renewals, and pinning the whole string would turn a routine certificate renewal into a broken
 * update path — the failure would look exactly like tampering, at the worst possible moment.
 */
async function verify(file, expect) {
    const sig = await inspect(file);

    if (sig.status !== 'Valid') {
        // Windows' own words, translated to what the user can do about it. An unsigned or altered
        // download is the same answer either way: do not open it.
        const why = {
            NotSigned: 'این فایل امضای دیجیتال ندارد',
            HashMismatch: 'فایل بعد از امضا شدن تغییر کرده است',
            NotTrusted: 'امضای فایل به یک مرجع معتبر نمی‌رسد',
            UnknownError: 'امضای فایل قابل بررسی نبود',
        }[sig.status] || ('وضعیت امضا: ' + sig.status);
        throw new Error('فایل دانلودشده پذیرفته نشد — ' + why + '.');
    }

    if (expect && sig.subject.toLowerCase().indexOf(String(expect).toLowerCase()) < 0) {
        throw new Error('فایل دانلودشده امضای معتبر دارد ولی متعلق به «' + expect +
            '» نیست. صادرکنندهٔ امضا: ' + (sig.subject || '؟'));
    }

    return sig;
}

module.exports = { inspect, verify };
