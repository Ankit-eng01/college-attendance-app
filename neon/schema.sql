-- =============================================================================
-- ATTENDIFY CLOUD SYNC - NEON DATABASE SCHEMA
-- =============================================================================
-- Requires: pgcrypto extension for SHA-256 hashing
-- Run this once on the Neon project's main/production branch

-- Enable pgcrypto for SHA-256 hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- TABLE: attendify_sync
-- Stores encrypted cloud backup records per student
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.attendify_sync (
  id           BIGSERIAL   PRIMARY KEY,
  sync_code    TEXT        NOT NULL UNIQUE,
  auth_hash    TEXT        NOT NULL,            -- SHA-256 hash of the student's private secret key
  data         JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on sync_code for fast lookups
CREATE INDEX IF NOT EXISTS idx_attendify_sync_code ON public.attendify_sync (sync_code);

-- =============================================================================
-- FUNCTION: attendify_sync_push
-- Upserts attendance data for a given sync_code after verifying the auth token
-- =============================================================================
CREATE OR REPLACE FUNCTION public.attendify_sync_push(
  p_sync_code  TEXT,
  p_auth_token TEXT,
  p_data       JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing  RECORD;
  v_hash      TEXT;
BEGIN
  -- Validate inputs
  IF p_sync_code IS NULL OR length(p_sync_code) < 6 OR length(p_sync_code) > 64 THEN
    RAISE EXCEPTION 'Invalid sync code' USING ERRCODE = '22023';
  END IF;
  IF p_auth_token IS NULL OR length(p_auth_token) < 16 OR length(p_auth_token) > 128 THEN
    RAISE EXCEPTION 'Invalid auth token' USING ERRCODE = '22023';
  END IF;

  -- Compute SHA-256 hash of the auth token
  v_hash := encode(digest(p_auth_token::bytea, 'sha256'), 'hex');

  -- Check if a record exists for this sync_code
  SELECT id, auth_hash INTO v_existing
  FROM public.attendify_sync
  WHERE sync_code = p_sync_code;

  IF FOUND THEN
    -- Verify the auth token hash matches
    IF v_existing.auth_hash <> v_hash THEN
      RAISE EXCEPTION 'Authorization failed: token mismatch' USING ERRCODE = '42501';
    END IF;
    -- Update existing record
    UPDATE public.attendify_sync
    SET data       = p_data,
        updated_at = NOW()
    WHERE id = v_existing.id;
  ELSE
    -- Insert new record
    INSERT INTO public.attendify_sync (sync_code, auth_hash, data)
    VALUES (p_sync_code, v_hash, p_data);
  END IF;

  RETURN jsonb_build_object(
    'status',    'success',
    'sync_code', p_sync_code
  );
END;
$$;

-- =============================================================================
-- FUNCTION: attendify_sync_pull
-- Retrieves attendance data after verifying the auth token
-- =============================================================================
CREATE OR REPLACE FUNCTION public.attendify_sync_pull(
  p_sync_code  TEXT,
  p_auth_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record RECORD;
  v_hash   TEXT;
BEGIN
  -- Compute SHA-256 hash of the auth token
  v_hash := encode(digest(p_auth_token::bytea, 'sha256'), 'hex');

  -- Look up the record
  SELECT id, auth_hash, data INTO v_record
  FROM public.attendify_sync
  WHERE sync_code = p_sync_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Record not found for sync code' USING ERRCODE = 'P0002';
  END IF;

  -- Verify the auth token hash
  IF v_record.auth_hash <> v_hash THEN
    RAISE EXCEPTION 'Authorization failed: token mismatch' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'status', 'success',
    'data',   v_record.data
  );
END;
$$;

-- =============================================================================
-- FUNCTION: attendify_sync_delete
-- Permanently deletes the cloud record after verifying the auth token
-- =============================================================================
CREATE OR REPLACE FUNCTION public.attendify_sync_delete(
  p_sync_code  TEXT,
  p_auth_token TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record RECORD;
  v_hash   TEXT;
  v_rows   INT;
BEGIN
  -- Compute SHA-256 hash of the auth token
  v_hash := encode(digest(p_auth_token::bytea, 'sha256'), 'hex');

  -- Look up the record
  SELECT id, auth_hash INTO v_record
  FROM public.attendify_sync
  WHERE sync_code = p_sync_code;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Verify the auth token hash
  IF v_record.auth_hash <> v_hash THEN
    RAISE EXCEPTION 'Authorization failed: token mismatch' USING ERRCODE = '42501';
  END IF;

  -- Delete the record
  DELETE FROM public.attendify_sync WHERE id = v_record.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'status',       CASE WHEN v_rows > 0 THEN 'deleted' ELSE 'not_found' END,
    'rows_deleted', v_rows
  );
END;
$$;

-- =============================================================================
-- TABLE: attendify_accounts
-- Email/password accounts. Passwords are scrypt-hashed in the API layer; the
-- pairing secret is AES-GCM encrypted with ACCOUNT_TOKEN_SECRET so it can be
-- returned to the student after a successful login.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.attendify_accounts (
  email          TEXT        PRIMARY KEY,
  password_hash  TEXT        NOT NULL,
  sync_code      TEXT        NOT NULL UNIQUE,
  auth_token_enc TEXT        NOT NULL,
  student_name   TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendify_accounts_sync_code
  ON public.attendify_accounts (sync_code);
