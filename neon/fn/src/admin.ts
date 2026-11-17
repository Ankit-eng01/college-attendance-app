// =============================================================================
// ATTENDIFY ADMIN — NEON FUNCTION
// Read-only monitoring console + admin actions for public.attendify_sync.
//
// Auth: every /api/* route requires `Authorization: Bearer <ADMIN_TOKEN>`.
// The HTML shell is public but contains no data; the UI asks for the token and
// keeps it in sessionStorage only.
//
// Routes:
//   GET    /                     — admin UI
//   GET    /api/health           — unauthenticated liveness
//   GET    /api/stats            — totals, activity windows, storage
//   GET    /api/activity?days=14 — per-day creates/updates
//   GET    /api/records          — paged list (?search=&limit=&offset=)
//   GET    /api/records/:code    — one record incl. payload
//   DELETE /api/records/:code    — delete one record
//   GET    /api/export           — CSV of metadata
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
      "select count(*)::int as total, " +
        "count(*) filter (where updated_at >= now() - interval '24 hours')::int as active_24h, " +
        "count(*) filter (where updated_at >= now() - interval '7 days')::int as active_7d, " +
        "coalesce(sum(pg_column_size(data)), 0)::bigint as bytes, " +
        "max(updated_at) as newest, min(created_at) as oldest " +
        "from public.attendify_sync"
    );
    const r = rows[0];
    return c.json({
      total: r.total,
      active_24h: r.active_24h,
      active_7d: r.active_7d,
      bytes: Number(r.bytes),
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
      "with days as (select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day) " +
        "select to_char(d.day, 'YYYY-MM-DD') as day, " +
        "(select count(*) from public.attendify_sync t where t.updated_at::date = d.day)::int as updates, " +
        "(select count(*) from public.attendify_sync t where t.created_at::date = d.day)::int as creates " +
        "from days d order by d.day",
      [days]
    );
    return c.json({ days, series: rows });
  } catch (err) {
    console.error("[Attendify Admin] activity error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// --- record list -------------------------------------------------------------
app.get("/api/records", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 100);
  const rawOffset = Number(c.req.query("offset") ?? 0);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  const search = (c.req.query("search") ?? "").trim().slice(0, 64);

  try {
    const { rows } = await pool.query(
      "select sync_code, " +
        "coalesce(data->>'studentName', '') as student_name, " +
        "case when jsonb_typeof(data->'subjects') = 'array' then jsonb_array_length(data->'subjects') else 0 end as subjects, " +
        "pg_column_size(data) as bytes, created_at, updated_at, " +
        "count(*) over() as total " +
        "from public.attendify_sync " +
        "where ($1 = '' or sync_code ilike '%' || $1 || '%' or coalesce(data->>'studentName', '') ilike '%' || $1 || '%') " +
        "order by updated_at desc limit $2 offset $3",
      [search, limit, offset]
    );
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return c.json({
      total,
      limit,
      offset,
      search,
      records: rows.map((r) => ({
        sync_code: r.sync_code,
        student_name: r.student_name,
        subjects: r.subjects,
        bytes: Number(r.bytes),
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

// --- csv export (metadata only) ----------------------------------------------
app.get("/api/export", async (c) => {
  try {
    const { rows } = await pool.query(
      "select sync_code, coalesce(data->>'studentName','') as student_name, " +
        "case when jsonb_typeof(data->'subjects') = 'array' then jsonb_array_length(data->'subjects') else 0 end as subjects, " +
        "pg_column_size(data) as bytes, created_at, updated_at " +
        "from public.attendify_sync order by updated_at desc"
    );
    const esc = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const lines = ["sync_code,student_name,subjects,bytes,created_at,updated_at"];
    for (const r of rows) {
      lines.push(
        [esc(r.sync_code), esc(r.student_name), r.subjects, r.bytes, esc(r.created_at), esc(r.updated_at)].join(",")
      );
    }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="attendify-sync-records.csv"');
    return c.body(lines.join("\n"));
  } catch (err) {
    console.error("[Attendify Admin] export error:", (err as Error).message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;

// =============================================================================
// UI
// =============================================================================
const ADMIN_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Attendify Admin</title>
<style>
  :root{--bg:#0a0e18;--panel:#111a2e;--panel2:#16203a;--line:#22304f;--text:#e7ecf8;--muted:#8fa0c0;--accent:#6d8bff;--ok:#34d399;--warn:#fbbf24;--bad:#f87171}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  a{color:var(--accent)}
  header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5;flex-wrap:wrap}
  .brand{font-weight:800;font-size:15px;letter-spacing:.2px}
  .brand span{color:var(--accent)}
  .spacer{flex:1}
  .btn{background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:7px 12px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600}
  .btn:hover{border-color:var(--accent)}
  .btn:disabled{opacity:.5;cursor:default}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#0a0e18}
  .btn.danger{color:var(--bad);border-color:#5a2230}
  main{padding:20px;max-width:1180px;margin:0 auto}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-bottom:18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
  .card .k{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:700}
  .card .v{font-size:24px;font-weight:800;margin-top:6px}
  .card .s{font-size:11.5px;color:var(--muted);margin-top:2px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:18px}
  .panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin:0 0 12px}
  .bars{display:flex;align-items:flex-end;gap:6px;height:104px;padding-top:8px}
  .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px;min-width:0}
  .bar .fill{width:100%;background:linear-gradient(180deg,var(--accent),#3c56b8);border-radius:3px 3px 0 0;min-height:3px}
  .bar .lbl{font-size:9.5px;color:var(--muted);white-space:nowrap;letter-spacing:-.2px}
  .bar .cnt{font-size:10px;color:var(--text);font-weight:700;min-height:12px}
  .toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
  input[type=text],input[type=password],select{background:var(--bg);border:1px solid var(--line);color:var(--text);padding:8px 10px;border-radius:8px;font-size:13px;outline:none}
  input[type=text]:focus,input[type=password]:focus,select:focus{border-color:var(--accent)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:9px 10px;border-bottom:1px solid rgba(34,48,79,.55);vertical-align:middle}
  tr:hover td{background:rgba(109,139,255,.05)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .muted{color:var(--muted)}
  .right{text-align:right}
  .empty{padding:26px;text-align:center;color:var(--muted)}
  .pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;padding-top:12px;font-size:12.5px;color:var(--muted)}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid var(--line)}
  .pill.ok{color:var(--ok);border-color:rgba(52,211,153,.35)}
  .pill.warn{color:var(--warn);border-color:rgba(251,191,36,.35)}
  #gate{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px}
  #gate .box{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px}
  #gate h1{font-size:17px;margin:0 0 4px}
  #gate p{font-size:12.5px;color:var(--muted);margin:0 0 16px}
  #gate input{width:100%;margin-bottom:10px}
  .err{color:var(--bad);font-size:12.5px;min-height:18px;margin-top:6px}
  #drawer{position:fixed;top:0;right:0;bottom:0;width:min(620px,94vw);background:var(--panel);border-left:1px solid var(--line);transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column;z-index:20}
  #drawer.open{transform:none}
  #drawer .head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
  #drawer .body{flex:1;overflow:auto;padding:16px}
  pre{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:11.5px;line-height:1.55;overflow:auto;max-height:none;white-space:pre-wrap;word-break:break-word}
  .note{font-size:11.5px;color:var(--warn);background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.25);border-radius:9px;padding:9px 11px;margin-bottom:16px}
  @media(max-width:720px){.hide-sm{display:none}main{padding:12px}}
</style>
</head>
<body>

<div id="gate">
  <div class="box">
    <h1>Attendify Admin</h1>
    <p>Enter the admin token to monitor cloud sync records.</p>
    <input type="password" id="tokenInput" placeholder="Admin token" autocomplete="current-password">
    <button class="btn primary" id="signInBtn" style="width:100%">Unlock</button>
    <div class="err" id="gateErr"></div>
  </div>
</div>

<header>
  <div class="brand">Attendify <span>Admin</span></div>
  <span class="pill ok" id="connBadge">live</span>
  <div class="spacer"></div>
  <span class="muted mono hide-sm" id="syncedAt">—</span>
  <label class="muted hide-sm" style="font-size:12px"><input type="checkbox" id="autoRefresh" checked> auto 30s</label>
  <button class="btn" id="refreshBtn">Refresh</button>
  <a class="btn" id="exportBtn" href="#" download>CSV</a>
  <button class="btn" id="signOutBtn">Sign out</button>
</header>

<main>
  <div class="note">Personal data — student names and attendance records. Do not screenshot or share this console.</div>

  <div class="cards" id="cards"></div>

  <div class="panel">
    <h2>Activity — last 14 days</h2>
    <div class="bars" id="bars"></div>
  </div>

  <div class="panel">
    <div class="toolbar">
      <input type="text" id="searchInput" placeholder="Search sync code or student name" style="min-width:240px;flex:1">
      <select id="limitSelect"><option value="25">25 / page</option><option value="50">50 / page</option><option value="100">100 / page</option></select>
    </div>
    <div style="overflow:auto">
      <table>
        <thead>
          <tr>
            <th>Sync code</th>
            <th class="hide-sm">Student</th>
            <th class="right">Subjects</th>
            <th class="right hide-sm">Size</th>
            <th class="hide-sm">Updated</th>
            <th class="right">Actions</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="pager">
      <span id="pageInfo">—</span>
      <button class="btn" id="prevBtn">Prev</button>
      <button class="btn" id="nextBtn">Next</button>
    </div>
  </div>
</main>

<div id="drawer">
  <div class="head">
    <strong id="drawerTitle" class="mono">record</strong>
    <div class="spacer"></div>
    <button class="btn" id="copyBtn">Copy JSON</button>
    <button class="btn danger" id="deleteBtn">Delete</button>
    <button class="btn" id="closeDrawer">Close</button>
  </div>
  <div class="body"><pre id="drawerBody"></pre></div>
</div>

<script>
(function(){
  var TOKEN_KEY = 'attendify_admin_token';
  var state = { token: '', offset: 0, limit: 25, search: '', total: 0, current: null, timer: null };

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function fmtBytes(n){ if(!n) return '0 B'; if(n < 1024) return n + ' B'; if(n < 1048576) return (n/1024).toFixed(1) + ' KB'; return (n/1048576).toFixed(2) + ' MB'; }
  function fmtTime(v){ if(!v) return '—'; var d = new Date(v); if(isNaN(d)) return '—'; return d.toLocaleString(); }
  function ago(v){ if(!v) return '—'; var d = new Date(v); if(isNaN(d)) return '—'; var s = Math.floor((Date.now() - d.getTime())/1000); if(s < 0) s = 0;
    if(s < 60) return s + 's ago'; if(s < 3600) return Math.floor(s/60) + 'm ago'; if(s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago'; }

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

  function signOut(msg){
    state.token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); } catch(e){}
    if(state.timer){ clearInterval(state.timer); state.timer = null; }
    showGate(msg || '');
  }

  function loadStats(){
    return api('/api/stats').then(function(s){
      $('syncedAt').textContent = 'updated ' + new Date().toLocaleTimeString();
      var cards = [
        ['Records', s.total, s.total === 1 ? '1 cloud backup' : 'cloud backups'],
        ['Active 24h', s.active_24h, 'synced in last day'],
        ['Active 7d', s.active_7d, 'synced in last week'],
        ['Storage', fmtBytes(s.bytes), 'of JSON payload'],
        ['Newest', ago(s.newest), fmtTime(s.newest)],
      ];
      $('cards').innerHTML = cards.map(function(c){
        return '<div class="card"><div class="k">' + esc(c[0]) + '</div><div class="v">' + esc(c[1]) + '</div><div class="s">' + esc(c[2]) + '</div></div>';
      }).join('');
    });
  }

  function loadActivity(){
    return api('/api/activity?days=14').then(function(d){
      var max = 1;
      d.series.forEach(function(p){ if(p.updates > max) max = p.updates; });
      $('bars').innerHTML = d.series.map(function(p){
        var h = Math.round((p.updates / max) * 70) + 3;
        var label = p.day.slice(5);
        return '<div class="bar" title="' + esc(p.day) + ': ' + p.updates + ' updated, ' + p.creates + ' created">' +
          '<div class="cnt">' + (p.updates || '') + '</div>' +
          '<div class="fill" style="height:' + h + 'px"></div>' +
          '<div class="lbl">' + esc(label) + '</div></div>';
      }).join('');
    });
  }

  function loadRecords(){
    var q = '/api/records?limit=' + state.limit + '&offset=' + state.offset + '&search=' + encodeURIComponent(state.search);
    return api(q).then(function(d){
      state.total = d.total;
      if(d.records.length === 0){
        $('rows').innerHTML = '<tr><td colspan="6" class="empty">No records found.</td></tr>';
      } else {
        $('rows').innerHTML = d.records.map(function(r){
          return '<tr>' +
            '<td class="mono">' + esc(r.sync_code) + '</td>' +
            '<td class="hide-sm">' + (r.student_name ? esc(r.student_name) : '<span class="muted">—</span>') + '</td>' +
            '<td class="right">' + r.subjects + '</td>' +
            '<td class="right hide-sm muted">' + fmtBytes(r.bytes) + '</td>' +
            '<td class="hide-sm muted" title="' + esc(fmtTime(r.updated_at)) + '">' + ago(r.updated_at) + '</td>' +
            '<td class="right"><button class="btn" data-open="' + esc(r.sync_code) + '">View</button></td>' +
          '</tr>';
        }).join('');
      }
      var from = state.total === 0 ? 0 : state.offset + 1;
      var to = Math.min(state.offset + state.limit, state.total);
      $('pageInfo').textContent = from + '–' + to + ' of ' + state.total;
      $('prevBtn').disabled = state.offset <= 0;
      $('nextBtn').disabled = state.offset + state.limit >= state.total;
    });
  }

  function refreshAll(){
    $('connBadge').textContent = 'loading';
    $('connBadge').className = 'pill warn';
    Promise.all([loadStats(), loadActivity(), loadRecords()]).then(function(){
      $('connBadge').textContent = 'live';
      $('connBadge').className = 'pill ok';
    }).catch(function(e){
      if(e.message === 'unauthorized') return;
      $('connBadge').textContent = 'error';
      $('connBadge').className = 'pill warn';
    });
  }

  function openRecord(code){
    state.current = code;
    $('drawerTitle').textContent = code;
    $('drawerBody').textContent = 'Loading…';
    $('drawer').classList.add('open');
    api('/api/records/' + encodeURIComponent(code)).then(function(r){
      $('drawerBody').textContent = JSON.stringify(r, null, 2);
    }).catch(function(e){
      $('drawerBody').textContent = 'Error: ' + e.message;
    });
  }

  function closeDrawer(){ $('drawer').classList.remove('open'); state.current = null; }

  // --- events ---------------------------------------------------------------
  $('signInBtn').addEventListener('click', function(){
    var t = $('tokenInput').value.trim();
    if(!t){ $('gateErr').textContent = 'Token required.'; return; }
    state.token = t;
    api('/api/stats').then(function(){
      try { sessionStorage.setItem(TOKEN_KEY, t); } catch(e){}
      $('tokenInput').value = '';
      hideGate();
      refreshAll();
      if($('autoRefresh').checked){
        if(state.timer) clearInterval(state.timer);
        state.timer = setInterval(refreshAll, 30000);
      }
    }).catch(function(e){
      if(e.message === 'unauthorized'){ $('gateErr').textContent = 'Wrong token.'; }
      else { $('gateErr').textContent = 'Error: ' + e.message; }
    });
  });
  $('tokenInput').addEventListener('keydown', function(e){ if(e.key === 'Enter') $('signInBtn').click(); });

  $('refreshBtn').addEventListener('click', function(){ state.offset = 0; refreshAll(); });
  $('signOutBtn').addEventListener('click', function(){ signOut('Signed out.'); });
  $('exportBtn').addEventListener('click', function(e){
    if(!state.token){ e.preventDefault(); return; }
    // CSV needs the Authorization header, so fetch then download as a blob
    e.preventDefault();
    api('/api/export').then(function(){ return null; }).catch(function(){});
    fetch('/api/export', { headers: { 'Authorization': 'Bearer ' + state.token }, cache: 'no-store' }).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function(blob){
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'attendify-sync-records.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
    }).catch(function(e){ alert('Export failed: ' + e.message); });
  });

  $('searchInput').addEventListener('input', function(){
    state.search = $('searchInput').value.trim();
    state.offset = 0;
    loadRecords();
  });
  $('limitSelect').addEventListener('change', function(){
    state.limit = parseInt($('limitSelect').value, 10);
    state.offset = 0;
    loadRecords();
  });
  $('prevBtn').addEventListener('click', function(){
    state.offset = Math.max(0, state.offset - state.limit);
    loadRecords();
  });
  $('nextBtn').addEventListener('click', function(){
    state.offset = state.offset + state.limit;
    loadRecords();
  });
  $('autoRefresh').addEventListener('change', function(){
    if(state.timer){ clearInterval(state.timer); state.timer = null; }
    if($('autoRefresh').checked && state.token){ state.timer = setInterval(refreshAll, 30000); }
  });
  $('rows').addEventListener('click', function(e){
    var b = e.target.closest('button[data-open]');
    if(b) openRecord(b.getAttribute('data-open'));
  });
  $('closeDrawer').addEventListener('click', closeDrawer);
  $('copyBtn').addEventListener('click', function(){
    var txt = $('drawerBody').textContent;
    if(navigator.clipboard){ navigator.clipboard.writeText(txt).then(function(){ $('copyBtn').textContent = 'Copied'; setTimeout(function(){ $('copyBtn').textContent = 'Copy JSON'; }, 1200); }); }
  });
  $('deleteBtn').addEventListener('click', function(){
    var code = state.current;
    if(!code) return;
    if(!confirm('Permanently delete the cloud backup for ' + code + '?\n\nThe student will lose this backup. This cannot be undone.')) return;
    fetch('/api/records/' + encodeURIComponent(code), { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + state.token } }).then(function(r){
      return r.json().then(function(b){ if(!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; });
    }).then(function(){
      closeDrawer();
      refreshAll();
    }).catch(function(e){ alert('Delete failed: ' + e.message); });
  });

  // --- boot -----------------------------------------------------------------
  try {
    var saved = sessionStorage.getItem(TOKEN_KEY);
    if(saved){
      state.token = saved;
      api('/api/stats').then(function(){ hideGate(); refreshAll();
        if($('autoRefresh').checked){ state.timer = setInterval(refreshAll, 30000); }
      }).catch(function(){ signOut(''); });
    } else { showGate(''); }
  } catch(e){ showGate(''); }
})();
</script>
</body>
</html>`;
