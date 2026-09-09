-- CreateEnum
CREATE TYPE "funnel_event_name" AS ENUM ('screen_view', 'quiz_answer_submitted', 'quiz_completed', 'email_submitted', 'plan_selected', 'purchase_attempted', 'purchase_succeeded', 'purchase_failed', 'install_viewed');

-- CreateEnum
CREATE TYPE "payment_attempt_status" AS ENUM ('initiated', 'processing', 'succeeded', 'declined', 'timed_out', 'errored');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitors" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT,

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "referrer" TEXT,
    "landing_url" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_answers" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "question_key" TEXT NOT NULL,
    "answer_value" TEXT NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiz_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funnel_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_name" "funnel_event_name" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "properties" JSONB,
    "payment_attempt_id" TEXT,
    "purchase_id" TEXT,
    "plan_id" TEXT,

    CONSTRAINT "funnel_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_amount" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "billing_period_days" INTEGER NOT NULL,
    "display_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "payment_attempt_status" NOT NULL DEFAULT 'initiated',
    "masked_card_number" TEXT,
    "result_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "payment_attempt_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visitors_user_id_idx" ON "visitors"("user_id");

-- CreateIndex
CREATE INDEX "sessions_visitor_id_idx" ON "sessions"("visitor_id");

-- CreateIndex
CREATE INDEX "sessions_started_at_idx" ON "sessions"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "quiz_answers_session_id_question_key_key" ON "quiz_answers"("session_id", "question_key");

-- CreateIndex
CREATE INDEX "funnel_events_session_id_idx" ON "funnel_events"("session_id");

-- CreateIndex
CREATE INDEX "funnel_events_user_id_idx" ON "funnel_events"("user_id");

-- CreateIndex
CREATE INDEX "funnel_events_event_name_idx" ON "funnel_events"("event_name");

-- CreateIndex
CREATE INDEX "funnel_events_occurred_at_idx" ON "funnel_events"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");

-- CreateIndex
CREATE INDEX "payment_attempts_user_id_idx" ON "payment_attempts"("user_id");

-- CreateIndex
CREATE INDEX "payment_attempts_plan_id_idx" ON "payment_attempts"("plan_id");

-- CreateIndex
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_payment_attempt_id_key" ON "purchases"("payment_attempt_id");

-- CreateIndex
CREATE INDEX "purchases_user_id_idx" ON "purchases"("user_id");

-- CreateIndex
CREATE INDEX "purchases_plan_id_idx" ON "purchases"("plan_id");

-- CreateIndex
CREATE INDEX "purchases_purchased_at_idx" ON "purchases"("purchased_at");

-- AddForeignKey
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "visitors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_answers" ADD CONSTRAINT "quiz_answers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants that plain Prisma schema constructs cannot express. Each one is
-- referenced by a comment on the corresponding model in schema.prisma.
-- ---------------------------------------------------------------------------

-- users.email uniqueness is case-insensitive (spec 5-6): a plain @unique
-- would give a case-sensitive btree constraint, so identity is enforced by a
-- functional unique index on lower(email) instead.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (LOWER("email"));

-- visitors.user_id, once set to a non-null value, must never change to a
-- different user (spec 5) — only a repeat write of the same value is
-- allowed. A CHECK constraint can't see the previous row, so this is a
-- BEFORE UPDATE trigger instead.
CREATE FUNCTION "visitors_user_id_immutable"() RETURNS trigger AS $$
BEGIN
  IF OLD."user_id" IS NOT NULL AND NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'visitors.user_id is immutable once set (visitor=%, old_user=%, new_user=%)',
      OLD."id", OLD."user_id", NEW."user_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_visitors_user_id_immutable"
BEFORE UPDATE ON "visitors"
FOR EACH ROW EXECUTE FUNCTION "visitors_user_id_immutable"();

-- funnel_events are append-only (spec 9): block UPDATE and DELETE entirely.
CREATE FUNCTION "funnel_events_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'funnel_events is append-only: % is not allowed (event=%)', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_funnel_events_no_update"
BEFORE UPDATE ON "funnel_events"
FOR EACH ROW EXECUTE FUNCTION "funnel_events_append_only"();

CREATE TRIGGER "trg_funnel_events_no_delete"
BEFORE DELETE ON "funnel_events"
FOR EACH ROW EXECUTE FUNCTION "funnel_events_append_only"();

-- At most one non-terminal (initiated/processing) payment_attempt per user
-- at a time (spec 13 — the definition of "one logical payment operation").
-- A partial unique index both encodes the rule and enforces it under real
-- concurrency: a second concurrent INSERT for the same user fails the index
-- at commit time instead of racing past a plain application-level check.
CREATE UNIQUE INDEX "payment_attempts_one_active_per_user"
ON "payment_attempts" ("user_id")
WHERE "status" IN ('initiated', 'processing');

-- payment_attempts.status only moves forward along the allowed edges
-- (initiated -> processing -> succeeded|declined|timed_out|errored) and
-- never leaves a terminal state (spec 11). Re-setting the same status is a
-- harmless no-op (idempotent retries), everything else is rejected.
CREATE FUNCTION "payment_attempts_status_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  ELSIF OLD."status" = 'initiated' AND NEW."status" = 'processing' THEN
    RETURN NEW;
  ELSIF OLD."status" = 'processing' AND NEW."status" IN ('succeeded', 'declined', 'timed_out', 'errored') THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'invalid payment_attempt status transition: % -> % (attempt=%)',
      OLD."status", NEW."status", OLD."id";
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_payment_attempts_status_transition"
BEFORE UPDATE OF "status" ON "payment_attempts"
FOR EACH ROW EXECUTE FUNCTION "payment_attempts_status_transition"();

-- A purchase may only be created for a payment_attempt that is already
-- succeeded (spec 11: "purchase создаётся строго в момент и атомарно с
-- переходом attempt в succeeded"). Combined with the unique
-- payment_attempt_id column above (1 purchase per attempt), this is the
-- database-level half of "no succeeded attempt without a purchase and no
-- purchase without a succeeded attempt" — the atomicity of attempt-update +
-- purchase-insert happening together is an application-transaction concern
-- for the payment implementation stage, not something a single table's
-- constraints can guarantee on their own.
CREATE FUNCTION "purchases_require_succeeded_attempt"() RETURNS trigger AS $$
DECLARE
  attempt_status "payment_attempt_status";
BEGIN
  SELECT "status" INTO attempt_status
  FROM "payment_attempts"
  WHERE "id" = NEW."payment_attempt_id";

  IF attempt_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'purchase % requires a succeeded payment_attempt (attempt=%, status=%)',
      NEW."id", NEW."payment_attempt_id", attempt_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_purchases_require_succeeded_attempt"
BEFORE INSERT ON "purchases"
FOR EACH ROW EXECUTE FUNCTION "purchases_require_succeeded_attempt"();
