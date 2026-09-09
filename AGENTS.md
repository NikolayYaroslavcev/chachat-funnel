# AGENTS.md — ChaChat Funnel

Instructions for any AI agent working in this repository. Read this before making changes.

---

## 1. Project overview

ChaChat Funnel is a small full-stack web funnel (test assignment) for the product ChaChat, an AI companion/roleplay chat app. The goal is not visual polish — it's correctness of the user scenario, identity handling, attribution, analytics, and payment logic, including concurrent and repeated requests.

The funnel has six screens, in this fixed order:

```
Start → Quiz → Email → Paywall → Payment → Install
```

- **Start** — value proposition, single CTA into the quiz.
- **Quiz** — a few product-related/segmentation questions, one answer saved per step.
- **Email** — identifies the visitor as a user (new or existing).
- **Paywall** — three subscription plans + custom payment form (no external redirect).
- **Payment** — not a separate route; it's the processing state of the Paywall's purchase request, handled by a fake PSP.
- **Install** — shown only after a successful purchase; links to real public ChaChat entry points.

Main system parts: Next.js app (UI + API/server logic in one), PostgreSQL (single source of truth for identity/funnel/analytics/payments), fake PSP module (backend-only, deterministic), Docker Compose (single startup path).

---

## 2. Source of truth

```
docs/spec.md
    ↓
implementation
```

