# Security Architecture & Student Data Privacy Policy — Attendify

This document details the security model, cryptographic controls, cloud access authorization, and data privacy principles implemented in **Attendify College Attendance Tracker & Calculator**.

---

## 1. Resolution of Security Audit Findings

| Audit Finding | Previous Status | Current Status | Hardened Implementation Details |
|---|---|---|---|
| **Signing keystore in source files** | Compromised | **✅ Resolved** | Keystore & signing credentials permanently purged from working tree and rewritten from Git history. Private keystores are managed in an external, isolated directory outside version control. |
| **Signing files excluded by `.gitignore`** | Missing | **✅ Resolved** | `.gitignore` strictly rejects `*.keystore`, `*.jks`, `*key-info*.txt`, `signing*`, `*.aab`, and zip archives. |
| **Cloud database integration** | Pending | **✅ Implemented** | Scalable, high-availability Supabase Lakebase PostgreSQL storage for multi-device synchronization. |
| **CSP permits inline scripts** | Still present | **✅ Resolved** | All application scripts extracted from HTML into a standalone `app.js`. Every inline event handler (`onclick`, `onchange`, `oninput`, `onsubmit`) replaced with `data-action` attributes and centralized event delegation. CSP enforced with `script-src 'self'`. |
| **Weak cloud sync code generation** | Still present | **✅ Resolved** | Insecure `Math.random()` replaced with **Cryptographically Secure Pseudo-Random Number Generation (CSPRNG)** via `window.crypto.getRandomValues()`. Generates 128-bit collision-resistant Crockford Base32 keys (`ATN-XXXX-XXXX-XXXX`). |
| **Cloud access authorization** | Unverified | **✅ Hardened & Verified** | Direct table queries (`GET /rest/v1/attendify_sync`) are blocked with Row Level Security (`USING (false)`). Synchronization is mediated through `SECURITY DEFINER` PostgreSQL RPC procedures (`attendify_sync_push`, `attendify_sync_pull`, `attendify_sync_wipe`) validating a 256-bit secret token against its stored `SHA-256` hash. Unauthorized reads/writes return HTTP 401. |
| **Service worker caching** | Needs improvement | **✅ Upgraded (v6-secure)** | Refactored `sw.js` with **Network-First** strategy for HTML document navigation (guaranteeing fresh app versions when online with instant offline fallback), **Stale-While-Revalidate** for static assets, explicit API bypass for Supabase requests, and atomic cache eviction on activation. |

---

## 2. Core Security & Privacy Principles

### A. Cryptographically Secure Sync Credentials (CSPRNG)
- Sync codes are generated using standard CSPRNG (`window.crypto.getRandomValues(new Uint8Array(15))`) encoded into uppercase alphanumeric base32 with zero ambiguous characters (`0/O`, `1/I/L` excluded).
- Each student installation receives a dedicated **256-bit Private Secret Key** (`syncAuthKey`).
- When syncing to the cloud, the database verifies that `encode(digest(p_auth_token::bytea, 'sha256'), 'hex')` matches the record's registered `auth_hash`.
- Attackers or peers cannot access or tamper with any student's records by guessing sync identifiers.

### B. Strict Content Security Policy (Anti-XSS)
- CSP header enforced in `index.html`:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co https://bzvhfoedeyopdtsqisdn.supabase.co;">
  ```
- **Zero Inline JavaScript**: All logic is bundled in `app.js`.
- **Zero Inline Event Attributes**: All user interactions are routed through standard `addEventListener` and `data-action` delegation.
- All user-supplied text (student names, course titles, history notes) undergoes HTML escaping via `escapeHtml()` and tag stripping via `sanitizeText()`.

### C. Zero Frontend Secret API Keys
- Frontend code exposes only the public anonymous key (`anon`), with table-level operations disabled.
- Write authorization is enforced per-record using salted cryptographic hashing in PostgreSQL.
- No master database keys or passwords exist in the client distribution.

### D. Multi-Tier Cache & Offline Reliability
- **Service Worker (`attendify-v6-secure`)**:
  - **Navigation (`index.html`)**: Network-First ensures returning users always receive the newest deployed version when connected to the internet. If offline, the cached app shell loads immediately.
  - **Static Assets (`app.js`, icons, fonts)**: Stale-While-Revalidate allows near-instant local boot while asynchronously refreshing cached assets.
  - **API Requests**: Supabase REST/RPC calls bypass static caching, preventing cached or stale student data.

### E. In-Memory Schema Validation for JSON Backups
- Imported backup files are validated by `validateAndSanitizeState`:
  - Enforces JSON object root.
  - Limits subject count to $\le 50$, calendar items to $\le 1000$, and history logs to $\le 2500$.
  - Bounds attendance values: $0 \le \text{attended} \le \text{total} \le 2000$.
  - Validates ISO dates (`YYYY-MM-DD`) and categorical enums (`theory`, `lab`, `elective`, `tutorial`, `other`).

### F. Student Privacy & Data Sovereignty
- **Discreet Privacy Mode**: Single-tap toggle blurs sensitive attendance ratios and percentages with a CSS filter mask for anti-shoulder-surfing in lecture halls.
- **Export Formats**: Full JSON backup download and CSV spreadsheet report.
- **Permanent Erasure**: Single-tap Factory Reset securely erases local data and provides cloud wipe functionality.

---

## 3. Reporting Vulnerabilities

If you discover a potential vulnerability, please report it via the GitHub repository issue tracker:  
[https://github.com/Ankit-eng01/college-attendance-app](https://github.com/Ankit-eng01/college-attendance-app)
