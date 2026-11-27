# Security Architecture & Student Data Privacy Policy — Attendify

This document details the security model, cryptographic controls, cloud access authorization, and data privacy principles implemented in **Attendify College Attendance Tracker & Calculator**.

---

## 1. Resolution of Security Audit Findings

| Audit Finding | Previous Status | Current Status | Hardened Implementation Details |
|---|---|---|---|
| **Signing keystore in source files** | Compromised | **✅ Resolved** | Keystore & signing credentials permanently purged from working tree and rewritten from Git history. Private keystores are managed in an external, isolated directory outside version control. |
| **Signing files excluded by `.gitignore`** | Missing | **✅ Resolved** | `.gitignore` strictly rejects `*.keystore`, `*.jks`, `*key-info*.txt`, `signing*`, `*.aab`, and zip archives. |
| **Cloud database integration** | Pending | **✅ Implemented** | Scalable, high-availability Neon serverless PostgreSQL storage exposed through a serverless Function API for multi-device synchronization. |
| **CSP permits inline scripts** | Still present | **✅ Resolved** | All application scripts extracted from HTML into a standalone `app.js`. Every inline event handler (`onclick`, `onchange`, `oninput`, `onsubmit`) replaced with `data-action` attributes and centralized event delegation. CSP enforced with `script-src 'self'`. |
| **Weak cloud sync code generation** | Still present | **✅ Resolved** | Insecure `Math.random()` replaced with **Cryptographically Secure Pseudo-Random Number Generation (CSPRNG)** via `window.crypto.getRandomValues()`. Generates 128-bit collision-resistant Crockford Base32 keys (`ATN-XXXX-XXXX-XXXX`). |
| **Local Credential Persistence on Restart** | Bug found | **✅ Resolved** | Fixed `validateAndSanitizeState()` to retain `studentName`, `syncCode`, `syncAuthKey`, `accountEmail`, `isSetupCompleted`, and `lastSyncedAt`. Credentials and user identity now persist across restarts, app reopens, and browser refreshes without regenerating. |
| **Cloud Access Authorization** | Unverified | **✅ Hardened & Verified** | Direct table queries are impossible from the browser: the PWA talks only to the Neon Function API (`POST /auth/register`, `/auth/login`, `/push`, `/pull`, `/delete`), which mediates every data call through `SECURITY DEFINER` PostgreSQL procedures (`attendify_sync_push`, `attendify_sync_pull`, and `attendify_sync_delete`) validating a 256-bit secret token against its stored `SHA-256` hash. Unauthorized reads/writes return HTTP 401. |
| **Actual Cloud Deletion (Factory Reset)** | Bug found | **✅ Resolved** | Factory Reset (`confirmPermanentDelete()`) and the dedicated "Wipe Cloud Backup" button invoke the cloud `attendify_sync_delete` procedure, permanently erasing the student's records from the Neon PostgreSQL database. |
| **Service Worker Caching** | Needs improvement | **✅ Upgraded (v7-neon)** | Refactored `sw.js` with **Network-First** strategy for HTML document navigation (guaranteeing fresh app versions when online with instant offline fallback), **Stale-While-Revalidate** for static assets, explicit API bypass for cloud sync requests, and atomic cache eviction on activation. |

## 1.5 Midnight Pro Redesign (UI/UX) — Cache & Privacy Notes
- Service worker cache bumped to `attendify-v20-midnight-pro`; precaches `app.js?v=20261126nodata`.
- Desktop sidebar + mobile bottom navigation; attendance no-data now renders `--` / "No Classes Yet" instead of `100%`.
- Guest mode no longer claims local-only storage: cloud backup remains enabled by default so records can be restored with the sync code; guest records use the same HTTPS backup flow and can be restored with the sync code. Create an account for email-based recovery.
- Account, cloud sync, security, and data management are consolidated in Settings; no secrets are embedded in the frontend.
- Cloud backup stores attendance data as JSONB plus a compact device profile (`label`, `type`, `browser`, `os`, `model`, `screen`, `access`, `updatedAt`); full user-agent strings are never stored. Auth tokens are hashed at rest and encrypted in transit over HTTPS.

---

## 2. Core Security & Privacy Principles

### A. Local Persistence & Credential Integrity
- `validateAndSanitizeState()` validates input schema bounds while guaranteeing that student profile fields (`studentName`), pairing tokens (`syncCode`), cryptographic secret passkeys (`syncAuthKey`), and the signed-in `accountEmail` remain intact in `localStorage`.
- Automated test suites verify 10+ consecutive restart cycles with zero credential drift or regeneration.

### B. Cryptographically Secure Sync Credentials (CSPRNG)
- Sync codes are generated using standard CSPRNG (`window.crypto.getRandomValues(new Uint8Array(15))`) encoded into uppercase alphanumeric base32 with zero ambiguous characters (`0/O`, `1/I/L` excluded).
- Each student installation receives a dedicated **256-bit Private Secret Key** (`syncAuthKey`).
- When syncing to the cloud, the database verifies that `encode(extensions.digest(p_auth_token::bytea, 'sha256'), 'hex')` matches the record's registered `auth_hash`.
- Attackers or peers cannot access or tamper with any student's records by guessing sync identifiers.