`docs/spec.md` is the authority on expected behavior. `docs/product-research.md` is product context (what's a confirmed ChaChat fact vs. not). `docs/plan-testovogo-zadaniya.md` is the working plan/stage breakdown.

If code, the plan, or an assumption contradicts `docs/spec.md`: **surface the contradiction first.** Do not silently invent new behavior or silently follow the plan/code over the spec.

---

## 3. Fixed technology stack

- Next.js, **App Router**
- TypeScript (all code)
- PostgreSQL (single data store for funnel/identity/analytics/payments)
- Docker Compose (single startup path: `docker compose up` from a clean checkout, migrations applied automatically)

Do not replace Next.js with another framework. Do not add a separate backend service unless the scope explicitly changes — Next.js handles both frontend and backend/API here.

Intentionally left open (see `docs/spec.md` §20) — do not lock these in prematurely: ORM/DB client, API route organization, anonymous-identity cookie/storage mechanism, idempotency/locking mechanism, specific fake-PSP test card numbers.

---

## 4. Development principles

- Understand the relevant part of `docs/spec.md` before changing behavior it governs.
- Before touching critical business logic (identity linking, payment state machine, idempotency), check existing behavior first — don't assume.
- Don't expand scope beyond the task given.
- Prefer the simplest solution that satisfies the spec's requirements.
- Don't introduce architectural complexity without a concrete reason tied to a requirement.
- Preserve existing correctness — a change to one area must not break invariants documented elsewhere (identity, payment state, analytics).
- Verify the result after finishing a task (see §10).
- Don't dictate implementation details the spec deliberately leaves open (see §3, §20 of spec) unless the task requires deciding one.

---

## 5. Database rules

PostgreSQL is the source of truth for: users, visitors/sessions, quiz answers, funnel events, plans, payment attempts, purchases.

- Schema changes go through migrations, not manual/ad-hoc changes.
- The schema must preserve the relations needed for analytics: `visitor → session → funnel_events/quiz_answers → (email) → user → payment_attempts → purchases` must stay traceable via joins.
- Critical integrity (no duplicate users, no duplicate successful purchases, visitor→user link stability) must be enforced at the DB/backend level — never solved only in the UI.
- Payment and identity data need extra care: don't relax constraints (uniqueness of `users.email`, immutability of `visitor.user_id` once set, one `succeeded` attempt ⇒ exactly one purchase) without re-reading `docs/spec.md` §5, §9, §11, §13 first.

No ORM/DB client is chosen yet — don't assume one exists; if a task requires picking one, that's a decision to make explicitly, not incidentally.

---

## 6. Analytics rules

- Meaningful funnel actions (see `docs/spec.md` §10 for the event list) must be persisted in PostgreSQL, not just logged client-side.
- Analytics must not depend solely on client-side logging/tracking.
- Every event must retain enough context (session, visitor/user when known, related payment attempt/purchase/plan where applicable) to support the funnel SQL queries described in the spec (drop-off, conversion, revenue by plan, acquisition by UTM, full user history reconstruction).
- Don't remove or change the meaning of existing analytics events without checking whether funnel/analytics queries depend on them.

---

## 7. Identity rules

Critical invariants from `docs/spec.md` §5–§7:

- An anonymous **visitor** exists before email and is the holder of pre-email history (not the session, not the user).
- Anonymous history (quiz answers, funnel events, attribution) must never be lost or duplicated when identity changes.
- Email identifies the **user**; case-insensitive comparison is used for identity purposes.
- An existing email must never create a duplicate user.
- The existing-email flow must preserve the current visitor's history — it's a **link**, not a merge, and not a new duplicate user.
- Once `visitor.user_id` is set, it must never switch to a different user — the only allowed repeat write is to the same value (idempotent no-op).
- Repeated identification operations (same email submitted again, linking retried) must be safe/idempotent.

Don't invent a specific cookie/storage mechanism — that's chosen at implementation time (spec §20), but the persistence guarantee itself (visitor identity survives across requests before and after email) is not optional.

---

## 8. Payment rules

Critical requirements from `docs/spec.md` §9, §11–§13:

- `payment_attempt` and `purchase` are distinct entities. A `purchase` exists only when an attempt reaches `succeeded`, created atomically with that transition.
- The fake PSP must support success / decline / timeout, deterministically (based on input like a test card number), on the backend — not randomly, not only in the UI.
- Payment state must be explicit: `initiated → processing → succeeded|declined|timed_out|errored`. No transitions out of a terminal state. No skipping `processing`.
- Install is reachable only when the current identity has at least one `succeeded` purchase — checked server-side on every visit, not only right after payment.
- Decline/timeout/error must allow retry (a **new** `payment_attempt`, not a mutation of the old one).
- A payment failure must never leave the database in a partially-applied/inconsistent state.
- Repeated or concurrent purchase requests for the same user must never produce more than one succeeded purchase from one logical payment operation. The definition of "one logical operation" in the spec: **at most one non-terminal (`initiated`/`processing`) `payment_attempt` per user at a time.**

Specifically treat these as **backend/data-integrity scenarios**, not just UI concerns:

```
double-click
two tabs
refresh
repeated request
```

A disabled button or client-side debounce is not a sufficient fix for any of these — the guarantee must hold at the backend/DB level.

Don't dictate the specific idempotency/locking mechanism (DB constraint, advisory lock, serializable transaction, etc.) unless the task is exactly to choose and implement one — the spec leaves this open on purpose (§13, §20), it only fixes the required outcome.

---

## 9. Scope discipline

Do not add, on your own initiative:

- authentication / password system / account pages
- a real payment provider
- real email sending
- subscription management (upgrade/downgrade/cancel/refund)
- an admin panel
- A/B testing
- unnecessary external services
- deployment infrastructure

These are explicitly out of scope in `docs/spec.md` §1 and §19. If a task seems to need one of these, treat that as a signal to stop and confirm the need rather than implementing it.

---

## 10. Verification

After a change, check it against the relevant criteria in `docs/spec.md` §18 for the area touched.

For critical changes (identity linking, payment state machine, concurrency/idempotency, migrations), verify more thoroughly:

- typecheck
- lint
- tests, if they exist
- migrations (clean apply)
- production build
- Docker startup (`docker compose up` from a clean state)
- the relevant user scenario end-to-end

Don't run the full checklist after every trivial change — match verification depth to the size and risk of the change.

---

## 11. Task boundaries

Work within the scope of the specific task given.

- A data-model task doesn't mean reworking UI, payment flow, or analytics.
- A UI task doesn't mean touching the payment state machine or identity linking.

If you find a problem outside the current task:

- don't silently fix it
- briefly note it in your report (see §12)
- continue the current task unless the problem actually blocks it

---

## 12. Reporting

After finishing a task, report briefly:

1. What was done.
2. Which files changed.
3. Which checks were run.
4. Result of those checks.
5. Any problems/risks found.
6. What was left out of scope.

Keep it short — no report-for-report's-sake.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
