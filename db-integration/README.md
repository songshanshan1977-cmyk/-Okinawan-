# Webhook DB Integration — Phase 1: Postgres Contract Fixture

## What this proves, and what it does NOT prove

Passing this harness end to end proves:

**POSTGRES CONTRACT FIXTURE VERIFIED** — the two real migration files under
`supabase/migrations/` and the real rollback file under
`supabase/rollbacks/` are internally self-consistent, syntactically valid
PL/pgSQL, and produce the DDL/behavior their own code implies, when run
against a hand-written synthetic fixture schema
(`db-integration/sql/01-base-schema-contract.sql`) on a real, disposable
`postgres:17` instance.

It does **NOT** prove, and must never be reported as:

- `DB INTEGRATION VERIFIED`
- `PRODUCTION SCHEMA VERIFIED`
- `READY TO MERGE`
- `READY TO DEPLOY`

Two concrete gaps, both intentional for Phase 1:

1. **The fixture schema is synthetic, not a production dump.** Nobody on
   this engagement has ever obtained a real Supabase schema dump (Supabase
   MCP has been unreachable in every round). See
   `db-integration/schema-assumptions.md` for exactly which columns are
   evidenced by the migrations/handler code vs. which are structural
   necessities or historical assumptions this harness had to make up.
2. **Phase 1 tests raw Postgres roles/ACL only, not Supabase's real
   PostgREST/JWT layer.** `anon`/`authenticated`/`service_role` here are
   plain `NOLOGIN` Postgres roles created in
   `db-integration/sql/00-bootstrap-roles-extensions.sql`, exercised via
   `SET ROLE` from a superuser connection. This is a real, literal Postgres
   `REVOKE`/`GRANT` boundary check — it is NOT a PostgREST HTTP request, has
   no JWT claims, and does not exercise any Row Level Security policy (this
   fixture defines none). Real Supabase mediates anon/authenticated/
   service_role access through PostgREST parsing a JWT and setting session
   variables before the query ever reaches Postgres's own permission system
   — Phase 1 does not reproduce that layer. A future phase that needs to
   verify actual PostgREST-mediated behavior (HTTP-level 401/403, PostgREST's
   actual JSON response shape) would need the Supabase CLI's `supabase
   start` (a full local stack: Postgres + PostgREST + GoTrue via Docker
   Compose) rather than a bare `postgres:17` container — that was evaluated
   and explicitly deferred to a later phase; see the read-only round's
   report for the two-tier rationale.

## Why the base schema contract is deliberately pre-migration, not
post-migration

`public.payments` and `public.send_logs` are created in
`01-base-schema-contract.sql` in the shape they had **before** either
forward migration ran (per each migration file's own header comment listing
its "existing columns" assumption). This lets the migrations' own `ALTER
TABLE ... ADD COLUMN IF NOT EXISTS` statements execute real, meaningful DDL
during the test run instead of being no-ops against columns that already
exist. `public.orders`/`public.inventory` are unmodified by either
migration and so are created in full. `public.lock_inventory_v2` is a
**synthetic placeholder** — see `schema-assumptions.md` — that exists only
to prove the rollback script never touches it by name.

## Why this environment cannot run any of it today

This branch was developed in an environment with no local `psql`, no
`docker`/`docker compose`, no `supabase` CLI, and no reachable Supabase MCP
tools. Every `tests/db-integration/*.test.js` file checks
`process.env.DATABASE_URL` at the top and calls `describe.skip(...)` for its
entire suite when it is unset — `npm test` here reports these suites as
**skipped**, not passing, and the completion report for this round says so
explicitly rather than claiming anything was executed.

## How this is meant to run for real

Only inside `.github/workflows/webhook-db-contract.yml` (a **draft**,
committed but not pushed this round, and with no `push`/`pull_request`
trigger wired up yet — see the file's own header comment). That workflow:

1. Starts a `postgres:17` GitHub Actions service container — fixed,
   non-secret, CI-local-only credentials (`postgres_ci_only`), never a
   repository Secret, never anything resembling a production connection
   string. `db-integration/scripts/apply-migrations.sh` and
   `apply-rollback.sh` both additionally refuse to run (hard exit 1) if
   `DATABASE_URL` contains `supabase.co`, `supabase.in`, `amazonaws.com`,
   `prod`, or `production` as a defense-in-depth guard against ever
   accidentally pointing this at something real.
2. Runs `db-integration/scripts/apply-migrations.sh`, which applies, in
   this exact fixed order (see that script's own header for why the order
   matters and must never be swapped to make a test pass):
   `00-bootstrap-roles-extensions.sql` → `01-base-schema-contract.sql` →
   the real migration 1 → the real migration 2 → `02-seed.sql` →
   `90-assert-migration.sql`.
3. Runs `npx jest tests/db-integration` for real, against that database.
4. Runs `db-integration/scripts/apply-rollback.sh` twice in a row (proving
   idempotency), which applies the real rollback file and then checks row
   counts and structural state before/after.

## Files in this directory

| File | Purpose |
|---|---|
| `sql/00-bootstrap-roles-extensions.sql` | Creates `pgcrypto`, the three test Postgres roles (`anon`/`authenticated`/`service_role`) |
| `sql/01-base-schema-contract.sql` | The synthetic pre-migration fixture schema (see schema-assumptions.md) |
| `sql/02-seed.sql` | One reusable inventory range + one baseline order, for smoke tests and any test that wants the default fixture |
| `sql/90-assert-migration.sql` | Post-migration structural + end-to-end smoke assertions (raises a real Postgres exception on any failure) |
| `sql/99-assert-rollback.sql` | Post-rollback structural assertions (functions gone, columns/indexes/lock_inventory_v2 preserved) |
| `scripts/apply-migrations.sh` | Orchestrates the fixed apply order end to end |
| `scripts/apply-rollback.sh` | Applies the real rollback file, checks row-count invariance, runs `99-assert-rollback.sql` |
| `schema-assumptions.md` | Field-by-field provenance for every column in the fixture schema |

`tests/db-integration/helpers/postgres.js` and the four `tests/db-integration/*.test.js`
files are the actual Jest suites (see each file's own header comment).
