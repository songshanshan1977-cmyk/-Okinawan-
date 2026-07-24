#!/usr/bin/env bash
# db-integration/scripts/apply-rollback.sh
#
# Applies supabase/rollbacks/20260722120000_webhook_fail_safe_v1_rollback.sql
# (REAL rollback file, unmodified) against the CI-local Postgres, then:
#   1. verifies public.orders/payments/inventory/send_logs row counts are
#      EXACTLY unchanged (captured immediately before vs. immediately after
#      the rollback SQL runs) — the row-count half of the non-destructive-
#      rollback guarantee that db-integration/sql/99-assert-rollback.sql's
#      column/index/function checks don't cover;
#   2. runs db-integration/sql/99-assert-rollback.sql for the structural
#      checks (functions gone, columns/indexes/lock_inventory_v2 preserved).
#
# Safe to run more than once in a row — DROP FUNCTION IF EXISTS is a no-op
# once the functions are already gone, and row counts (already stable) stay
# stable across a second run too.

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set — nothing to do (expected skip, see db-integration/README.md)." >&2
  exit 0
fi

case "$DATABASE_URL" in
  *supabase.co*|*supabase.in*|*amazonaws.com*|*prod*|*production*)
    echo "REFUSING TO RUN: DATABASE_URL looks like it may point at a hosted/production database (matched a forbidden substring)." >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_DIR="$REPO_ROOT/db-integration/sql"
ROLLBACK_FILE="$REPO_ROOT/supabase/rollbacks/20260722120000_webhook_fail_safe_v1_rollback.sql"

PSQL="psql -v ON_ERROR_STOP=1 -X -q"
PSQL_SCALAR="psql -v ON_ERROR_STOP=1 -X -q -t -A"

count_all() {
  echo "orders=$($PSQL_SCALAR "$DATABASE_URL" -c 'SELECT count(*) FROM public.orders;')"
  echo "payments=$($PSQL_SCALAR "$DATABASE_URL" -c 'SELECT count(*) FROM public.payments;')"
  echo "inventory=$($PSQL_SCALAR "$DATABASE_URL" -c 'SELECT count(*) FROM public.inventory;')"
  echo "send_logs=$($PSQL_SCALAR "$DATABASE_URL" -c 'SELECT count(*) FROM public.send_logs;')"
}

echo "== [1/3] row counts BEFORE rollback =="
BEFORE="$(count_all)"
echo "$BEFORE"

echo "== [2/3] REAL rollback: 20260722120000_webhook_fail_safe_v1_rollback.sql =="
$PSQL "$DATABASE_URL" -f "$ROLLBACK_FILE"

echo "== row counts AFTER rollback =="
AFTER="$(count_all)"
echo "$AFTER"

if [ "$BEFORE" != "$AFTER" ]; then
  echo "ASSERT FAILED: row counts changed across rollback — this violates the non-destructive rollback guarantee." >&2
  echo "BEFORE: $BEFORE" >&2
  echo "AFTER:  $AFTER" >&2
  exit 1
fi
echo "ASSERT OK: row counts identical before and after rollback (no business/audit data deleted)"

echo "== [3/3] structural rollback assertions =="
$PSQL "$DATABASE_URL" -f "$SQL_DIR/99-assert-rollback.sql"

echo "== apply-rollback.sh: completed =="
