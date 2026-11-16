// =============================================================================
// ATTENDIFY SYNC API — NEON FUNCTION
// A lightweight Hono HTTP API running on Neon Functions (Node.js 24)
// Endpoints:
//   POST /push    — Upsert attendance data to cloud
//   POST /pull    — Restore attendance data from cloud
//   POST /delete  — Permanently delete cloud backup
//   GET  /health  — Health check
// =============================================================================

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";

// Module-scope pool: reused across requests on the same isolate
// DATABASE_URL is auto-injected by Neon at runtime
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Suppress idle-disconnect errors (expected from Neon pooler)
pool.on("error", (err) => {
  if (
    err.message?.includes("ECONNRESET") ||
    err.message?.includes("EPIPE") ||
    err.message?.includes("ETIMEDOUT") ||
    err.message?.includes("57P01") ||
    err.message?.includes("Connection terminated")
  ) {
    return; // expected idle disconnects — ignore
  }
  console.error("[Attendify] Unexpected pool error:", err.message);
});

const app = new Hono();

// --- CORS: allow requests from the PWA and GitHub Pages ---
app.use(
  "*",
  cors({
    origin: [
      "https://ankit-eng01.github.io",
      "http://localhost:3000",
      "http://localhost:8080",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// =============================================================================
// HEALTH CHECK
// =============================================================================
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "attendify-sync", timestamp: new Date().toISOString() });
});

// =============================================================================
// PUSH — Upsert attendance data
// Body: { sync_code, auth_token, data }
// =============================================================================
app.post("/push", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sync_code, auth_token, data } = body ?? {};

  if (!sync_code || typeof sync_code !== "string" || sync_code.length < 6 || sync_code.length > 64) {
    return c.json({ error: "Invalid sync_code" }, 400);
  }
  if (!auth_token || typeof auth_token !== "string" || auth_token.length < 16 || auth_token.length > 128) {
    return c.json({ error: "Invalid auth_token" }, 400);
  }
  if (!data || typeof data !== "object") {
    return c.json({ error: "Missing data payload" }, 400);
  }

  try {
    const result = await pool.query(
      "SELECT public.attendify_sync_push($1, $2, $3::jsonb) AS result",
      [sync_code, auth_token, JSON.stringify(data)]
    );
    return c.json(result.rows[0].result);
  } catch (err) {
    if (err.code === "42501") {
      return c.json({ error: "Authorization failed: invalid auth token" }, 401);
    }
    console.error("[Attendify] Push error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// =============================================================================
// PULL — Restore attendance data
// Body: { sync_code, auth_token }
// =============================================================================
app.post("/pull", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sync_code, auth_token } = body ?? {};

  if (!sync_code || typeof sync_code !== "string") {
    return c.json({ error: "Missing sync_code" }, 400);
  }
  if (!auth_token || typeof auth_token !== "string") {
    return c.json({ error: "Missing auth_token" }, 400);
  }

  try {
    const result = await pool.query(
      "SELECT public.attendify_sync_pull($1, $2) AS result",
      [sync_code, auth_token]
    );
    return c.json(result.rows[0].result);
  } catch (err) {
    if (err.code === "42501") {
      return c.json({ error: "Authorization failed: invalid auth token" }, 401);
    }
    if (err.code === "P0002") {
      return c.json({ error: "Record not found for this sync code" }, 404);
    }
    console.error("[Attendify] Pull error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// =============================================================================
// DELETE — Permanently delete cloud backup
// Body: { sync_code, auth_token }
// =============================================================================
app.post("/delete", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { sync_code, auth_token } = body ?? {};

  if (!sync_code || typeof sync_code !== "string") {
    return c.json({ error: "Missing sync_code" }, 400);
  }
  if (!auth_token || typeof auth_token !== "string") {
    return c.json({ error: "Missing auth_token" }, 400);
  }

  try {
    const result = await pool.query(
      "SELECT public.attendify_sync_delete($1, $2) AS result",
      [sync_code, auth_token]
    );
    return c.json(result.rows[0].result);
  } catch (err) {
    if (err.code === "42501") {
      return c.json({ error: "Authorization failed: invalid auth token" }, 401);
    }
    console.error("[Attendify] Delete error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
