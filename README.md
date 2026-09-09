# ChaChat Funnel

A ChaChat Full-Stack Engineer test assignment: a small full-stack acquisition
funnel for ChaChat, an AI companion/roleplay chat app. The focus is on
correctness of the user scenario, identity handling, attribution, analytics,
and payment logic — including concurrent and repeated requests — rather than
visual polish.

```
Start → Quiz → Email → Paywall → Payment → Install
```

Payment is not a separate route; it's the processing state of the Paywall's
purchase request, handled by a deterministic fake payment processor.

## Tech stack

- **Next.js 16** (App Router) + **React 19** — UI and API routes in one app
- **TypeScript** throughout
- **PostgreSQL 16** — single source of truth for identity, funnel events, quiz
  answers, plans, payment attempts, and purchases
- **Prisma 6** — schema, migrations, and DB client
- **Docker Compose** — single startup path (`postgres:16-alpine` + the app,
  built from the repo `Dockerfile`)
- **Vitest** — test runner, used against a real Postgres instance (no DB
  mocking) for the tests under [tests/](tests/)

No other runtime dependencies are used. If a library isn't in
[package.json](package.json), it isn't part of this project.

## Quick start

```bash
cp .env.example .env
docker compose up
```

This starts two services:

- `db` — Postgres, with a healthcheck gating the app's startup
- `app` — the Next.js app, built from [Dockerfile](Dockerfile)

On every container start, the app's entrypoint runs, in order:
`prisma migrate deploy` → `node prisma/seed.mjs` → `npm run start`. Migrations
are applied automatically and the three-plan catalog (weekly / monthly /
3-months) is (re-)seeded automatically — **no manual database setup step is
required** on a clean checkout. The seed script upserts by plan slug, so it's
also a safe no-op on every subsequent restart.

The app is available at **http://localhost:3000**.

