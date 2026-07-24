# Webhook DB Integration Phase 1 — schema-assumptions.md

## What this is, and what it is NOT

`db-integration/sql/01-base-schema-contract.sql` is a **synthetic contract
fixture**, hand-written for this test harness. It is **not** a dump of the
real Supabase project schema — nobody on this engagement has ever obtained a
real schema dump (Supabase MCP has been unreachable in every round of this
whole engagement, including this one). It exists purely so that the two real
migration files
(`supabase/migrations/20260722120000_webhook_fail_safe_v1.sql` and
`supabase/migrations/20260722130000_webhook_notification_outbox_v1.sql`) have
*something* to run `ALTER TABLE` / `CREATE FUNCTION` / `CREATE INDEX`
against, in an empty, disposable, CI-local `postgres:17` container.

Passing every test in this harness proves the migrations are **internally
self-consistent PL/pgSQL and produce the DDL/behavior their own code implies,
against a hand-built fixture that models the columns they reference**. It
does **not** prove the fixture matches the real production schema, and it
does **not** exercise Supabase's PostgREST/JWT/RLS layer (Phase 1 has no
PostgREST — only raw Postgres roles/ACL, see the Phase 1 permission-testing
note in `db-integration/README.md`). Any report produced from this harness
must say **POSTGRES CONTRACT FIXTURE VERIFIED**, never "DB INTEGRATION
VERIFIED", "PRODUCTION SCHEMA VERIFIED", "READY TO MERGE", or "READY TO
DEPLOY".

## Pre-migration vs. post-migration baseline — an important design choice

`public.payments` and `public.send_logs` are each modified by the forward
migrations via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. To let those
`ALTER TABLE` statements actually execute real, meaningful DDL (rather than
being no-ops against columns that already exist), `01-base-schema-contract.sql`
deliberately creates `payments` and `send_logs` in their **pre-migration
baseline** shape only — i.e. exactly the columns each migration file's own
header comment says already existed before this engagement started. The
migrations then add the rest for real, inside the CI run, and
`90-assert-migration.sql` checks the columns exist *after* that.

`public.orders`, `public.inventory`, and `public.lock_inventory_v2` are never
`ALTER`ed by either migration, so they are created in the base contract in
full (no pre/post split needed).

## Provenance categories used below

- **Migration direct reference** — the column/function is read, written, or
  declared by `20260722120000_webhook_fail_safe_v1.sql` or
  `20260722130000_webhook_notification_outbox_v1.sql` themselves.
- **Handler SELECT reference** — the column is not touched by either
  migration, but IS explicitly selected by `pages/api/stripe-webhook.js`'s
  `orders` query (lines 463-468 as of HEAD `58f4d8003fc3affd37f873d26a418f3c432e2807`):
  `order_id, start_date, end_date, car_model_id, driver_lang, duration, email,
  name, phone, wechat, total_price, deposit_amount, balance_due,
  payment_status, inventory_status`.
- **Structural necessity** — required for the fixture to be a working
  relational table (e.g. a primary key) but not itself referenced by any
  migration or handler code. Marked explicitly so it is never mistaken for
  evidence about the real schema.
- **Historical schema assumption** — a type/constraint choice this harness
  had to make because neither the migrations nor the handler pin it down
  precisely (e.g. exact numeric precision of a money column). Chosen
  conservatively; flagged so a future round with real schema access can
  correct it.

## public.orders (pre-existing, unmodified by either migration)

