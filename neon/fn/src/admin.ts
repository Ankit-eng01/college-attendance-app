// =============================================================================
// ATTENDIFY ADMIN - NEON FUNCTION
// Readable monitoring console + admin actions for public.attendify_sync.
//
// Auth: every /api/* route requires `Authorization: Bearer <ADMIN_TOKEN>`.
// The HTML shell is public but contains no data; the UI asks for the token and
// keeps it in sessionStorage only.
//
// Routes:
//   GET    /                     - admin UI
//   GET    /health               - unauthenticated liveness
//   GET    /api/stats            - totals, students, subject/attendance sums
//   GET    /api/activity?days=14 - per-day creates/updates
//   GET    /api/records          - paged student summaries incl. last device (?search=&sort=&limit=&offset=)
//   GET    /api/records/:code    - one record incl. full `data` and derived `device`
//   DELETE /api/records/:code    - delete one record
//   GET    /api/export           - CSV of student summaries incl. device columns
//
// auth_hash is never selected or returned.
// =============================================================================

import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  if (
    err.message?.includes("ECONNRESET") ||
    err.message?.includes("EPIPE") ||
    err.message?.includes("ETIMEDOUT") ||
    err.message?.includes("57P01") ||
    err.message?.includes("Connection terminated")
  ) {
    return;
  }
  console.error("[Attendify Admin] Unexpected pool error:", err.message);
});

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN ?? "").trim();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Numeric JSON values arrive as strings ("12", "37.5"). Guard before casting so
// one malformed payload can never break the whole listing.
const NUM =
  "case when e->>'%COL%' ~ '^[0-9]{1,9}(\\.[0-9]+)?$' then (e->>'%COL%')::numeric else 0 end";
const numExpr = (col: string) => NUM.replace(/%COL%/g, col);

const TARGET_EXPR =
  "case when coalesce(data->>'globalTarget','') ~ '^[0-9]{1,3}$' then (data->>'globalTarget')::int else 75 end";

const SUMMARY_CTE = `
  with base as (
    select sync_code, data, created_at, updated_at,
      case when jsonb_typeof(data->'subjects') = 'array' then data->'subjects' else '[]'::jsonb end as subjects,
      case when jsonb_typeof(data->'device') = 'object' then data->'device' else '{}'::jsonb end as device
    from public.attendify_sync
  ), agg as (
    select b.sync_code, b.data, b.created_at, b.updated_at, b.subjects, b.device,
      coalesce(nullif(b.device->>'label',''), 'Awaiting next sync') as device_label,
      coalesce(nullif(b.device->>'type',''), '-') as device_type,
      coalesce(nullif(b.device->>'browser',''), '-') as device_browser,
      coalesce(nullif(b.device->>'os',''), '-') as device_os,
      coalesce(nullif(b.device->>'access',''), '-') as device_access,
      coalesce(b.device->>'updatedAt', b.updated_at::text) as device_seen_at,
      jsonb_array_length(b.subjects) as subject_count,
      coalesce((select sum(${numExpr("attended")}) from jsonb_array_elements(b.subjects) e), 0) as attended,
      coalesce((select sum(${numExpr("total")}) from jsonb_array_elements(b.subjects) e), 0) as conducted,
      case when jsonb_typeof(b.data->'history') = 'array' then jsonb_array_length(b.data->'history') else 0 end as history_count
    from base b
  )
`;

const SORTS: Record<string, string> = {
  recent: "updated_at desc",
  name: "student_name asc nulls last, updated_at desc",
  attendance: "attendance_pct desc nulls last, updated_at desc",
  shortage: "attendance_pct asc nulls last, updated_at desc",
  subjects: "subject_count desc, updated_at desc",
  device: "device_label asc nulls last, updated_at desc",
};

const app = new Hono();

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/health", (c) =>
  c.json({ status: "ok", service: "attendify-admin", configured: Boolean(ADMIN_TOKEN) })
);
app.get("/api/health", (c) =>
  c.json({ status: "ok", service: "attendify-admin", configured: Boolean(ADMIN_TOKEN) })
);

// --- bearer gate for every API route -----------------------------------------
app.use("/api/*", async (c, next) => {
  if (!ADMIN_TOKEN) {
    return c.json({ error: "ADMIN_TOKEN is not configured on this function" }, 500);
  }
  const header = c.req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, ADMIN_TOKEN)) {
    await sleep(250); // slow down token guessing
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.header("Cache-Control", "no-store");
  await next();
});

// --- UI ----------------------------------------------------------------------
app.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
  );
  return c.html(ADMIN_HTML);
});

