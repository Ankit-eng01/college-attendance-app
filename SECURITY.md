# Security & Student Data Privacy Policy — Attendify

This document outlines the security architecture, data governance principles, and guidelines enforced in the **Attendify College Attendance Tracker** application.

---

## 1. Core Security Principles

### • Validate All Imported JSON Files
- All backup import files are passed through an in-memory schema validator (`validateAndSanitizeState`).
- The validator enforces strict structural boundaries:
  - Max subject count: 50
  - Max calendar days: 1,000
  - Max history records: 2,500
  - Integer range limits: `0 <= attended <= total <= 2000`
  - ISO-8601 date regex validation (`YYYY-MM-DD`)
  - Strict enum validation for subject categories (`theory`, `lab`, `elective`, `tutorial`, `other`) and session statuses (`present`, `absent`, `off`, `none`).
- Malformed or malicious JSON files are rejected with a security alert without altering existing storage.

### • Prevent Malicious HTML & JavaScript (Anti-XSS & CSP)
- Strict **Content Security Policy (CSP)** meta tag is active in `<head>`:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self';">
  ```
- All dynamic data rendered into the DOM is sanitized using `escapeHtml()` and `sanitizeText()` to prevent DOM-based Cross-Site Scripting (DOM XSS).
- User inputs are stripped of HTML tags (`<...>` tags removed) prior to storage.

### • Zero Passwords or Secret API Keys in Frontend Code
- **Zero API keys, private tokens, or secrets** are stored in client-side code.
- Attendify operates purely client-side on the user's device without hidden credentials.

### • Secure Authentication Guidelines (For Future Cloud Extensions)
- Currently, Attendify is **100% account-free and local-first**.
- If optional cloud sync or student accounts are introduced in future versions:
  - Must use modern **OAuth 2.0 with PKCE** flow.
  - Session tokens must use secure, HTTP-only, SameSite cookies.
  - End-to-end client-side encryption (E2EE) must be utilized for private student attendance logs.

### • Keep Student Records Private
- **Zero Third-Party Telemetry**: 0 analytics SDKs, 0 tracking pixels, 0 advertising scripts.
- **Sandboxed Local Storage**: Records live exclusively in HTML5 `localStorage` scoped to the origin.
- **Discreet Screen Mode**: 1-tap `👁️` privacy toggle in the header and in Settings that blurs percentages and attendance ratios with a CSS mask to protect against shoulder-surfing peers in crowded lecture halls.

### • Clear In-App Privacy Policy
- An interactive **Privacy & Security Policy Modal** is accessible directly in the user interface (Settings tab), explaining:
  - Zero data collection
  - Local device storage
  - Offline functionality
  - Student data sovereignty

### • Complete Backups & Data Deletion Rights
- **Timestamped JSON Export**: Full schema-compliant backup download (`attendify_backup_YYYY-MM-DD.json`).
- **CSV Report Export**: Spreadsheet-ready export for academic records and counselors.
- **Safe Data Deletion / Factory Reset**: Clear warning with record counts, 1-tap backup prompt, and permanent erasure of `localStorage`.

---

## 2. Reporting Security Vulnerabilities

If you discover a security issue or vulnerability, please open an issue or security advisory on the GitHub repository:  
[https://github.com/Ankit-eng01/college-attendance-app](https://github.com/Ankit-eng01/college-attendance-app)
