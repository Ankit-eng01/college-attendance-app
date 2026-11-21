# Attendify Cloud Sync — Neon backend

Serverless replacement for the old Supabase sync layer. The PWA talks to one HTTP
function; the function talks to Postgres through `SECURITY DEFINER` procedures, so
the browser never touches the database directly.

```
PWA (app.js)
  │  POST /auth/register  /auth/login   (email + password)
  │  POST /push   /pull   /delete        GET /health
  ▼
Neon Function "sync"  (Hono, Node 24, src/index.ts)
  │  scrypt hash + AES-GCM sealing for accounts
  │  pool.query → attendify_sync_push / _pull / _delete
  ▼
Postgres  public.attendify_accounts + public.attendify_sync
          (Neon branch: production)
```

## Layout

| Path | Purpose |
|---|---|
| `schema.sql` | Table + three `SECURITY DEFINER` functions. Idempotent — safe to re-run. |
| `fn/src/index.ts` | Public sync function: routes, validation, CORS, pooled `pg` access. |
| `fn/src/admin.ts` | Admin console (UI + JSON API). Token-gated, never returns `auth_hash`. |
| `fn/neon.ts` | Function declarations (`sync`, `admin`) and their env. |
| `fn/.neon` | Org / project / branch link. **Gitignored** (machine-local). |
| `fn/.env.local` | `DATABASE_URL`, `ADMIN_TOKEN`, `ACCOUNT_TOKEN_SECRET`. **Gitignored**, contains live secrets. |

## Admin console

Deployed as a separate function so the public sync API stays minimal.

| Route | Auth | Purpose |
|---|---|---|
| `GET /` | none (shell only) | Console UI |
| `GET /health` | none | Liveness |
| `GET /api/stats` | bearer | Students, subjects, attendance sums, 24h/7d activity, storage bytes |
| `GET /api/activity?days=N` | bearer | Per-day creates/updates |
| `GET /api/records?search=&sort=&limit=&offset=` | bearer | Paged student summaries (no payloads) |
| `GET /api/records/:code` | bearer | One record incl. `data` |
| `DELETE /api/records/:code` | bearer | Delete one backup |
| `GET /api/export` | bearer | CSV of student summaries |

`sort` is one of `recent` (default), `name`, `attendance`, `shortage`,
`subjects`. `search` matches the sync code, student name or any subject name.

The UI lists every student with their overall attendance, opens a record as a
human-readable detail view (per-subject attendance, history feed, profile
settings) and keeps the raw JSON behind a disclosure. All glyphs in `admin.ts`
are HTML entities or CSS escapes so the source stays pure ASCII.

Auth is `Authorization: Bearer <ADMIN_TOKEN>`, compared in constant time, with a
250 ms delay on failure. The token is declared in `neon.ts` as
`env: { ADMIN_TOKEN: { value: process.env.ADMIN_TOKEN, required: true } }`, so a
deploy fails loudly if it is unset. The UI keeps it in `sessionStorage` only.

To rotate: change `ADMIN_TOKEN` in `.env.local`, run `neon deploy -y --env .env.local`.


## API

All routes are `POST` with a JSON body, except `/health`.

| Route | Body | Success | Errors |
|---|---|---|---|
| `/auth/register` | `{ email, password, student_name? }` | `200 { status: "success", email, sync_code, auth_token, student_name }` | `400` invalid input · `409` email exists · `503` secret missing · `500` |
| `/auth/login` | `{ email, password }` | `200 { status: "success", email, sync_code, auth_token, student_name }` | `400` · `401` invalid credentials · `503` · `500` |
| `/push` | `{ sync_code, auth_token, data }` | `200 { status: "success", sync_code }` | `400` invalid input · `401` bad token · `500` |
| `/pull` | `{ sync_code, auth_token }` | `200 { status: "success", data }` | `400` · `401` bad token · `404` no record · `500` |
| `/delete` | `{ sync_code, auth_token }` | `200 { status: "deleted", rows_deleted }` | `400` · `401` · `500` |
| `/health` | — | `200 { status: "ok", service: "attendify-sync" }` | — |

Constraints enforced by the function: `sync_code` 6–64 chars, `auth_token` 16–128
chars. Errors are returned as `{ "error": "..." }` — clients read `error`, **not**
`message`.

Authentication is a per-record secret: the raw token is hashed with SHA-256
(`pgcrypto`) and compared inside the SQL procedure. There is no API key in the
client and no master credential in the bundle.

### Email/password accounts

On first launch the PWA shows a locked choice gate: create an account, sign in,
or continue as guest. Guest mode is local-only and persistent; the Account
button can upgrade a guest at any time. Signing out reopens the choice gate.

`POST /auth/register` validates the address and password (8–128 chars, at least
one letter and one number), hashes the password with salted `scrypt` (16-byte
salt, 64-byte derived key), creates a fresh pairing key pair and returns the
same `sync_code` + `auth_token` used by `/push` and `/pull`. This means account
creation reuses the existing sync layer with no separate auth token.

The pairing secret is stored as AES-256-GCM ciphertext (`iv:tag:ciphertext`)
using a key derived from `ACCOUNT_TOKEN_SECRET`. It is decrypted and returned
only after a successful password check. Unknown emails still run a real scrypt
verification against a dummy hash and a short random delay, so login responses
do not reveal whether an email is registered. Failures return the generic
`Invalid email or password.` message.

## Deploy

```powershell
cd neon/fn
neon deploy -y            # applies neon.ts to the linked branch and uploads the function
neon functions list       # shows the slug, status and public URL
```

The deploy prints the function URL and pulls Postgres variables into `.env.local`.
Deploys are idempotent; re-running with no source changes still updates the function.

Configured CORS origins (ceiling — keep this list tight):

```
https://ankit-eng01.github.io
https://college-attendance-app-nine.vercel.app
http://localhost:3000
http://localhost:8080
http://localhost:4318
```

Origin `127.0.0.1` is deliberately **not** allowed; serve local tests on
`localhost`.

## Client wiring

Three places must agree with the deployed URL:

1. `app.js` → `const SYNC_API_URL = '…'`, used by `syncApiRequest(path, payload)`
2. `index.html` → CSP `connect-src` must list the same origin
3. `sw.js` → the network-only bypass matches `neon.tech` hostnames

Changing one without the others breaks sync (CSP block, or cached/offline response).

## Schema

`public.attendify_sync`: `sync_code` (unique), `auth_hash`, `data jsonb`,
`created_at`, `updated_at`. Prints/uses are limited to the three procedures:
there is no public read path and no REST layer exposing the table.

`public.attendify_accounts`: `email` (primary key, normalized lowercase),
`password_hash`, `sync_code` (unique), `auth_token_enc`, `student_name`,
`created_at`, `updated_at`. The account row owns the pairing credentials; the
backup payload stays in `attendify_sync` and is still written only through the
validated `/push` procedure. Existing sync rows are untouched by this migration.

To rotate `ACCOUNT_TOKEN_SECRET`: set a new 32-byte hex value in `.env.local`,
redeploy, then have users sign in again. Previously stored pairing secrets
cannot be decrypted with the old key, so users should create a fresh account or
re-pair with their existing Cloud Sync Code + Private Key.


## History

Migrated from Supabase (`attendify_sync_push` / `_pull` / `_delete` RPCs) in
commit `d090741`. The old Supabase project is being paused, not deleted, so any
backups still stored there remain recoverable.