To verify the app can reach the database:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","database":"connected"}
```

## Tests

```bash
docker compose up -d db   # tests run against a real Postgres, not a mock
npm install
npm test                  # vitest run
```

[tests/](tests/) covers identity/session resolution and attribution, the
quiz, the fake PSP, the Paywall, and — most heavily — the payment state
machine, retries, and concurrency (double-click / two-tabs / repeated
request), per [AGENTS.md](AGENTS.md) §6. This is **not** full coverage of the
whole app; per the assignment's scope, testing effort was concentrated on the
critical payment logic and the invariants that back it (identity, session
resolution). UI components and most API route handlers are not
unit-tested directly.

Other checks:

```bash
npm run typecheck
npm run lint
npm run build
```

## Test payment cards

The payment processor is a deterministic **fake PSP** ([lib/fake-psp.ts](lib/fake-psp.ts)) —
no network call is ever made, and outcomes depend only on the card number
entered in the Paywall's custom payment form. These are **not real payment
credentials**; they only work against this project's fake processor.

| Card number            | Outcome | Notes                                                       |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `4242 4242 4242 4242`   | Success | Resolves immediately.                                        |
| `4000 0000 0000 0002`   | Decline | Resolves immediately, reason `card_declined`.                 |
| `4000 0000 0000 0044`   | Timeout | Resolves as `timed_out` after a bounded ~3s simulated delay — never hangs. |

Any other card number (including malformed input) is declined with reason
`unsupported_test_card`. Expiry/CVC are accepted but never affect the
outcome. Full details, including the backend-only/deterministic guarantees:
[docs/fake-psp.md](docs/fake-psp.md).

## Funnel behavior

- **Start** — value proposition, single CTA into the quiz. An anonymous
  **visitor** and **session** are established here (or on first request) and
  persist across the whole funnel, before any identity is known.
- **Quiz** — five product-related questions, one answer saved per step
  (re-answering a step updates the existing answer rather than duplicating
  it).
- **Email** — identifies the visitor as a user. A new email creates a user; an
  existing email **links** the current visitor to that user without losing
  the visitor's quiz/attribution history and without creating a duplicate
  user.
- **Paywall** — three DB-backed subscription plans plus a custom payment form
  (no external redirect).
- **Payment** — the Paywall form's purchase request is processed by the fake
  PSP; the UI reflects the resulting success / decline / timeout state and
  offers retry on failure.
- **Install** — shown only once the identity has a succeeded purchase,
  checked server-side on every visit (not only immediately after paying);
  links to real public ChaChat entry points.
- **Repeat visit** — a returning visitor whose identity already has a
  succeeded purchase is redirected straight to Install regardless of which
  funnel screen the repeat visit lands on (Start, any Quiz step, or Email/
  Paywall — see spec.md §7), and Install re-checks access itself on every
  load.

## Important implementation decisions

These are the decisions most useful to a reviewer. Full rationale:
[docs/spec.md](docs/spec.md).

- **Visitor → user identity model**: a `visitor` (anonymous, cross-session)
  is a distinct entity from `user` (identified by email) and from `session`
  (one visit). This is what makes "existing email → link, don't duplicate"
  possible without merging two full user records. See spec §5–§7.
- **Attribution**: captured once per session (UTM params, referrer, landing
  URL) at session start; a user's canonical attribution is their earliest
  session's attribution (first-touch, never overwritten). See spec §8.
- **DB-backed plan catalog**: the three plans live in the `plans` table
  (seeded, not hardcoded in the UI), so plan data/pricing has one source of
  truth. See [prisma/seed.mjs](prisma/seed.mjs).
- **`payment_attempt` vs `purchase`**: every purchase attempt — successful or
  not — gets a `payment_attempt` row; `purchase` exists only for an attempt
  that reached `succeeded`, created atomically with that transition. This
  distinction is what lets analytics answer "how many tries did it take" and
  is required to reason about idempotency (spec §9, §11).
- **Fake PSP**: a deterministic, backend-only stand-in for a real payment
  provider — same card number always yields the same outcome, whoever calls
  it. See [docs/fake-psp.md](docs/fake-psp.md).
- **Payment state machine**: `initiated → processing → succeeded|declined|timed_out|errored`,
  with no transitions out of a terminal state and no skipping `processing`.
  See spec §11.
- **Concurrency / idempotency**: "one logical payment operation" is defined
  as at most one non-terminal (`initiated`/`processing`) attempt per user at
  a time, enforced by a partial unique index (not just client-side
  debounce), so double-click / two tabs / refresh / repeated request can
  never produce more than one succeeded purchase. See spec §13.
- **Server-side Install guard**: Install is reachable only when the current
  identity has at least one succeeded purchase, re-checked on every visit —
  not a one-time client-side flag. See spec §16.
- **Analytics persisted to PostgreSQL**: funnel events are written to the DB
  as they happen, not just logged client-side, so they survive and are
  queryable independent of any client.

## Analytics

Meaningful funnel actions are persisted to the `funnel_events` table as they
happen (not just logged client-side). Every event carries `session_id`, a
nullable `user_id` (set once the visitor is identified), `event_name`,
`occurred_at`, and an event-specific `properties` JSON payload.

Event categories actually implemented (spec §10):

- `screen_view` — every screen shown (`start`, `quiz`, `email`, `paywall`,
  `install`; quiz views also carry the question step)
- `quiz_answer_submitted`, `quiz_completed`
- `email_submitted` (new vs. existing user)
- `plan_selected`
- `purchase_attempted`, `purchase_succeeded`, `purchase_failed` (with reason)
- `install_viewed`

Example queries against this data: [docs/analytics-queries.sql](docs/analytics-queries.sql).

## Analytics SQL

Run the whole file against the running Postgres container (the `db`
container only sees its own filesystem, so the file has to be piped in over
stdin rather than referenced with `-f`):

```bash
docker compose exec -T db psql -U chachat -d chachat_funnel < docs/analytics-queries.sql
```

(Or paste individual queries into `psql` / any Postgres client using the same
`DATABASE_URL` — see `.env.example`.)

[docs/analytics-queries.sql](docs/analytics-queries.sql) contains six
queries, each with a comment explaining what it answers and how to interpret
it:

1. **Paywall conversion** — of users who reached the Paywall, how many
   completed a purchase (regardless of retries).
2. **Quiz drop-off** — per-question progression through the quiz, plus
   overall completion.
3. **Full funnel progression** — sessions reaching each of the five funnel
   screens, in order.
4. **Plan popularity / revenue** — purchases and revenue per plan.
5. **Payment outcome distribution** — success/decline/timeout/error rate
   among terminal payment attempts.
6. **Acquisition performance by UTM source** — sessions and purchase
   conversion per `utm_source`.

All six were run against this schema and verified to return valid results
(not just checked for syntax).

## Project structure

```
app/            Next.js App Router: pages (start/quiz/email/paywall/install)
                and API routes (app/api/*) — session, identify, quiz answers,
                plan selection, purchase, health check
components/     Screen-level React components (one subfolder per screen) and
                shared client-side helpers (session bootstrap, screen-view firing)
lib/            Server-side business logic: db client, visitor/session
                resolution, identity linking, attribution, quiz, paywall,
                payment state machine + fake PSP, install guard, analytics
prisma/         schema.prisma, migrations/ (including raw-SQL invariants:
                case-insensitive email uniqueness, visitor.user_id
                immutability trigger, payment state-transition trigger,
                append-only funnel_events trigger), seed.mjs (plan catalog)
tests/          Vitest suites, run against a real Postgres (see "Tests")
docs/           spec.md (source of truth for behavior), product-research.md,
                fake-psp.md, analytics-queries.sql
AGENTS.md       Instructions for any AI agent working in this repository —
                scope, invariants, and verification expectations
```

## Known limitations / out of scope

Explicitly out of scope per [docs/spec.md](docs/spec.md) §1, §19:

- **Fake payments, not a real PSP** — no real card network, no PCI/billing
  integration.
- **No real email sending** — email identification does not send any actual
  email.
- **No real app distribution** — Install links to real public ChaChat entry
  points, but nothing is installed/downloaded by this project itself.
- **No authentication/password system** — identity recognition is via a
  client-side visitor token within the funnel, not accounts/login.
- **No subscription management** — no upgrade/downgrade/cancel/refund flow,
  no promo codes, no multi-currency.
- **No automatic funnel resumption** from an arbitrary step on repeat visit,
  other than the one fixed case: redirect straight to Install if the
  identity already has a succeeded purchase. That redirect is enforced at
  every funnel entry point a repeat visitor could land on (Start, each Quiz
  screen, Email, Paywall, and Install's own guard), per spec.md §7 — but
  there is no broader "resume where you left off" behavior beyond that one
  case (e.g. an identified-but-unpurchased visitor who lands on Start is not
  auto-forwarded to Paywall; spec.md §7 explicitly leaves that unspecified).
- **Not full test coverage** — testing effort is concentrated on payment
  state machine / concurrency and identity/session logic, per spec §19; most
  UI components and simpler API routes are exercised manually/end-to-end
  rather than unit-tested.
- **No visual polish/animations/A-B testing/feature flags** — explicitly
  P2/optional in the spec, not required for completeness.

## What I would do with more time

- Broaden automated test coverage to the remaining API routes (quiz answer,
  plan selection, identify) and add component-level tests for the screens,
  beyond the current focus on payment/identity logic.
- Add a small number of DB indexes tuned to the analytics query patterns
  above (e.g. on `funnel_events (event_name, (properties->>'screen'))`) if
  event volume grew enough to matter.
- Session-inactivity expiry currently uses a fixed default (spec §20 leaves
  the exact value open); this could be made configurable if there were a
  real need to tune it per environment.

## Reviewer guide — where to look first

- [docs/spec.md](docs/spec.md) — the authoritative specification; everything
  else in this repo is expected to match it.
- [AGENTS.md](AGENTS.md) — scope, invariants, and verification rules this
  project was built against.
- [lib/payment.ts](lib/payment.ts) and [tests/payment-concurrency.test.ts](tests/payment-concurrency.test.ts) —
  the payment state machine and its concurrency/idempotency guarantees, the
  part of this assignment with the most correctness risk.
- [docs/fake-psp.md](docs/fake-psp.md) / [lib/fake-psp.ts](lib/fake-psp.ts) —
  the deterministic fake payment processor.
- [docs/analytics-queries.sql](docs/analytics-queries.sql) — example
  analytics queries, verified against the live schema.
- [tests/](tests/) — the automated test suite (`npm test`, real Postgres).
