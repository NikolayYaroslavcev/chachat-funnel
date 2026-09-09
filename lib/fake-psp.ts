export const FAKE_PSP_TEST_CARDS = {
  success: "4242424242424242",
  decline: "4000000000000002",
  timeout: "4000000000000044",
} as const;

export type FakePspInput = {
  cardNumber: string;
  expiry: string;
  cvc: string;
};

export type FakePspResult =
  | { outcome: "succeeded"; maskedCardNumber: string }
  | { outcome: "declined"; maskedCardNumber: string; reason: "card_declined" | "unsupported_test_card" }
  | { outcome: "timed_out"; maskedCardNumber: string };

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
