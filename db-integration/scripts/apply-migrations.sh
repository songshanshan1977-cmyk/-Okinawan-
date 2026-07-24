#!/usr/bin/env bash
# db-integration/scripts/apply-migrations.sh
#
# Applies, IN THIS EXACT ORDER, against a CI-local disposable Postgres only
# (never a production/staging URL — see the guard below):
#   1. db-integration/sql/00-bootstrap-roles-extensions.sql
#   2. db-integration/sql/01-base-schema-contract.sql   (synthetic fixture)
#   3. supabase/migrations/20260722120000_webhook_fail_safe_v1.sql   (REAL migration 1, unmodified)
#   4. supabase/migrations/20260722130000_webhook_notification_outbox_v1.sql (REAL migration 2, unmodified)
#   5. db-integration/sql/02-seed.sql
#   6. db-integration/sql/90-assert-migration.sql
#
# This order is NOT arbitrary and MUST NOT be changed to make a test pass —
# per the Phase 1 instructions: "不允许为了让测试通过而交换文件顺序; 若当前
# 顺序失败，判定 Blocking 并停止，不修改正式 Migration." If step 3 or 4
# fails, this script stops immediately (set -e + psql -v ON_ERROR_STOP=1)
# and the failure must be recorded as a Blocking finding, not worked around
# here.
#
# Checkpoint after step 3 specifically answers one of the Phase 1 required
# investigative questions: "第一份是否可以在第二份新增 send_logs 字段之前
# 成功 CREATE FUNCTION" — migration 1's process_checkout_payment_v1 body
# references send_logs columns (dedupe_key, notification_type, audience)
# that migration 2 adds. PL/pgSQL function bodies are NOT validated against
# schema at CREATE FUNCTION time (only parsed for PL/pgSQL syntax; table/
# column existence is deferred to first execution) — so step 3 is expected
# to succeed even though those columns don't exist until step 4 runs. If
# step 3 instead fails here, that expectation is wrong and must be recorded
# as a real, surprising finding, not silently reconciled.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set — nothing to do. This is an expected, non-fatal skip in any environment without a real Postgres available (see db-integration/README.md)." >&2
  exit 0
fi

# Hard safety guard: refuse to run against anything that looks like it might
# not be the disposable CI-local database. This is a best-effort string
# check, not a substitute for actually only ever setting DATABASE_URL to a
# CI service container in the first place.
case "$DATABASE_URL" in
  *supabase.co*|*supabase.in*|*amazonaws.com*|*prod*|*production*)
    echo "REFUSING TO RUN: DATABASE_URL looks like it may point at a hosted/production database (matched a forbidden substring). This harness must only ever run against a disposable CI-local Postgres." >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_DIR="$REPO_ROOT/db-integration/sql"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

PSQL="psql -v ON_ERROR_STOP=1 -X -q"

echo "== [1/6] bootstrap roles + extensions =="
$PSQL "$DATABASE_URL" -f "$SQL_DIR/00-bootstrap-roles-extensions.sql"

echo "== [2/6] base schema contract (synthetic fixture, pre-migration baseline) =="
$PSQL "$DATABASE_URL" -f "$SQL_DIR/01-base-schema-contract.sql"

echo "== [3/6] REAL migration 1: 20260722120000_webhook_fail_safe_v1.sql =="
echo "   (checkpoint: does CREATE FUNCTION process_checkout_payment_v1 succeed"
echo "    before migration 2's send_logs columns exist? PL/pgSQL bodies are not"
echo "    schema-validated at CREATE FUNCTION time, so this is EXPECTED to pass.)"
$PSQL "$DATABASE_URL" -f "$MIGRATIONS_DIR/20260722120000_webhook_fail_safe_v1.sql"
echo "   -> migration 1 CREATE FUNCTION succeeded with send_logs.dedupe_key/notification_type/audience not yet present."

echo "== [4/6] REAL migration 2: 20260722130000_webhook_notification_outbox_v1.sql =="
$PSQL "$DATABASE_URL" -f "$MIGRATIONS_DIR/20260722130000_webhook_notification_outbox_v1.sql"

echo "== [5/6] seed data =="
$PSQL "$DATABASE_URL" -f "$SQL_DIR/02-seed.sql"

echo "== [6/6] structural + end-to-end smoke assertions =="
echo "   (checkpoint: first real call to process_checkout_payment_v1 after both"
echo "    migrations are applied — answers 'is a post-migration-2 call to"
echo "    migration 1's function actually successful')"
$PSQL "$DATABASE_URL" -f "$SQL_DIR/90-assert-migration.sql"

echo "== apply-migrations.sh: all steps completed, no deferred-compilation errors observed =="