| Column | Type | Provenance |
|---|---|---|
| order_id | text, PRIMARY KEY | Migration direct reference (`WHERE order_id = p_order_id`, `FOR UPDATE`). PK-ness itself is a **historical schema assumption** — no migration declares a constraint on it, but every lookup assumes at most one row per order_id. |
| start_date | date | Migration direct reference (date-range validation, `generate_series`) |
| end_date | date | Migration direct reference (`COALESCE(v_order.end_date, v_order.start_date)`) |
| car_model_id | uuid | Migration direct reference (inventory/payments join key). Type is a **historical schema assumption** based on the UUID-shaped sample value (`453df662-d350-4ab9-b811-61ffcda40d4b`) used in `__tests__/lib/notificationContent.test.js`. |
| driver_lang | text | Migration direct reference (`CASE WHEN upper(coalesce(v_order.driver_lang,'')) = 'JP' ...`). No CHECK constraint added — migration itself does not enforce a fixed value set, so neither does this fixture. |
| duration | integer | Handler SELECT reference only. Not read by either migration's business logic. |
| email | text | Handler SELECT reference (customer notification recipient) |
| name | text | Handler SELECT reference |
| phone | text | Handler SELECT reference |
| wechat | text | Handler SELECT reference |
| total_price | numeric | Handler SELECT reference. Numeric precision is a **historical schema assumption** (unconstrained `numeric`, no fixed scale — neither migration nor handler pins one down). |
| deposit_amount | numeric | Migration direct reference (`p_amount <> (v_order.deposit_amount * 100)` — stored in CNY yuan, compared against Stripe's amount in cents). Precision is a **historical schema assumption**, same reasoning as total_price. |
| balance_due | numeric | Handler SELECT reference |
| payment_status | text | Migration direct reference (set to `'paid'`, compared against `'paid'`) |
| inventory_status | text | Migration direct reference (set to `'failed'`/`'locked'`) + Handler SELECT reference (also rendered into the `ops_missing_customer_email` alert body) |
| inventory_locked | boolean | Migration direct reference |
| status | text | Migration direct reference (set to `'new'`) |
| email_customer_sent | boolean, DEFAULT false | Migration direct reference (`complete_webhook_notification_v1` sets true on real send) |
| email_ops_sent | boolean, DEFAULT false | Migration direct reference (same) |

No other `orders` columns are created — the real table almost certainly has
many more (car details, pricing breakdowns, etc.) but none of them are
referenced by the code under test, so per the "only what is referenced"
instruction they are deliberately omitted.

## public.payments — PRE-migration baseline (what 01-base-schema-contract.sql creates)

| Column | Type | Provenance |
|---|---|---|
| id | bigserial, PRIMARY KEY | Structural necessity — no migration references `payments.id` at all |
| order_id | text | Migration direct reference |
| amount | integer | Migration direct reference (`p_amount integer`, Stripe cents) |
| currency | text | Migration direct reference |
| stripe_session_id | text | Migration direct reference (session-level idempotency lookup, later gets the unique index) |
| car_model_id | uuid | Migration direct reference |
| paid | boolean | Migration direct reference (always inserted `true`) |
| created_at | timestamptz, DEFAULT now() | Migration direct reference (`ORDER BY created_at DESC` when re-reading `processing_reason` on an exact replay) |

## public.payments — columns added BY migration 1 (must NOT pre-exist in the base contract)

`processing_result text`, `processing_reason text`, `processed_at timestamptz`
— all three are `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` inside
`20260722120000_webhook_fail_safe_v1.sql` itself. `90-assert-migration.sql`
confirms these three exist only *after* that migration has run.

`payments_stripe_session_id_unique_idx` (partial unique index,
`WHERE stripe_session_id IS NOT NULL`) is likewise created by migration 1,
not by the base contract.

## public.inventory (pre-existing, unmodified by either migration)

| Column | Type | Provenance |
|---|---|---|
| car_model_id | uuid | Migration direct reference |
| driver_lang | text | Migration direct reference |
| date | date | Migration direct reference (`generate_series` day-by-day check, `date BETWEEN ...`) |
| total_qty | integer | Migration direct reference (`total_qty - booked_qty - locked_qty`) |
| booked_qty | integer | Migration direct reference |
| locked_qty | integer | Migration direct reference (`locked_qty = locked_qty + 1` on success) |

Primary key: `(car_model_id, driver_lang, date)` — **historical schema
assumption**, not declared by either migration, but implied by
"every day must have exactly one row" logic (`v_missing_count`/`v_short_count`
checks). Declared as a composite PK here so the fixture can express
"exactly one row per car/lang/day" the same way the migration's own
`generate_series` gap-check logic assumes.

## public.send_logs — PRE-migration baseline (what 01-base-schema-contract.sql creates)

Per `20260722130000_webhook_notification_outbox_v1.sql`'s own header comment
(lines 80-84): *"Existing columns per the schema captured in earlier rounds:
id, order_id, email, subject, status (default 'pending'), error_message,
created_at, provider_message_id."*

| Column | Type | Provenance |
|---|---|---|
| id | bigserial, PRIMARY KEY | Migration's own comment (pre-existing column) |
| order_id | text | Migration's own comment |
| email | text | Migration's own comment |
| subject | text | Migration's own comment |
| status | text, DEFAULT 'pending' | Migration's own comment |
| error_message | text | Migration's own comment |
| created_at | timestamptz, DEFAULT now() | Migration's own comment |
| provider_message_id | text | Migration's own comment |

## public.send_logs — columns added BY migration 2 (must NOT pre-exist in the base contract)

`dedupe_key text`, `notification_type text`, `audience text`,
`stripe_session_id text`, `claim_token uuid`,
`claim_expires_at timestamptz`, `attempt_count integer NOT NULL DEFAULT 0`,
`sent_at timestamptz`, `updated_at timestamptz NOT NULL DEFAULT now()`,
`sender_email text`, `recipient_email text`, `email_subject text`,
`email_html text`, `provider_idempotency_key text`,
`payload_frozen_at timestamptz`, `first_dispatch_at timestamptz` — all 16
via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in
`20260722130000_webhook_notification_outbox_v1.sql`. `send_logs_dedupe_key_
unique_idx` and `send_logs_claimable_idx` are likewise created by that
migration, not the base contract. `90-assert-migration.sql` confirms all of
this only *after* migration 2 has run.

## public.lock_inventory_v2 — SYNTHETIC PLACEHOLDER, explicitly not the real definition

Neither migration ever reads or modifies `lock_inventory_v2` — every round of
this engagement has treated it as an out-of-scope, pre-existing legacy
object that must not be touched, and its real definition has never been read
or captured in any round (reading/changing it has been an explicit red line
throughout). This harness has **no evidence at all** about what
`lock_inventory_v2` actually is beyond its name and the fact that the new
migration's comments describe it as the function the new
`process_checkout_payment_v1` was written to eventually replace, and that it
has a "missing inventory row silently skipped" gap the new function closes.

`01-base-schema-contract.sql` therefore creates a **name-only synthetic
placeholder** — a trivial no-op `public.lock_inventory_v2(...)` function with
an arbitrary signature chosen only so the object exists and is checkable by
name. Its sole purpose is to let `99-assert-rollback.sql` verify that the
non-destructive rollback script's `DROP FUNCTION` statements (which name only
the four new v1 RPCs) do not, even by accident, also remove this object. It
must never be read as evidence of what the real `lock_inventory_v2` does,
what parameters it takes, or what it returns.

## What is deliberately NOT in the base contract

- No RLS policies (Phase 1 tests raw Postgres GRANT/REVOKE only — see
  `db-integration/README.md` for why PostgREST-level RLS/JWT behavior is out
  of scope for Phase 1).
- No foreign keys between `orders`/`payments`/`inventory`/`send_logs` — no
  migration or handler code depends on FK-enforced referential integrity
  (every join is done via explicit application-level `WHERE` clauses), and
  adding FKs the real schema might not have would risk over-constraining the
  fixture relative to what is actually known.
- No columns beyond the ones listed above, even where a real booking system
  almost certainly has many more (pricing breakdown, car details, admin
  metadata, etc.) — out of scope per "only what is referenced."
