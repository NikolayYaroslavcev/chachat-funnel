-- ChaChat Funnel — analytics example queries
--
-- Runs against the schema in prisma/schema.prisma (see prisma/migrations for
-- the raw-SQL invariants). Every query below was executed against a running
-- instance of this schema; see README.md "Analytics SQL" for how to run them
-- yourself (`docker compose exec -T db psql -U chachat -d chachat_funnel <
-- docs/analytics-queries.sql`, or paste individual queries into psql/a GUI
-- client).
--
-- Event model recap (spec.md section 10): every row in funnel_events carries
-- session_id, a nullable user_id (set once the visitor has identified),
-- event_name, occurred_at, and an event-specific properties JSONB blob.
-- screen_view rows carry {"screen": ...} and, for the quiz screen only,
-- {"screen": "quiz", "step": "<1..5>"}. There is no "payment" screen_view —
-- Payment is the processing state of the Paywall's purchase request, not a
-- separate route (see AGENTS.md section 1), so payment outcomes are read
-- from payment_attempts / purchase_succeeded / purchase_failed instead.


-- =============================================================================
-- 1. Paywall conversion (required)
-- =============================================================================
-- Question: of the users who reached the Paywall, how many completed a
-- purchase?
--
-- Denominator: distinct users who ever viewed the Paywall screen
-- (screen_view, properties->>'screen' = 'paywall'). User is the right unit
-- here (rather than session) because reaching the Paywall requires an
-- identified user (spec.md section 4.4), and a user who retries a failed
-- payment in a later session should still count once towards conversion.
-- Numerator: distinct users with at least one purchase_succeeded event,
-- regardless of how many payment_attempts (retries) it took to get there.
WITH paywall_viewers AS (
  SELECT DISTINCT user_id
  FROM funnel_events
  WHERE event_name = 'screen_view'
    AND properties ->> 'screen' = 'paywall'
    AND user_id IS NOT NULL
),
purchasers AS (
  SELECT DISTINCT user_id
  FROM funnel_events
  WHERE event_name = 'purchase_succeeded'
    AND user_id IS NOT NULL
)
SELECT
  (SELECT count(*) FROM paywall_viewers) AS users_reached_paywall,
  (SELECT count(*) FROM purchasers)      AS users_purchased,
  round(
    100.0 * (SELECT count(*) FROM purchasers)
          / NULLIF((SELECT count(*) FROM paywall_viewers), 0),
    2
  ) AS paywall_conversion_pct;


-- =============================================================================
-- 2. Quiz drop-off (required)
-- =============================================================================
-- Question: at which quiz question do users stop answering?
--
-- Uses screen_view rows for the quiz screen (properties->>'step', stored as
-- text, cast to int) as "reached question N", counted by distinct session
-- since the quiz runs before a user necessarily exists. quiz_completed is
-- appended as a synthetic step 6 ("finished the whole quiz"). Percentages
-- are relative to step 1 so the drop-off curve is easy to read; a step-6
-- count above step-1 (as can happen with test/API traffic that submits
-- answers without rendering every intermediate screen) is not a bug in the
-- query, just a reminder that screen_view and quiz_answer_submitted are
-- independently-fired events, not a single guaranteed sequence.
--
-- question_key by step: 1=looking_for, 2=memory_importance, 3=story_genre,
-- 4=voice_interest, 5=chat_frequency (see lib/quiz.ts QUIZ_QUESTIONS).
WITH quiz_steps AS (
  SELECT (properties ->> 'step')::int AS step, session_id
  FROM funnel_events
  WHERE event_name = 'screen_view'
    AND properties ->> 'screen' = 'quiz'
),
step_counts AS (
  SELECT step, count(DISTINCT session_id) AS sessions_reached
  FROM quiz_steps
  GROUP BY step

  UNION ALL

  SELECT 6 AS step, count(DISTINCT session_id) AS sessions_reached
  FROM funnel_events
  WHERE event_name = 'quiz_completed'
)
SELECT
  step AS quiz_step,
  sessions_reached,
  round(
    100.0 * sessions_reached
          / NULLIF((SELECT sessions_reached FROM step_counts WHERE step = 1), 0),
    2
  ) AS pct_of_step_1
FROM step_counts
ORDER BY step;


-- =============================================================================
-- 3. Full funnel progression (screen-by-screen)
-- =============================================================================
-- Question: how many sessions reach each of the six funnel screens, in
-- order? Complements query 2 by zooming out from the quiz to the whole
-- funnel. Screen order is fixed explicitly (VALUES list) rather than
-- inferred, since screen_view doesn't carry an ordinal for non-quiz screens.
-- "payment" is intentionally absent — see the header comment above.
WITH screen_order (screen, step_order) AS (
  VALUES ('start', 1), ('quiz', 2), ('email', 3), ('paywall', 4), ('install', 5)
),
screen_sessions AS (
  SELECT properties ->> 'screen' AS screen, count(DISTINCT session_id) AS sessions_reached
  FROM funnel_events
  WHERE event_name = 'screen_view'
  GROUP BY properties ->> 'screen'
)
SELECT so.step_order, so.screen, coalesce(ss.sessions_reached, 0) AS sessions_reached
FROM screen_order so
LEFT JOIN screen_sessions ss USING (screen)
ORDER BY so.step_order;


-- =============================================================================
-- 4. Plan popularity and revenue
-- =============================================================================
-- Question: which plans get purchased, and how much revenue does each bring
-- in? purchases.amount/currency are a snapshot taken at purchase time (see
-- schema comment on Purchase), so this stays correct even if a plan's price
-- is edited later. LEFT JOIN keeps plans with zero purchases visible.
SELECT
  pl.slug,
  pl.name,
  count(pu.id) AS purchases_count,
  coalesce(sum(pu.amount), 0) AS total_revenue
FROM plans pl
LEFT JOIN purchases pu ON pu.plan_id = pl.id
GROUP BY pl.id, pl.slug, pl.name, pl.display_order
ORDER BY pl.display_order;


-- =============================================================================
-- 5. Payment outcome distribution
-- =============================================================================
-- Question: of all payment attempts that reached a terminal state, what
-- share succeeded vs. declined vs. timed out vs. errored? "initiated" and
-- "processing" (in-flight, non-terminal) are excluded so the percentages
-- read as outcome rates, not a snapshot of currently-open attempts.
SELECT
  status,
  count(*) AS attempts,
  round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_of_terminal_attempts
FROM payment_attempts
WHERE status IN ('succeeded', 'declined', 'timed_out', 'errored')
GROUP BY status
ORDER BY attempts DESC;


-- =============================================================================
-- 6. Acquisition performance by UTM source
-- =============================================================================
-- Question: which acquisition sources bring in sessions that actually
-- convert to a purchase? Attribution lives on sessions (spec.md section 8),
-- captured once at session start; sessions with no utm_source are grouped
-- under 'none' (direct/organic traffic) rather than dropped.
WITH session_utm AS (
  SELECT id AS session_id, coalesce(utm_source, 'none') AS utm_source
  FROM sessions
)
SELECT
  su.utm_source,
  count(DISTINCT su.session_id) AS sessions,
  count(DISTINCT fe.session_id) AS sessions_with_purchase,
  round(
    100.0 * count(DISTINCT fe.session_id) / NULLIF(count(DISTINCT su.session_id), 0),
    2
  ) AS conversion_pct
FROM session_utm su
LEFT JOIN funnel_events fe
  ON fe.session_id = su.session_id AND fe.event_name = 'purchase_succeeded'
GROUP BY su.utm_source
ORDER BY sessions DESC;
