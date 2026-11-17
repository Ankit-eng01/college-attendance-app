// =============================================================================
// ATTENDIFY SYNC API — NEON FUNCTION
// A lightweight Hono HTTP API running on Neon Functions (Node.js 24)
// Endpoints:
//   POST /auth/register — Create an email/password account
//   POST /auth/login    — Sign in and receive cloud pairing credentials
//   POST /push          — Upsert attendance data to cloud
//   POST /pull          — Restore attendance data from cloud
//   POST /delete        — Permanently delete cloud backup
//   GET  /health        — Health check
// =============================================================================

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// AES-256 key used to seal the pairing secret at rest. Derived from the
// ACCOUNT_TOKEN_SECRET function secret declared as required in neon.ts.
const TOKEN_KEY = process.env.ACCOUNT_TOKEN_SECRET
  ? createHash("sha256").update(process.env.ACCOUNT_TOKEN_SECRET, "utf8").digest()
  : null;

function getTokenKey(): Buffer {
  if (!TOKEN_KEY) throw new Error("ACCOUNT_TOKEN_SECRET is not configured");
  return TOKEN_KEY;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SYNC_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
}

function isValidPassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 128 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scryptAsync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptToken(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Malformed stored pairing token");
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");
  const decipher = createDecipheriv("aes-256-gcm", getTokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function makeSyncCode(): string {
  const bytes = randomBytes(15);
  let str = "";
  for (const b of bytes) str += SYNC_ALPHABET[b % SYNC_ALPHABET.length];
  return `ATN-${str.slice(0, 4)}-${str.slice(4, 8)}-${str.slice(8, 12)}`;
}

function makeAuthToken(): string {
  return randomBytes(24).toString("hex");
}

// Used on the "email not found" path so login timing doesn't reveal whether
// an account exists. Computed lazily once per isolate.
let dummyHashPromise: Promise<string> | null = null;

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

// --- CORS: allow requests from the deployed PWA and local test servers ---
app.use(
  "*",
  cors({
    origin: [
      "https://ankit-eng01.github.io",
      "https://college-attendance-app-nine.vercel.app",
      "http://localhost:3000",
      "http://localhost:8080",
      "http://localhost:4318",
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
  return c.json({
    status: "ok",
    service: "attendify-sync",
    accounts: TOKEN_KEY ? "configured" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// AUTH/REGISTER — Create an email/password account
// Body: { email, password, student_name? }
// Returns the pairing credentials used by the existing /push + /pull flow.
// =============================================================================
app.post("/auth/register", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body?.email);
  const password = body?.password;
  const studentName =
    typeof body?.student_name === "string"
      ? body.student_name.replace(/<[^>]*>/g, "").trim().slice(0, 50)
      : "";

  if (!isValidEmail(email)) {
    return c.json({ error: "Please enter a valid email address." }, 400);
  }
  if (!isValidPassword(password)) {
    return c.json(
      { error: "Password must be 8-128 characters and contain a letter and a number." },
      400
    );
  }
  try {
    getTokenKey();
  } catch {
    return c.json({ error: "Account service is temporarily unavailable." }, 503);
  }

  const passwordHash = await hashPassword(password);

  // Retry if the randomly generated sync code collides with an existing one.
  for (let attempt = 0; attempt < 5; attempt++) {
    const syncCode = makeSyncCode();
    const authToken = makeAuthToken();
    try {
      await pool.query(
        `INSERT INTO public.attendify_accounts
           (email, password_hash, sync_code, auth_token_enc, student_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [email, passwordHash, syncCode, encryptToken(authToken), studentName]
      );
      return c.json({
        status: "success",
        email,
        sync_code: syncCode,
        auth_token: authToken,
        student_name: studentName,
      });
    } catch (err) {
      if (err.code === "23505") {
        const constraint = String(err.constraint || "");
        if (constraint.includes("pkey") || constraint.includes("email")) {
          return c.json(
            { error: "An account with this email already exists. Try signing in." },
            409
          );
        }
        continue; // sync_code collision — try a fresh code
      }
      console.error("[Attendify] Register error:", err.message);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  return c.json({ error: "Could not allocate a sync code. Please try again." }, 500);
});

// =============================================================================
// AUTH/LOGIN — Verify credentials and return the pairing credentials
// Body: { email, password }
// =============================================================================
app.post("/auth/login", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const email = normalizeEmail(body?.email);
  const password = body?.password;

  if (!email || typeof password !== "string" || password.length === 0) {
    return c.json({ error: "Email and password are required." }, 400);
  }
  try {
    getTokenKey();
  } catch {
    return c.json({ error: "Account service is temporarily unavailable." }, 503);
  }

  let record;
  try {
    const result = await pool.query(
      `SELECT email, password_hash, sync_code, auth_token_enc, student_name
         FROM public.attendify_accounts WHERE email = $1`,
      [email]
    );
    record = result.rows[0];
  } catch (err) {
    console.error("[Attendify] Login lookup error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }

  // Always run a real scrypt verification, even for unknown emails, so the
  // response time does not disclose whether the account exists.
  const dummyHash = await (dummyHashPromise ||= hashPassword(
    "attendify-invalid-login-placeholder"
  ));
  const passwordOk = await verifyPassword(password, record?.password_hash || dummyHash);

  if (!record || !passwordOk) {
    await delay(250 + Math.floor(Math.random() * 150));
    return c.json({ error: "Invalid email or password." }, 401);
  }

  try {
    return c.json({
      status: "success",
      email: record.email,
      sync_code: record.sync_code,
      auth_token: decryptToken(record.auth_token_enc),
      student_name: record.student_name || "",
    });
  } catch (err) {
    console.error("[Attendify] Login token decrypt error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
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