### C. Server-Side Cloud Deletion & Student Data Sovereignty
- **Factory Reset**: Executing a Factory Reset erases local storage and triggers the cloud delete endpoint to wipe the record in Neon.
- **Standalone Cloud Deletion**: Students can erase their cloud backup at any time from Settings while keeping local device data intact.
- Multi-device pairing and restoration verified end-to-end with token authentication.
- Each cloud sync writes a compact `data.device` profile (`label`, `type`, `browser`, `os`, `model`, `screen`, `access`, `updatedAt`) so the token-gated admin console can show which device last synced a student. Labels use friendly names such as `iPhone`, `iPad`, `Windows PC`, `Chromebook`, and `MacBook / Mac`; a browser cannot tell a MacBook from a desktop Mac, so both are labelled `MacBook / Mac`. Full user-agent strings are never stored or displayed. Older backups without this field show `Sync pending` until the user syncs from the updated app.

### D. Strict Content Security Policy (Anti-XSS)
- CSP header enforced in `index.html`:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://br-fancy-block-azi8u9jd-sync.compute.c-3.ap-southeast-1.aws.neon.tech;">
  ```
- **Zero Inline JavaScript**: All logic is bundled in `app.js`.
- **Zero Inline Event Attributes**: All user interactions are routed through standard `addEventListener` and `data-action` delegation.
- All user-supplied text (student names, course titles, history notes) undergoes HTML escaping via `escapeHtml()` and tag stripping via `sanitizeText()`.

### E. Zero Frontend Secret API Keys
- Frontend code ships **no** API key, database URL, or credential of any kind. It only knows the public sync endpoint origin; the function holds `DATABASE_URL` server-side.
- Write authorization is enforced per-record using salted cryptographic hashing in PostgreSQL.
- No master database keys or passwords exist in the client distribution.

### F. Multi-Tier Cache & Offline Reliability
- **Service Worker (`attendify-v19-device-labels`)**:
  - **Navigation (`index.html`)**: Network-First ensures returning users always receive the newest deployed version when connected to the internet. If offline, the cached app shell loads immediately.
  - **Static Assets (`app.js`, icons, fonts)**: Stale-While-Revalidate allows near-instant local boot while asynchronously refreshing cached assets.
  - **API Requests**: Cloud sync API calls bypass static caching, preventing cached or stale student data.

### G. Keystore & Release Signing Key Isolation
- **Git History Cleanliness**: A full historical audit (`git log --all --full-history --diff-filter=A --name-only`) confirms that `signing.keystore` and `signing-key-info.txt` were **never committed** to git history or git object storage.
- **Repository Isolation**: Private keystores and passwords reside strictly outside version control in local private scratch space (`scratch/private_keys/`).
- **`.gitignore` Enforced**: Patterns `*.keystore`, `*.jks`, `*key-info*.txt`, `signing*`, and `*.aab` are strictly ignored to prevent accidental future commits.
- **Digital Asset Links**: Both `.well-known/assetlinks.json` and root `assetlinks.json` specify the exact SHA-256 certificate fingerprint matching the production signed release:
  `5A:E4:A9:D0:42:FB:4D:87:26:E8:A2:A5:47:C4:5C:E0:74:3E:16:FB:6A:64:FA:CA:40:DC:B9:B9:7A:8D:8A:7A`

### H. Email/Password Account Authentication
- First launch requires an explicit choice: create an email account, sign in, or continue as guest. Guest mode stores records locally and also auto-backs up over HTTPS using the browser's random `syncCode` + `syncAuthKey` once subjects exist (without email recovery); signing out clears the email session and reopens the choice gate.
- Registered accounts are additive: the original Cloud Sync Code + Private Secret Key flow continues to work unchanged.
- The browser never stores or transmits a reusable account password to the database. `POST /auth/register` hashes it server-side with **salted scrypt** (16-byte random salt, 64-byte derived key). Plaintext passwords are never persisted.
- `POST /auth/login` verifies the hash with a constant-time comparison. Unknown emails run an equally expensive dummy scrypt verification plus a short random delay, so timing cannot enumerate registered users. All credential failures return the same generic message.
- Successful registration/login returns the existing `sync_code` + `auth_token`, so account data is protected by the same per-record `SHA-256` token check on every `/push` and `/pull`.
- At rest, the pairing secret is sealed with **AES-256-GCM** using a key derived from the server-only `ACCOUNT_TOKEN_SECRET`. It is decrypted only after a successful password verification; there is no account password or encryption key in the client bundle.
- Signing out clears the local account email and rotates the device's pairing credentials, so the device loses access to the account backup until the user signs in again.


---

## 3. Reporting Vulnerabilities

If you discover a potential vulnerability, please report it via the GitHub repository issue tracker:  
[https://github.com/Ankit-eng01/college-attendance-app](https://github.com/Ankit-eng01/college-attendance-app)
