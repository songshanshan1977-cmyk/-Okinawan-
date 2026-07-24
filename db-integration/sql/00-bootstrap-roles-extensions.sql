-- db-integration/sql/00-bootstrap-roles-extensions.sql
--
-- Phase 1 CI-only bootstrap. Runs once against an EMPTY postgres:17
-- container, as the container's default superuser, before anything else in
-- this harness. Creates the minimum needed to (a) run the two real
-- migrations' CREATE FUNCTION statements (gen_random_uuid) and (b) test
-- their REVOKE/GRANT permission boundaries with real Postgres roles.
--
-- NOT a Supabase project bootstrap: no PostgREST, no GoTrue, no JWT claims,
-- no `auth` schema. anon/authenticated/service_role here are plain Postgres
-- NOLOGIN roles used only via `SET ROLE` inside this CI session, purely to
-- exercise the REVOKE ALL / GRANT EXECUTE statements the migrations
-- themselves contain. See db-integration/README.md for exactly what this
-- does and does not prove.

-- gen_random_uuid() is a Postgres-13+ core (pg_catalog) builtin, so on the
-- postgres:17 target this extension is not strictly required for
-- claim_webhook_notification_v1's `v_token := gen_random_uuid();` call to
-- work. It is created anyway, defensively, because real Supabase projects
-- commonly have pgcrypto enabled and this keeps the fixture closer to that
-- reality at zero cost (CREATE EXTENSION IF NOT EXISTS is a safe no-op if
-- the core builtin already resolves first).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Minimal Postgres-role stand-ins for Supabase's three well-known DB roles.
-- NOLOGIN: nothing ever connects directly as these roles in this harness;
-- the test suite uses `SET ROLE <role>` from the superuser connection to
-- run a statement "as" one of them, then `RESET ROLE` back. This is a real,
-- literal Postgres permission check (a real REVOKE/GRANT boundary), just
-- without the PostgREST/JWT layer that mediates real anon/authenticated/
-- service_role access in production Supabase.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

-- Each of these roles needs USAGE on the public schema and (for
-- service_role specifically) the ability to actually read/write the
-- fixture tables once EXECUTE is granted on the RPCs — the RPCs are
-- SECURITY DEFINER so they run as the function owner regardless of caller,
-- but the caller still needs USAGE on the schema to even attempt the call.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
