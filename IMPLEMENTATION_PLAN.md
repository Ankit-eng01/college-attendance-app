# Attendify 3.0 — Staged Implementation Plan

## Phase 0 — Inspection findings (completed)

### Repository
- Existing single-page PWA: `index.html` (UI + CSS), `app.js` (state/auth/sync/rendering),
  `calc.js` (shared calculation engine), `features.js` (analytics/timetable/notifications/
  backup wrappers), `sw.js` (service worker), `manifest.json`, `neon/` (backend).
- Git: feature branch `feat/attendify-3.0` created from `main`; backup commit
  `618423d` captures all previously untracked critical files.
- Live hosts: GitHub Pages and Vercel. Backend: Neon Functions.

### Backend capabilities — verified from source (`neon/fn/src/index.ts`)
| Endpoint | Exists | Notes |
|---|---|---|
| `POST /auth/register` | yes | email/password, returns `sync_code` + `auth_token` |
| `POST /auth/login` | yes | same |
| `POST /push` | yes | **whole-payload overwrite** of `data` JSONB |
| `POST /pull` | yes | returns whole `data` JSONB |
| `POST /delete` | yes | deletes cloud record |
| `GET /health` | yes | |

**Not implemented by the backend:** per-operation sync, idempotency keys,
conflict-resolution endpoint, notification scheduling, reminder delivery, rate limiting.
Consequences:
1. Offline operations are persisted locally as a durable outbox. They are flushed by
   pushing the *complete current state* through the real `/push` endpoint. An operation
   is marked `synced` **only** after a successful HTTP 200 from `/push`.
2. Duplicate prevention uses stable operation IDs locally plus the fact that a
   whole-payload overwrite is idempotent in effect. Server-side idempotency is
   unavailable and is not claimed.
3. Conflict detection is client-side via state fingerprints + timestamps (`decideSync`).
   Conflicts pause the queue and require explicit user choice; nothing is overwritten
   silently. Preserving both versions uses the existing `mergeStates` helper.
4. Browser reminders only work while the tab is open. No server-side scheduler exists.
   The UI states this limitation plainly. No delivery is claimed unless the browser
   Notification API confirms it was shown while the page was running.

### Preserved behaviour
Dashboard, subject CRUD, attendance marking/history/calendar, 75% calculator,
safe bunks, What-If Simulator, guest mode, account auth, cloud backup/restore,
CSV/JSON export, themes, responsive layouts, existing backup format.

## Stages

### STAGE 1 — Calculation consistency
- Keep raw `pctNum` in `calc.stats()` (already fixed) and fix the legacy fallback in
  `app.js` so it never rounds before comparison.
- Add a regression test for `599/799 @ 75%` plus boundary cases.
- Run `tests/calc.test.js`.

### STAGE 2 — Smart timetable
- Extend `calc.js` timetable helpers: `classType`, `notes`, `recurrence`,
  `temporaryDate`, `cancelled`, overlap detection with opt-in override.
- Extend timetable UI: daily stats (total/completed/upcoming/current/next),
  duplicate, cancel/holiday, present/absent/off actions, week navigation,
  time-positioned weekly grid, current-day highlight, colour coding.
- Attendance integration reuses `recordAttendanceEntry()` so duplicates are
  prevented and `off`/holiday never increments conducted classes.
- Unit tests for create/edit/delete/duplicate/overlap/recurrence/cancellation.

### STAGE 3 — Advanced analytics
- Add real-history range aggregation helpers to `calc.js` (daily buckets, subject
  range rows, insights, month/year/semester/custom range).
- Add filters and report export (CSV + printable PDF report) to the Analytics page.
- Never fabricate history: empty ranges show an explicit "no recorded classes" state.
- Tests for weekly/monthly boundaries, subject comparison, missing data.

### STAGE 4 — Notification centre
- Extend `sanitizeNotifPrefs` with categories, quiet hours, reminder lead time.
- Add persisted notification records (`state.notifications`) with unread state,
  dedupe keys, history, mark-read/delete/clear.
- Generate alerts from `calc.stats()` raw values only.
- Browser notifications are optional, permission-gated, never retried after denial,
  and fall back to in-app records. Quiet hours suppress only device notifications.
- Tests for thresholds, reminder timing, duplicate suppression, quiet hours, denial.

### STAGE 5 — IndexedDB + offline sync
- New `offline.js`: versioned IndexedDB (`attendify_offline`, v1) with stores
  `snapshot`, `operations`, `conflicts`, `meta`. Pure queue reducer exported for tests.
- Every attendance mutation enqueues `{id, recordId, type, subjectId, timestamp,
  payload, status, retries, lastError, ownerKey}`. Queue survives refresh/restart.
- On `online`, pull remote, run `decideSync`, then push via the existing `/push`.
  Success marks ops `synced`; failure keeps them with incremented retry count.
  Offline always keeps ops `pending`. No simulated success.
- Sync status UI: online/offline/pending/syncing/synced/failed + pending count +
  manual "Sync Now".
- Service worker cache bump after asset changes.

### STAGE 6 — UI integration
- Add Notifications and Subjects navigation entries; keep compact mobile nav.
- Wire all new buttons to real handlers; keep dark/light themes and accessibility.

### STAGE 7 — Tests and regression
- `tests/timetable.test.js`, `tests/analytics.test.js`, `tests/notifications.test.js`,
  `tests/offline.test.js`, `tests/regression.test.js`, `tests/run-all.js`.
- Run all suites, fix real failures, report exact executed results.

### STAGE 8 — Deploy and verify
- Commit each stage separately. Push the branch / merge to `main` when credentials
  allow. Verify live URLs with HTTP checks and report honestly if deployment cannot
  be completed from this environment.

## Explicitly out of scope until backend work exists
- Server-side scheduled reminders / push delivery.
- True per-record operation replication and server-assigned conflict winners.
- Rate limiting and server-side idempotency keys.
- The Neon function source for these capabilities can be added later; the frontend
  must not pretend they exist.
