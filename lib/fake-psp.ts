// Fake Payment Service Provider (spec.md 12; docs/plan-testovogo-zadaniya.md
// Stage 10). A deterministic, application-local stand-in for a real payment
// processor: given card input, it returns one of three outcomes — success,
// decline, or timeout — chosen solely by which documented test card number
// was used, never by timing or randomness. No network call is made.
//
// This module answers only "what would the PSP say" for one attempt. It is
// deliberately not coupled to Prisma or the payment_attempt/purchase
// lifecycle — creating those records, wiring purchase_attempted/succeeded/
// failed events, and enforcing idempotency belong to the payment-flow stage
// that calls this module.
//
// Test cards are documented for developers in docs/fake-psp.md.
export const FAKE_PSP_TEST_CARDS = {
  success: "4242424242424242",
  decline: "4000000000000002",
  timeout: "4000000000000044",
} as const;

export type FakePspInput = {
  cardNumber: string;
  // Accepted to match the real form/request shape so this module's
  // signature never has to change when a later stage wires it up, but
  // neither field ever affects the outcome, is returned, or is logged.
  expiry: string;
  cvc: string;
};

export type FakePspResult =
  | { outcome: "succeeded"; maskedCardNumber: string }
  | { outcome: "declined"; maskedCardNumber: string; reason: "card_declined" | "unsupported_test_card" }
  | { outcome: "timed_out"; maskedCardNumber: string };

// Bounded wait simulated for the timeout test card (spec.md 12: a real,
// limited delay after which the fake PSP explicitly resolves to timeout —
// never an unbounded wait). Deliberately short: it stands in for "PSP took
// too long", not a realistic network round-trip, so nothing calling this
// function needs to block for production-length seconds. Tests may pass a
// smaller `timeoutDelayMs` override to stay fast without changing behavior.
export const FAKE_PSP_TIMEOUT_DELAY_MS = 3000;

function normalizeCardNumber(raw: string): string {
  return raw.replace(/\D/g, "");
}

function maskCardNumber(normalizedDigits: string): string {
  const last4 = normalizedDigits.slice(-4).padStart(4, "•");
  return `•••• ${last4}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Processes one payment attempt through the fake PSP. Result depends only on
// `input.cardNumber` matching a documented test card — the same card always
// produces the same outcome, including when this function is called
// directly (bypassing the UI). Any card number that isn't one of the three
// documented test cards is treated as declined, so an unrecognized/invalid
// card can never accidentally succeed.
export async function processFakePayment(
  input: FakePspInput,
  options: { timeoutDelayMs?: number } = {},
): Promise<FakePspResult> {
  const digits = normalizeCardNumber(input.cardNumber);
  const maskedCardNumber = maskCardNumber(digits);

  if (digits === FAKE_PSP_TEST_CARDS.success) {
    return { outcome: "succeeded", maskedCardNumber };
  }

  if (digits === FAKE_PSP_TEST_CARDS.timeout) {
    await delay(options.timeoutDelayMs ?? FAKE_PSP_TIMEOUT_DELAY_MS);
    return { outcome: "timed_out", maskedCardNumber };
  }

  return {
    outcome: "declined",
    maskedCardNumber,
    reason: digits === FAKE_PSP_TEST_CARDS.decline ? "card_declined" : "unsupported_test_card",
  };
}
