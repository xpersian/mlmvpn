# Panel registry — one install per panel per Cloudflare account

*(فارسی در پایین)*

The phone and the Windows app share **one** install of each cloud panel per Cloudflare account. Until 1.2.5 each app kept its records on the device, so the other app knew nothing. It made its own Worker and its own KV/D1, and one account ran out of its ten free D1 databases.

## Where it lives

The registry is kept on the account itself: a KV namespace titled **`mlmvpn-panels`**, with one key per panel code.

- It is **never bound to any Worker**, so no panel code can read it.
- Only the account's own API credential can read it, and both apps already hold that credential.

| code | panel | `s` (credentials) |
|---|---|---|
| `BPB` | BPB | `uuid`, `trPass`, `subPath` |
| `EDG` | Edge (edgetunnel) | `uuid` |
| `ZEU` | Zeus | `password` (when known) |
| `NHN` | Nahan | `masterKey`, `apiRoute` |
| `MLM` | MLM, legacy panel (never Config Studio) | `password` |
| `SPD` | Spider | `token` |
| `NTR` | Netra | `uuid`, `trPass`, `subPath` |
| `GZG` | Gozargah | `panelPath`, `subPath`, `password` |
| `NVA` | Nova | `password` |

Value (the same JSON on both platforms):

```json
{ "v": 1, "code": "NTR", "script": "api-hub-33e733-ntr", "url": "https://api-hub-33e733-ntr.<sub>.workers.dev",
  "kv": "<namespace id>" , "d1": null, "s": { "uuid": "…", "trPass": "…", "subPath": "…" },
  "by": "windows", "at": 1790700000000 }
```

## The rule every deploy follows

1. **The registry first.** If it has the panel and its Worker still exists, that install is used as it is: the same Worker, KV/D1 and credentials. The install only updates its code.
2. **Our own record** is used when its Worker still exists.
3. **A panel of that kind already on the account** is adopted, even if it was made by an older app or the other device before it knew the registry. It is found by its code (the store's fingerprints), and the same Worker and storage are kept. Credentials are read from where the panel itself keeps them:
   - **Readable:** Nahan's `sys_config` and Gozargah's paths (D1), Nova's `admin_pass` (KV / D1 `kvstore`, columns `k`/`v`), Spider's token and BPB's settings (compiled into the code), and the phone's `plain_text` bindings (Edge `UUID`, MLM `ADMIN_PASSWORD`).
   - **Unreadable:** Netra's secrets, Windows' Edge `UUID` and MLM `ADMIN_PASSWORD`. These get a **new value on the same Worker** (`PUT …/workers/scripts/{name}/secrets`). Gozargah's password gets a new PBKDF2-SHA256 hash written into its own settings row. Users and data stay.
4. Only when there is none of the three is a new Worker made (with one KV/D1).
5. After every deploy the registry is written. A panel still on its public defaults (Nahan `admin`, Gozargah `admin`) is secured by the next deploy, and the new values travel through the registry.

**Sync:** Windows has «پنل‌های مشترک با گوشی» in the Cloud window; Android runs `PanelSync.syncOnce` from the Cloud tab.

- Registry → the device's records.
- The device's installs → the registry, when it does not know them yet.
- The Windows app also lists **duplicates**: other Workers of a panel kind that are not the account's install.
  - One is removed only on the user's confirmation.
  - Its KV/D1 is deleted only when no other Worker on the account binds it, and only when every Worker's bindings could be read.

**Code:**
- Windows: `panel-registry.js` and `cloud-panels.js` (`resolveExisting`, `publish`, `sync`, `duplicates`, `removeDuplicate`); BPB, Edge and Zeus in `server.js`; tests in `tests/cloud-panels/registry.test.js`.
- Android: `engines/cloud/PanelRegistry.kt` and `PanelSync.kt`, plus each `*Panel.kt`, `CloudManager.deployWorker/deployEdgWorker`, `NahanDeployer` and `MlmDeployer`.

---

## فارسی (خلاصه)

گوشی و ویندوز برای هر پنل روی هر حساب کلادفلر فقط **یک نصب مشترک** دارند.

**محل ثبت:** فضای KV به نام `mlmvpn-panels` روی خود حساب، یک کلید برای هر پنل. هیچ ورکری به آن دسترسی ندارد؛ فقط کلید API خود حساب.

**ترتیب تصمیم هنگام هر نصب:**
1. ثبت حساب؛
2. نصب قبلی خود دستگاه؛
3. پنل هم‌نوعی که از قبل روی حساب هست. همان ورکر و همان KV/D1 به کار می‌رود. رمزها از جایی که خود پنل نگه می‌دارد خوانده می‌شوند؛ اگر خواندنی نباشند، روی همان ورکر تازه می‌شوند و کاربران و داده سر جایشان می‌مانند؛
4. فقط وقتی هیچ‌کدام نیست، نصب تازه.

بعد از هر نصب، ثبت حساب به‌روز می‌شود تا دستگاه دیگر همان را به کار ببرد.

**نسخه‌های تکراری:** نسخه‌هایی که قبل از هماهنگی ساخته شده‌اند در بخش ابری ویندوز فهرست می‌شوند و با تأیید کاربر پاک می‌شوند. دیتابیس یا KV فقط وقتی پاک می‌شود که هیچ ورکر دیگری از آن استفاده نکند.
