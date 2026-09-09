# Fake PSP — test cards

Source of truth for the deterministic outcomes of the fake payment
processor. Implementation: [`lib/fake-psp.ts`](../lib/fake-psp.ts).

This module is a stand-in for a real payment provider (spec.md §12): no
network call is ever made, and the outcome for a given card number is always
the same, regardless of who calls it (UI, a script, curl against the API
once the payment-flow stage wires this in) or how long it takes to call.

## Test cards

| Card number           | Outcome     | Notes                                                                 |
| ---------------------- | ----------- | ---------------------------------------------------------------------- |
| `4242 4242 4242 4242`  | Success     | Resolves immediately.                                                  |
| `4000 0000 0000 0002`  | Decline     | Resolves immediately with reason `card_declined`.                      |
| `4000 0000 0000 0044`  | Timeout     | Resolves after a bounded simulated delay (`FAKE_PSP_TIMEOUT_DELAY_MS`, 3000ms in production) with outcome `timed_out` — never hangs indefinitely. |

Expiry and CVC are accepted (to match the real form) but never affect the
outcome — only the card number matters.

Any card number that isn't one of the three above (including malformed
input) is **declined** with reason `unsupported_test_card`. An unrecognized
card can never accidentally succeed.

## Behavior guarantees

- **Deterministic**: same card number in → same outcome out, every time.
- **Backend-only**: the rule lives in `lib/fake-psp.ts`, not in the UI — a
  request that bypasses the Paywall form entirely and hits the API with the
  same test card number gets the same result.
- **Bounded timeout**: the timeout card never waits forever; it resolves to
  `timed_out` after a fixed, short delay.
- **No sensitive data retained**: the module never logs the raw card
  number, expiry, or CVC, and never returns them — only a masked card
  number (e.g. `•••• 4242`) comes back in the result.

## Scope note

This module only answers "what would the PSP say" for one attempt — it does
not create `payment_attempt`/`purchase` rows and does not fire analytics
events itself. That integration (idempotency/concurrency handling included)
lives in `lib/payment.ts`, which calls this module from `POST /api/purchase`.
