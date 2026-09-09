-- Stage 12 (concurrency/idempotency): the existing partial unique index
-- `payment_attempts_one_active_per_user` only covers requests that arrive
-- while an attempt is still non-terminal. spec.md 13's "Network failure"
-- scenario also requires recognizing a repeated request as the same
-- logical operation *after* it has already gone terminal (e.g. the server
-- finished and the client never saw the response, then retries) — there is
-- no column to correlate that repeat with the original attempt without one.
--
-- AddColumn
ALTER TABLE "payment_attempts" ADD COLUMN "idempotency_key" TEXT;

-- A plain (non-partial) unique index on (user_id, idempotency_key). NULL
-- never equals NULL in a Postgres unique index, so rows with no key
-- (callers that don't opt in) never collide with each other.
CREATE UNIQUE INDEX "payment_attempts_user_id_idempotency_key_key" ON "payment_attempts"("user_id", "idempotency_key");
