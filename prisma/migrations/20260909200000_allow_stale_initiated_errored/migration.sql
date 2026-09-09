-- Stage 12 (concurrency/idempotency): a payment_attempt can be abandoned
-- while still `initiated` — created, but never reached `processing` because
-- the request was interrupted before that update ran (crash, unhandled
-- rejection, process restart). Since `initiated`/`processing` are both
-- "active" for the one-active-attempt-per-user partial unique index, a
-- stuck `initiated` row would otherwise block that user's future legitimate
-- payments forever, with no valid transition able to clear it.
--
-- This adds exactly one edge to the existing forward-only state machine:
-- `initiated -> errored`, alongside the already-valid `processing ->
-- errored`. It does not touch success/decline/timeout, does not allow
-- skipping `processing` for an attempt that actually reached the PSP, and
-- does not permit leaving a terminal state. The application only takes this
-- edge for an attempt that has been non-terminal for longer than any real
-- fake-PSP round trip could take (see STALE_ACTIVE_ATTEMPT_MS in
-- lib/payment.ts) — i.e. it is recognizing an already-abandoned attempt as
-- errored, not fabricating a new outcome for one still in flight.
CREATE OR REPLACE FUNCTION "payment_attempts_status_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  ELSIF OLD."status" = 'initiated' AND NEW."status" IN ('processing', 'errored') THEN
    RETURN NEW;
  ELSIF OLD."status" = 'processing' AND NEW."status" IN ('succeeded', 'declined', 'timed_out', 'errored') THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'invalid payment_attempt status transition: % -> % (attempt=%)',
      OLD."status", NEW."status", OLD."id";
  END IF;
END;
$$ LANGUAGE plpgsql;