// --- stats -------------------------------------------------------------------
app.get("/api/stats", async (c) => {
  try {
    const { rows } = await pool.query(
      `${SUMMARY_CTE}
       select count(*)::int as total,
         count(*) filter (where coalesce(data->>'studentName','') <> '')::int as students,
         coalesce(sum(subject_count), 0)::int as subjects,
         coalesce(sum(attended), 0) as attended,
         coalesce(sum(conducted), 0) as conducted,
         count(*) filter (where updated_at >= now() - interval '24 hours')::int as active_24h,
         count(*) filter (where updated_at >= now() - interval '7 days')::int as active_7d,
         coalesce(sum(pg_column_size(data)), 0)::bigint as bytes,
         count(distinct device_label) filter (where device_label <> 'Awaiting next sync')::int as devices,
         max(updated_at) as newest,
         min(created_at) as oldest
       from agg`
    );
    const r = rows[0];
    const attended = Number(r.attended);
    const conducted = Number(r.conducted);
    return c.json({
      total: r.total,
      students: r.students,
      subjects: r.subjects,
      attended,
      conducted,
      attendance_pct: conducted > 0 ? Math.round((attended / conducted) * 1000) / 10 : null,
      active_24h: r.active_24h,
      active_7d: r.active_7d,
      bytes: Number(r.bytes),
      devices: r.devices,
      newest: r.newest,
      oldest: r.oldest,
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Attendify Admin] stats error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// --- activity ----------------------------------------------------------------
app.get("/api/activity", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 14) || 14, 1), 90);
  try {
    const { rows } = await pool.query(
      `with days as (select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day)
       select to_char(d.day, 'YYYY-MM-DD') as day,
         (select count(*) from public.attendify_sync t where t.updated_at::date = d.day)::int as updates,
         (select count(*) from public.attendify_sync t where t.created_at::date = d.day)::int as creates
       from days d order by d.day`,
      [days]
    );
    return c.json({ days, series: rows });
  } catch (err) {
    console.error("[Attendify Admin] activity error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// --- student / record list ---------------------------------------------------
app.get("/api/records", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 100);
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  const search = (c.req.query("search") ?? "").trim().slice(0, 64);
  const sortKey = String(c.req.query("sort") ?? "recent");
  const orderBy = SORTS[sortKey] ?? SORTS.recent;

  try {
    const { rows } = await pool.query(
      `${SUMMARY_CTE}
       select sync_code,
         coalesce(data->>'studentName', '') as student_name,
         subject_count,
         attended,
         conducted,
         case when conducted > 0 then round(attended * 100.0 / conducted, 1) else null end as attendance_pct,
         ${TARGET_EXPR} as target,
         history_count,
         pg_column_size(data) as bytes,
         device_label,
         device_type,
         device_browser,
         device_os,
         device_access,
         device_seen_at,
         created_at,
         updated_at,
         count(*) over() as total
       from agg
       where ($1 = ''
         or sync_code ilike '%' || $1 || '%'
         or coalesce(data->>'studentName','') ilike '%' || $1 || '%'
         or device_label ilike '%' || $1 || '%'
         or coalesce(device_browser,'') ilike '%' || $1 || '%'
         or coalesce(device_os,'') ilike '%' || $1 || '%'
         or exists (
           select 1 from jsonb_array_elements(subjects) e
           where coalesce(e->>'name','') ilike '%' || $1 || '%'
         ))
       order by ${orderBy}
       limit $2 offset $3`,
      [search, limit, offset]
    );
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return c.json({
      total,
      limit,
      offset,
      search,
      sort: SORTS[sortKey] ? sortKey : "recent",
      records: rows.map((r) => ({
        sync_code: r.sync_code,
        student_name: r.student_name,
        subjects: r.subject_count,
        attended: Number(r.attended),
        conducted: Number(r.conducted),
        attendance_pct: r.attendance_pct === null ? null : Number(r.attendance_pct),
        target: r.target,
        history: r.history_count,
        bytes: Number(r.bytes),
        device_label: r.device_label,
        device_type: r.device_type,
        device_browser: r.device_browser,
        device_os: r.device_os,
        device_access: r.device_access,
        device_seen_at: r.device_seen_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("[Attendify Admin] list error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// --- one record --------------------------------------------------------------
app.get("/api/records/:code", async (c) => {
  const code = c.req.param("code");
  try {
    const { rows } = await pool.query(
      "select sync_code, data, created_at, updated_at, pg_column_size(data) as bytes " +
        "from public.attendify_sync where sync_code = $1",
      [code]
    );
    if (rows.length === 0) return c.json({ error: "Record not found" }, 404);
    const r = rows[0];
    return c.json({
      sync_code: r.sync_code,
      data: r.data,
      device: (r.data && typeof r.data === "object" && r.data.device && typeof r.data.device === "object") ? r.data.device : null,
      bytes: Number(r.bytes),
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  } catch (err) {
    console.error("[Attendify Admin] detail error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// --- delete one record -------------------------------------------------------
app.delete("/api/records/:code", async (c) => {
  const code = c.req.param("code");
  try {
    const { rows } = await pool.query(
      "delete from public.attendify_sync where sync_code = $1 returning sync_code",
      [code]
    );
    if (rows.length === 0) return c.json({ error: "Record not found" }, 404);
    return c.json({ status: "deleted", sync_code: rows[0].sync_code });
  } catch (err) {
    console.error("[Attendify Admin] delete error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// --- csv export (student summaries) ------------------------------------------
app.get("/api/export", async (c) => {
  try {
    const { rows } = await pool.query(
      `${SUMMARY_CTE}
       select sync_code,
         coalesce(data->>'studentName', '') as student_name,
         subject_count, attended, conducted,
         case when conducted > 0 then round(attended * 100.0 / conducted, 1) else null end as attendance_pct,
         ${TARGET_EXPR} as target,
         history_count, pg_column_size(data) as bytes,
         device_label, device_type, device_browser, device_os, device_access, device_seen_at,
         created_at, updated_at
       from agg order by updated_at desc`
    );
    const esc = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const lines = [
      "sync_code,student_name,subjects,attended,conducted,attendance_pct,target,history_entries,bytes,device_label,device_type,device_browser,device_os,device_access,device_seen_at,created_at,updated_at",
    ];
    for (const r of rows) {
      lines.push(
        [
          esc(r.sync_code),
          esc(r.student_name),
          r.subject_count,
          r.attended,
          r.conducted,
          r.attendance_pct ?? "",
          r.target,
          r.history_count,
          r.bytes,
          esc(r.device_label),
          esc(r.device_type),
          esc(r.device_browser),
          esc(r.device_os),
          esc(r.device_access),
          esc(r.device_seen_at),
          esc(r.created_at),
          esc(r.updated_at),
        ].join(",")
      );
    }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="attendify-students.csv"');
    return c.body(lines.join("\n"));
  } catch (err) {
    console.error("[Attendify Admin] export error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;

// =============================================================================
// UI
// All glyphs are HTML entities or CSS escapes so the source stays pure ASCII.
// =============================================================================
const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Attendify Admin</title>
<style>
  :root{
    --bg:#f6f7fb; --panel:#ffffff; --panel2:#f1f3f9; --line:#e3e7f0;
    --text:#101828; --muted:#667085; --accent:#4f6bed; --accent-soft:#eef1fe;
    --ok:#0f9d63; --ok-soft:#e7f7ef; --warn:#b7791f; --warn-soft:#fdf6e7;
    --bad:#d4354a; --bad-soft:#fdecef; --shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px rgba(16,24,40,.06);
    --radius:14px;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0d1117; --panel:#151b26; --panel2:#1b2231; --line:#26303f;
      --text:#e8edf6; --muted:#93a1b5; --accent:#7f93ff; --accent-soft:#1d2440;
      --ok:#3ddc97; --ok-soft:#12301f; --warn:#e3b341; --warn-soft:#33290f;
      --bad:#ff7b8a; --bad-soft:#3a161d; --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
    }
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--accent)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .muted{color:var(--muted)}
  .wrap{max-width:1240px;margin:0 auto;padding:22px}

  header{position:sticky;top:0;z-index:8;background:color-mix(in srgb,var(--panel) 92%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .hbar{max-width:1240px;margin:0 auto;padding:13px 22px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:10px;font-weight:750;letter-spacing:-.2px;font-size:15px}
  .logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(140deg,var(--accent),#8b5cf6);display:grid;place-items:center;color:#fff;font-size:15px}
  .brand small{display:block;font-weight:500;font-size:11.5px;color:var(--muted);letter-spacing:0}
  .spacer{flex:1}
  .btn{appearance:none;background:var(--panel);border:1px solid var(--line);color:var(--text);padding:8px 13px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px;text-decoration:none}
  .btn:hover{border-color:var(--accent);color:var(--accent)}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn.primary:hover{background:#4159d8;color:#fff}
  .btn.ghost{background:transparent}
  .btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
  .btn.danger:hover{background:var(--bad-soft);border-color:var(--bad);color:var(--bad)}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--panel2);border:1px solid var(--line)}
  .pill.ok{background:var(--ok-soft);color:var(--ok);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
  .pill.warn{background:var(--warn-soft);color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
  .pill.bad{background:var(--bad-soft);color:var(--bad);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
  .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
  .switch{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);cursor:pointer;user-select:none}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:13px;margin:22px 0}
  @media(min-width:700px){.cards{grid-template-columns:repeat(3,1fr)}}
  @media(min-width:1180px){.cards{grid-template-columns:repeat(6,1fr)}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:15px 16px;box-shadow:var(--shadow)}
  .card .k{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700;display:flex;align-items:center;gap:6px}
  .card .v{font-size:27px;font-weight:800;letter-spacing:-.6px;margin-top:5px}
  .card .s{font-size:11.5px;color:var(--muted);margin-top:3px}

  .panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:18px;overflow:hidden}
  .panel .phead{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .panel h2{font-size:14px;margin:0;font-weight:750;letter-spacing:-.2px}
  .panel .phead .muted{font-size:12px}
  .pbody{padding:16px 18px}

  .bars{display:flex;align-items:flex-end;gap:7px;height:120px;padding-top:6px}
  .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px;min-width:0;position:relative}
  .bar .fill{width:100%;background:linear-gradient(180deg,var(--accent),#8b5cf6);border-radius:5px 5px 2px 2px;min-height:3px;transition:height .25s}
  .bar .lbl{font-size:10px;color:var(--muted);white-space:nowrap}
  .bar .cnt{font-size:10px;font-weight:700;min-height:13px}

  .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .filters{padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
  .search{position:relative;flex:1;min-width:230px}
  .search input[type=text]{width:100%;padding-left:34px}
  .search .ico{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:12px}
  input[type=text],input[type=password],select{background:var(--panel);border:1px solid var(--line);color:var(--text);padding:9px 11px;border-radius:10px;font-size:13px;outline:none;transition:.15s}
  input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  select{cursor:pointer}

  .tblwrap{overflow:auto}
  table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
  th{position:sticky;top:0;text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700;padding:10px 14px;background:var(--panel2);border-bottom:1px solid var(--line);white-space:nowrap;z-index:1}
  td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
  tbody tr{cursor:pointer;transition:background .12s}
  tbody tr:hover td{background:var(--accent-soft)}
  tbody tr:last-child td{border-bottom:0}
  .who{display:flex;align-items:center;gap:10px;min-width:0}
  .avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:13px;color:#fff;flex:0 0 auto;background:linear-gradient(140deg,var(--accent),#8b5cf6)}
  .who .nm{font-weight:650;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
  .right{text-align:right}
  .bar-mini{width:76px;height:6px;border-radius:99px;background:var(--panel2);overflow:hidden;display:inline-block;vertical-align:middle;margin-right:8px}
  .bar-mini i{display:block;height:100%;border-radius:99px;background:var(--ok)}
  .bar-mini.warn i{background:var(--warn)}
  .bar-mini.bad i{background:var(--bad)}
  .empty{padding:44px 20px;text-align:center;color:var(--muted)}
  .empty .big{font-size:26px;margin-bottom:8px;color:var(--muted);opacity:.7}
  .pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;padding:13px 18px;font-size:12.5px;color:var(--muted);border-top:1px solid var(--line)}

  #gate{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:60;padding:20px}
  #gate .box{width:100%;max-width:392px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:var(--shadow)}
  #gate .logo{width:40px;height:40px;border-radius:12px;font-size:18px;margin-bottom:14px}
  #gate h1{font-size:19px;margin:0 0 5px;letter-spacing:-.3px}
  #gate p{font-size:13px;color:var(--muted);margin:0 0 18px}
  #gate input{width:100%;margin-bottom:10px}
  #gate .btn{width:100%;justify-content:center;padding:10px}
  .err{color:var(--bad);font-size:12.5px;min-height:19px;margin-top:8px}

  #drawer{position:fixed;top:0;right:0;bottom:0;width:min(760px,96vw);background:var(--bg);border-left:1px solid var(--line);transform:translateX(102%);transition:transform .24s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;z-index:40;box-shadow:-20px 0 60px rgba(16,24,40,.14)}
  #drawer.open{transform:none}
  #scrim{position:fixed;inset:0;background:rgba(16,24,40,.4);opacity:0;pointer-events:none;transition:opacity .2s;z-index:35}
  #scrim.on{opacity:1;pointer-events:auto}
  #drawer .dhead{display:flex;align-items:center;gap:11px;padding:15px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
  #drawer .dbody{flex:1;overflow:auto;padding:18px}
  .stu{display:flex;align-items:center;gap:13px;margin-bottom:16px}
  .stu .avatar{width:46px;height:46px;font-size:18px}
  .stu h2{margin:0;font-size:19px;letter-spacing:-.3px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
  .kpi .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:700}
  .kpi .v{font-size:19px;font-weight:800;letter-spacing:-.3px;margin-top:2px}
  .kpi .v small{font-size:12px;font-weight:600;color:var(--muted)}
  h3.sec{font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);margin:20px 0 9px;font-weight:750;display:flex;align-items:center;gap:8px}
  h3.sec .n{background:var(--panel2);border:1px solid var(--line);border-radius:99px;padding:0 7px;font-size:11px;color:var(--text)}
  .subtbl{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .subtbl th{position:static;background:var(--panel2);padding:8px 12px;border-bottom:1px solid var(--line)}
  .subtbl td{padding:10px 12px;border-bottom:1px solid var(--line)}
  .subtbl tr:last-child td{border-bottom:0}
  .tag{display:inline-block;padding:1px 7px;border-radius:6px;font-size:10.5px;font-weight:700;text-transform:capitalize;background:var(--panel2);border:1px solid var(--line);color:var(--muted)}
  .feed{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .feed li{display:flex;align-items:center;gap:11px;padding:9px 13px;border-bottom:1px solid var(--line);font-size:12.5px}
  .feed li:last-child{border-bottom:0}
  .mark{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;flex:0 0 auto}
  .mark.p{background:var(--ok-soft);color:var(--ok)}
  .mark.a{background:var(--bad-soft);color:var(--bad)}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:5px 11px;font-size:12px;color:var(--muted)}
  .chip b{color:var(--text);font-weight:700}
  .dev{display:inline-flex;align-items:center;gap:7px;max-width:210px;padding:4px 9px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);font-size:11.5px;line-height:1.3;color:var(--muted)}
  .dev .devico{font-size:13px;flex:0 0 auto}
  .dev .devtxt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dev b{color:var(--text);font-weight:700}
  .dev.pending{border-style:dashed;color:var(--warn)}
  .dev.pending b{color:var(--warn)}
  details.raw{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-top:18px;overflow:hidden}
  details.raw summary{cursor:pointer;padding:11px 14px;font-size:12.5px;font-weight:700;color:var(--muted);list-style:none}
  details.raw summary::-webkit-details-marker{display:none}
  details.raw summary:before{content:"\25B8";display:inline-block;margin-right:6px;transition:transform .15s}
  details.raw[open] summary:before{transform:rotate(90deg)}
  details.raw pre{margin:0;padding:14px;background:var(--panel2);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;border-top:1px solid var(--line)}
  .note{display:flex;gap:9px;align-items:flex-start;font-size:12px;color:var(--muted);background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 22%,transparent);border-radius:11px;padding:10px 12px;margin-bottom:16px}
  #toast{position:fixed;bottom:22px;left:50%;transform:translate(-50%,24px);background:#101828;color:#fff;padding:10px 16px;border-radius:11px;font-size:12.5px;font-weight:600;opacity:0;pointer-events:none;transition:.22s;z-index:80;box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:90vw}
  #toast.on{opacity:1;transform:translate(-50%,0)}
  @media(max-width:860px){.hide-sm{display:none}.wrap{padding:14px}.hbar{padding:11px 14px}}
</style>
</head>
<body>

<div id="gate">
  <div class="box">
    <div class="logo">&#128202;</div>
    <h1>Attendify Admin</h1>
    <p>Sign in to review every student backup stored in the cloud.</p>
    <input type="password" id="tokenInput" placeholder="Admin token" autocomplete="current-password">
    <button class="btn primary" id="signInBtn">Unlock dashboard</button>
    <div class="err" id="gateErr"></div>
  </div>
</div>

<header>
  <div class="hbar">
    <div class="brand">
      <div class="logo">&#128202;</div>
      <div>Attendify Admin<small>Cloud backup monitor</small></div>
    </div>
    <span class="pill ok" id="connBadge"><span class="dot"></span><span id="connText">live</span></span>
    <div class="spacer"></div>
    <span class="muted mono hide-sm" id="syncedAt">-</span>
    <label class="switch hide-sm"><input type="checkbox" id="autoRefresh" checked> auto 30s</label>
    <button class="btn" id="refreshBtn">&#8635; Refresh</button>
    <a class="btn" id="exportBtn" href="#" download>&#11015; CSV</a>
    <button class="btn ghost" id="signOutBtn">Sign out</button>
  </div>
</header>

<div class="wrap">
  <div class="note">
    <span aria-hidden="true">&#128274;</span>
    <span>Private student data. Values are shown read-only; only deletion changes anything. Auth keys are never exposed; device rows show compact labels only. Older backups show "Sync pending" until the user opens the updated app once.</span>
  </div>

  <div class="cards" id="cards"></div>

  <div class="panel">
    <div class="phead">
      <h2>Students &amp; backups</h2>
      <span class="muted" id="listSummary">-</span>
    </div>
    <div class="filters">
      <div class="toolbar">
        <div class="search">
          <span class="ico" aria-hidden="true">&#128269;</span>
          <input type="text" id="searchInput" placeholder="Search name, code, subject or device...">
        </div>
        <select id="sortSelect">
          <option value="recent">Most recent</option>
          <option value="name">Name A-Z</option>
          <option value="attendance">Attendance high to low</option>
          <option value="shortage">Attendance low to high</option>
          <option value="subjects">Most subjects</option>
          <option value="device">Device A-Z</option>
        </select>
        <select id="limitSelect">
          <option value="25">25 / page</option>
          <option value="50">50 / page</option>
          <option value="100">100 / page</option>
        </select>
      </div>
    </div>
    <div class="tblwrap">
      <table>
        <thead>
          <tr>
            <th>Student</th>
            <th>Attendance</th>
            <th class="right hide-sm">Present</th>
            <th class="right">Subjects</th>
            <th class="right hide-sm">Entries</th>
            <th class="hide-sm">Last device</th>
            <th class="hide-sm">Last synced</th>
            <th class="right"></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="pager">
      <span id="pageInfo">-</span>
      <button class="btn" id="prevBtn">Prev</button>
      <button class="btn" id="nextBtn">Next</button>
    </div>
  </div>

  <div class="panel">
    <div class="phead">
      <h2>Cloud activity</h2>
      <span class="muted">last 14 days</span>
    </div>
    <div class="pbody">
      <div class="bars" id="bars"></div>
    </div>
  </div>
</div>

<div id="scrim"></div>

<div id="drawer" aria-hidden="true">
  <div class="dhead">
    <strong class="mono" id="drawerCode">-</strong>
    <span class="pill" id="drawerSynced" style="display:none"></span>
    <div class="spacer"></div>
    <button class="btn" id="copyBtn">Copy code</button>
    <button class="btn danger" id="deleteBtn">Delete</button>
    <button class="btn ghost" id="closeDrawer" aria-label="Close">&#10005;</button>
  </div>
  <div class="dbody" id="drawerBody"></div>
</div>

<div id="toast"></div>

<script>
(function(){
  var TOKEN_KEY = 'attendify_admin_token';
  var state = { token:'', offset:0, limit:25, search:'', sort:'recent', total:0, current:null, timer:null };

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function n(v){ var x = Number(v); return isFinite(x) ? x : 0; }
  function fmtPct(v){ return (v === null || v === undefined || !isFinite(v)) ? '-' : (Math.round(v * 10) / 10) + '%'; }
  function fmtTime(v){ if(!v) return '-'; var d = new Date(v); if(isNaN(d)) return '-'; return d.toLocaleString([], { dateStyle:'medium', timeStyle:'short' }); }
  function ago(v){ if(!v) return '-'; var d = new Date(v); if(isNaN(d)) return '-'; var s = Math.floor((Date.now() - d.getTime())/1000); if(s < 0) s = 0;
    if(s < 60) return s + 's ago'; if(s < 3600) return Math.floor(s/60) + 'm ago'; if(s < 86400) return Math.floor(s/3600) + 'h ago'; if(s < 2592000) return Math.floor(s/86400) + 'd ago'; return fmtTime(v); }
  function initials(name){ var t = String(name || '').trim(); if(!t) return '?'; var p = t.split(/\s+/); return (p[0][0] + (p.length > 1 ? p[p.length-1][0] : '')).toUpperCase(); }
  function grade(pct, target){
    if(pct === null || pct === undefined) return 'none';
    if(pct >= target) return 'ok';
    if(pct >= Math.max(0, target - 10)) return 'warn';
    return 'bad';
  }
  function fmtBytes(b){
    if(!b) return '0 B';
    if(b < 1024) return b + ' B';
    if(b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(2) + ' MB';
  }
  function toast(msg){
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove('on'); }, 2400);
  }

  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = 'Bearer ' + state.token;
    opts.cache = 'no-store';
    return fetch(path, opts).then(function(r){
      if(r.status === 401){ signOut('Session expired. Enter the token again.'); throw new Error('unauthorized'); }
      return r.json().then(function(b){ if(!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; });
    });
  }

  function showGate(msg){ $('gate').style.display = 'flex'; $('gateErr').textContent = msg || ''; $('tokenInput').focus(); }
  function hideGate(){ $('gate').style.display = 'none'; }
  function setConn(kind, text){
    $('connBadge').className = 'pill ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'bad');
    $('connText').textContent = text;
  }

  function signOut(msg){
    state.token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); } catch(e){}
    if(state.timer){ clearInterval(state.timer); state.timer = null; }
    closeDrawer();
    showGate(msg || '');
  }

  function loadStats(){
    return api('/api/stats').then(function(s){
      $('syncedAt').textContent = new Date(s.server_time).toLocaleTimeString();
      var cards = [
        { k:'Students', v:s.students, s:s.total + ' cloud backup' + (s.total === 1 ? '' : 's') },
        { k:'Subjects tracked', v:s.subjects, s:'across all students' },
        { k:'Distinct devices', v:s.devices || 0, s:'from latest sync labels' },
        { k:'Overall attendance', v:(s.attendance_pct === null ? '-' : fmtPct(s.attendance_pct)), s:s.attended + ' present of ' + s.conducted + ' classes' },
        { k:'Active today', v:s.active_24h, s:s.active_7d + ' in the last 7 days' },
        { k:'Last sync', v:(s.newest ? ago(s.newest) : '-'), s:s.newest ? fmtTime(s.newest) : 'no backups yet' },
        { k:'Storage', v:fmtBytes(s.bytes), s:'of JSON payload' }
      ];
      $('cards').innerHTML = cards.map(function(c){
        return '<div class="card"><div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v) + '</div><div class="s">' + esc(c.s) + '</div></div>';
      }).join('');
    });
  }

  function loadActivity(){
    return api('/api/activity?days=14').then(function(d){
      var max = 1;
      d.series.forEach(function(p){ if(p.updates > max) max = p.updates; });
      $('bars').innerHTML = d.series.map(function(p){
        var h = Math.round((p.updates / max) * 80) + 3;
        return '<div class="bar" title="' + esc(p.day) + ': ' + p.updates + ' synced, ' + p.creates + ' new">' +
          '<div class="cnt">' + (p.updates || '') + '</div>' +
          '<div class="fill" style="height:' + h + 'px"></div>' +
          '<div class="lbl">' + esc(p.day.slice(5)) + '</div></div>';
      }).join('');
    });
  }

  function loadRecords(){
    var q = '/api/records?limit=' + state.limit + '&offset=' + state.offset +
            '&sort=' + encodeURIComponent(state.sort) + '&search=' + encodeURIComponent(state.search);
    return api(q).then(function(d){
      state.total = d.total;
      if(d.records.length === 0){
        $('rows').innerHTML = '<tr><td colspan="8"><div class="empty"><div class="big">&#128229;</div>' +
          (state.search ? 'No students match "' + esc(state.search) + '".' : 'No cloud backups yet. Once a student finishes setup, their data appears here.') +
          '</div></td></tr>';
      } else {
        $('rows').innerHTML = d.records.map(function(r){
          var pct = r.attendance_pct;
          var g = grade(pct, r.target);
          var name = r.student_name || 'Unnamed student';
          var devicePending = r.device_label === 'Awaiting next sync';
          var deviceTitle = devicePending
            ? 'Open Attendify on this device once to report it'
            : [r.device_label, r.device_browser, r.device_os, r.device_access].filter(function(x){ return x && x !== '-'; }).join(' | ');
          var deviceIcon = devicePending ? '&#8987;' : (String(r.device_type || '').toLowerCase().indexOf('mobile') >= 0 ? '&#128241;' : String(r.device_type || '').toLowerCase().indexOf('tablet') >= 0 ? '&#128241;' : '&#128187;');
          return '<tr data-code="' + esc(r.sync_code) + '">' +
            '<td><div class="who"><div class="avatar">' + esc(initials(r.student_name)) + '</div>' +
              '<div><div class="nm">' + esc(name) + '</div><div class="mono muted">' + esc(r.sync_code) + '</div></div></div></td>' +
            '<td><span class="bar-mini ' + (g === 'none' ? '' : g) + '"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></i></span>' +
              '<b>' + (pct === null ? '-' : fmtPct(pct)) + '</b></td>' +
            '<td class="right hide-sm">' + r.attended + ' / ' + r.conducted + '</td>' +
            '<td class="right">' + r.subjects + '</td>' +
            '<td class="right hide-sm">' + r.history + '</td>' +
            '<td class="hide-sm" title="' + esc(deviceTitle) + '">' +
              '<span class="dev' + (devicePending ? ' pending' : '') + '"><span class="devico">' + deviceIcon + '</span>' +
              '<span class="devtxt"><b>' + esc(devicePending ? 'Sync pending' : r.device_label) + '</b> &middot; ' + esc(devicePending ? 'not reported' : ago(r.device_seen_at || r.updated_at)) + '</span></span></td>' +
            '<td class="hide-sm muted" title="' + esc(fmtTime(r.updated_at)) + '">' + ago(r.updated_at) + '</td>' +
            '<td class="right"><button class="btn" data-open="' + esc(r.sync_code) + '">View</button></td>' +
          '</tr>';
        }).join('');
      }
      var from = state.total === 0 ? 0 : state.offset + 1;
      var to = Math.min(state.offset + state.limit, state.total);
      $('pageInfo').textContent = from + '-' + to + ' of ' + state.total;
      $('listSummary').textContent = state.total + (state.total === 1 ? ' record' : ' records');
      $('prevBtn').disabled = state.offset <= 0;
      $('nextBtn').disabled = state.offset + state.limit >= state.total;
    });
  }

  function refreshAll(){
    setConn('warn', 'loading');
    return Promise.all([loadStats(), loadActivity(), loadRecords()]).then(function(){
      setConn('ok', 'live');
    }).catch(function(e){
      if(e.message === 'unauthorized') return;
      setConn('bad', 'error');
    });
  }

  function closeDrawer(){
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('scrim').classList.remove('on');
    state.current = null;
  }

  function openRecord(code){
    state.current = code;
    $('drawerCode').textContent = code;
    $('drawerSynced').style.display = 'none';
    $('drawerBody').innerHTML = '<div class="empty">Loading...</div>';
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('on');
    api('/api/records/' + encodeURIComponent(code)).then(renderDetail).catch(function(e){
      $('drawerBody').innerHTML = '<div class="empty">Could not load record: ' + esc(e.message) + '</div>';
    });
  }

  function renderDetail(rec){
    var d = rec.data || {};
    var subjects = Array.isArray(d.subjects) ? d.subjects : [];
    var history = Array.isArray(d.history) ? d.history : [];
    var target = n(d.globalTarget) || 75;
    var dev = (rec.device && typeof rec.device === 'object') ? rec.device : {};
    var devPending = !dev.label;
    var nameMap = {};
    subjects.forEach(function(s){ nameMap[s && s.id] = (s && s.name) || 'Subject'; });

    var attended = 0, conducted = 0;
    subjects.forEach(function(s){ attended += n(s.attended); conducted += n(s.total); });
    var overall = conducted > 0 ? (attended * 100 / conducted) : null;
    var g = grade(overall, target);

    $('drawerSynced').style.display = '';
    $('drawerSynced').className = 'pill ' + (g === 'none' ? '' : g);
    $('drawerSynced').innerHTML = '<span class="dot"></span>' + (overall === null ? 'No data yet' : fmtPct(overall) + ' overall') +
      '<span class="muted" style="font-weight:600">&middot; ' + ago(rec.updated_at) + '</span>';

    var html = '';
    html += '<div class="stu"><div class="avatar">' + esc(initials(d.studentName)) + '</div>' +
      '<div><h2>' + esc(d.studentName || 'Unnamed student') + '</h2>' +
      '<div class="mono muted">' + esc(rec.sync_code) + ' &middot; updated ' + esc(fmtTime(rec.updated_at)) + '</div></div></div>';

    html += '<div class="kpis">' +
      '<div class="kpi"><div class="k">Attendance</div><div class="v" style="color:var(--' + (g === 'ok' ? 'ok' : g === 'warn' ? 'warn' : g === 'bad' ? 'bad' : 'muted') + ')">' + (overall === null ? '-' : fmtPct(overall)) + '</div></div>' +
      '<div class="kpi"><div class="k">Present</div><div class="v">' + attended + ' <small>/ ' + conducted + '</small></div></div>' +
      '<div class="kpi"><div class="k">Subjects</div><div class="v">' + subjects.length + '</div></div>' +
      '<div class="kpi"><div class="k">Target</div><div class="v">' + target + '%</div></div>' +
      '<div class="kpi"><div class="k">Entries logged</div><div class="v">' + history.length + '</div></div>' +
      '</div>';

    html += '<h3 class="sec">Device &amp; session</h3>';
    if(devPending) html += '<div class="note" style="margin-bottom:10px"><span aria-hidden="true">&#8987;</span><span>Open Attendify on the user\'s device once to report the device model.</span></div>';
    html += '<div class="chips">' +
      '<span class="chip">Device <b>' + esc(dev.label || 'Awaiting next sync') + '</b></span>' +
      '<span class="chip">Type <b>' + esc(dev.type || '-') + '</b></span>' +
      '<span class="chip">Browser <b>' + esc(dev.browser || '-') + '</b></span>' +
      '<span class="chip">OS <b>' + esc(dev.os || '-') + '</b></span>' +
      '<span class="chip">Screen <b>' + esc(dev.screen || '-') + '</b></span>' +
      '<span class="chip">Access <b>' + esc(dev.access || '-') + '</b></span>' +
      '<span class="chip">Seen <b>' + esc(dev.updatedAt ? ago(dev.updatedAt) : '-') + '</b></span>' +
      '</div>';

    html += '<h3 class="sec">Subjects <span class="n">' + subjects.length + '</span></h3>';
    if(subjects.length === 0){
      html += '<div class="empty" style="padding:22px;background:var(--panel);border:1px solid var(--line);border-radius:12px">No subjects added yet.</div>';
    } else {
      html += '<table class="subtbl"><thead><tr><th>Subject</th><th class="hide-sm">Type</th><th class="right">Present</th><th>Attendance</th><th class="right">Status</th></tr></thead><tbody>';
      subjects.forEach(function(s){
        var a = n(s.attended), t = n(s.total);
        var pct = t > 0 ? (a * 100 / t) : null;
        var subTarget = n(s.target) || target;
        var sg = pct === null ? 'none' : grade(pct, subTarget);
        html += '<tr>' +
          '<td>' + esc(s.name || 'Untitled') + '</td>' +
          '<td class="hide-sm"><span class="tag">' + esc(s.category || 'theory') + '</span></td>' +
          '<td class="right">' + a + ' / ' + t + '</td>' +
          '<td><span class="bar-mini ' + sg + '"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></i></span>' +
            '<b>' + (pct === null ? '-' : fmtPct(pct)) + '</b></td>' +
          '<td class="right">' + (pct === null
            ? '<span class="pill muted">No classes</span>'
            : '<span class="pill ' + (pct >= subTarget ? 'ok' : 'bad') + '">' + (pct >= subTarget ? 'On track' : 'Short') + '</span>') +
          '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
    }

    var sorted = history.slice().sort(function(a, b){
      var av = (a && (a.timestamp || a.date)) || '';
      var bv = (b && (b.timestamp || b.date)) || '';
      return String(bv).localeCompare(String(av));
    });
    html += '<h3 class="sec">Attendance history <span class="n">' + history.length + '</span></h3>';
    if(sorted.length === 0){
      html += '<div class="empty" style="padding:22px;background:var(--panel);border:1px solid var(--line);border-radius:12px">No attendance entries logged yet.</div>';
    } else {
      html += '<ul class="feed">';
      sorted.slice(0, 40).forEach(function(h){
        var present = String(h.status || '').toLowerCase() === 'present';
        html += '<li><span class="mark ' + (present ? 'p' : 'a') + '">' + (present ? '&#10003;' : '&#10005;') + '</span>' +
          '<span style="flex:1">' + esc(nameMap[h.subId] || 'Unknown subject') + '</span>' +
          '<span class="muted">' + esc(h.date || (h.timestamp ? String(h.timestamp).slice(0,10) : '-')) + '</span>' +
          '<span class="pill ' + (present ? 'ok' : 'bad') + '">' + (present ? 'Present' : 'Absent') + '</span></li>';
      });
      html += '</ul>';
      if(sorted.length > 40) html += '<div class="muted" style="font-size:11.5px;margin-top:7px">Showing the 40 most recent of ' + sorted.length + ' entries.</div>';
    }

    var cal = (d.calendar && typeof d.calendar === 'object') ? d.calendar : {};
    var calDays = Object.keys(cal).length;
    var holidays = Object.keys(cal).filter(function(k){ return cal[k] && cal[k].isHoliday; }).length;
    html += '<h3 class="sec">Profile &amp; settings</h3><div class="chips">' +
      '<span class="chip">Theme <b>' + esc(d.activeTheme || 'navy-purple') + '</b></span>' +
      '<span class="chip">Privacy mode <b>' + (d.privacyMode ? 'on' : 'off') + '</b></span>' +
      '<span class="chip">Target <b>' + target + '%</b></span>' +
      '<span class="chip">Calendar days <b>' + calDays + '</b></span>' +
      '<span class="chip">Holidays <b>' + holidays + '</b></span>' +
      '<span class="chip">Payload <b>' + fmtBytes(rec.bytes) + '</b></span>' +
      '<span class="chip">Created <b>' + esc(fmtTime(rec.created_at)) + '</b></span>' +
      '</div>';

    html += '<details class="raw"><summary>Raw backup JSON</summary><pre id="rawJson"></pre></details>';

    $('drawerBody').innerHTML = html;
    var raw = $('rawJson');
    if(raw) raw.textContent = JSON.stringify(rec, null, 2);
  }

  $('signInBtn').addEventListener('click', function(){
    var t = $('tokenInput').value.trim();
    if(!t){ $('gateErr').textContent = 'Token required.'; return; }
    state.token = t;
    api('/api/stats').then(function(){
      try { sessionStorage.setItem(TOKEN_KEY, t); } catch(e){}
      $('tokenInput').value = '';
      hideGate();
      refreshAll();
      if($('autoRefresh').checked) startTimer();
    }).catch(function(e){
      if(e.message === 'unauthorized'){ $('gateErr').textContent = 'That token is not valid.'; }
      else { $('gateErr').textContent = 'Error: ' + e.message; }
    });
  });
  $('tokenInput').addEventListener('keydown', function(e){ if(e.key === 'Enter') $('signInBtn').click(); });

  function startTimer(){
    if(state.timer) clearInterval(state.timer);
    state.timer = setInterval(refreshAll, 30000);
  }

  $('refreshBtn').addEventListener('click', function(){ state.offset = 0; refreshAll(); toast('Refreshed'); });
  $('signOutBtn').addEventListener('click', function(){ signOut('Signed out.'); });
  $('exportBtn').addEventListener('click', function(e){
    e.preventDefault();
    if(!state.token) return;
    fetch('/api/export', { headers: { 'Authorization': 'Bearer ' + state.token }, cache: 'no-store' }).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function(blob){
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'attendify-students.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
      toast('CSV downloaded');
    }).catch(function(err){ toast('Export failed: ' + err.message); });
  });

  var searchTimer = null;
  $('searchInput').addEventListener('input', function(){
    var v = $('searchInput').value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ state.search = v; state.offset = 0; loadRecords(); }, 220);
  });
  $('sortSelect').addEventListener('change', function(){ state.sort = $('sortSelect').value; state.offset = 0; loadRecords(); });
  $('limitSelect').addEventListener('change', function(){ state.limit = parseInt($('limitSelect').value, 10); state.offset = 0; loadRecords(); });
  $('prevBtn').addEventListener('click', function(){ state.offset = Math.max(0, state.offset - state.limit); loadRecords(); });
  $('nextBtn').addEventListener('click', function(){ state.offset += state.limit; loadRecords(); });
  $('autoRefresh').addEventListener('change', function(){
    if(state.timer){ clearInterval(state.timer); state.timer = null; }
    if($('autoRefresh').checked && state.token) startTimer();
  });
  $('rows').addEventListener('click', function(e){
    var tr = e.target.closest('tr[data-code]');
    if(tr) openRecord(tr.getAttribute('data-code'));
  });
  $('closeDrawer').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  $('copyBtn').addEventListener('click', function(){
    var code = state.current; if(!code) return;
    if(navigator.clipboard){ navigator.clipboard.writeText(code).then(function(){ toast('Sync code copied'); }); }
  });
  $('deleteBtn').addEventListener('click', function(){
    var code = state.current;
    if(!code) return;
    if(!confirm('Delete the cloud backup for ' + code + '?\n\nThe student will permanently lose this backup. This cannot be undone.')) return;
    fetch('/api/records/' + encodeURIComponent(code), { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + state.token } })
      .then(function(r){ return r.json().then(function(b){ if(!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; }); })
      .then(function(){ closeDrawer(); refreshAll(); toast('Backup deleted'); })
      .catch(function(err){ toast('Delete failed: ' + err.message); });
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') closeDrawer();
    if(e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)){
      e.preventDefault(); $('searchInput').focus();
    }
  });

  try {
    var saved = sessionStorage.getItem(TOKEN_KEY);
    if(saved){
      state.token = saved;
      api('/api/stats').then(function(){
        hideGate();
        refreshAll();
        if($('autoRefresh').checked) startTimer();
      }).catch(function(){ signOut(''); });
    } else { showGate(''); }
  } catch(e){ showGate(''); }
})();
</script>
</body>
</html>`;
