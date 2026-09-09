import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_PSP_TEST_CARDS, FAKE_PSP_TIMEOUT_DELAY_MS, processFakePayment } from "@/lib/fake-psp";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processFakePayment", () => {
  it("returns succeeded for the documented success test card", async () => {
    const result = await processFakePayment({ cardNumber: FAKE_PSP_TEST_CARDS.success, expiry: "12/30", cvc: "123" });
    expect(result.outcome).toBe("succeeded");
  });

  it("returns declined for the documented decline test card", async () => {
    const result = await processFakePayment({ cardNumber: FAKE_PSP_TEST_CARDS.decline, expiry: "12/30", cvc: "123" });
    expect(result.outcome).toBe("declined");
  });

  it("returns timed_out for the documented timeout test card", async () => {
    const result = await processFakePayment(
      { cardNumber: FAKE_PSP_TEST_CARDS.timeout, expiry: "12/30", cvc: "123" },
      { timeoutDelayMs: 10 },
    );
    expect(result.outcome).toBe("timed_out");
  });

  it("normalizes a formatted (spaced) card number before matching", async () => {
    const spaced = FAKE_PSP_TEST_CARDS.success.match(/.{1,4}/g)!.join(" ");
    const result = await processFakePayment({ cardNumber: spaced, expiry: "12/30", cvc: "123" });
    expect(result.outcome).toBe("succeeded");
  });

  it("is deterministic — repeated calls with the same card give the same outcome", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        processFakePayment({ cardNumber: FAKE_PSP_TEST_CARDS.decline, expiry: "12/30", cvc: "123" }),
      ),
    );
    expect(results.every((r) => r.outcome === "declined")).toBe(true);
  });

  it("declines an unrecognized card number rather than accidentally succeeding", async () => {
    const result = await processFakePayment({ cardNumber: "5555555555554444", expiry: "12/30", cvc: "123" });
    expect(result.outcome).toBe("declined");
  });

  it("declines malformed input (non-digit, empty) rather than accidentally succeeding", async () => {
    const empty = await processFakePayment({ cardNumber: "", expiry: "12/30", cvc: "123" });
    const junk = await processFakePayment({ cardNumber: "not-a-card", expiry: "12/30", cvc: "123" });
    expect(empty.outcome).toBe("declined");
    expect(junk.outcome).toBe("declined");
  });

  it("bounds the timeout delay to the requested override rather than waiting indefinitely", async () => {
    const start = Date.now();
    await processFakePayment(
      { cardNumber: FAKE_PSP_TEST_CARDS.timeout, expiry: "12/30", cvc: "123" },
      { timeoutDelayMs: 15 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("exposes a finite, bounded default timeout delay", () => {
    expect(FAKE_PSP_TIMEOUT_DELAY_MS).toBeGreaterThan(0);
    expect(FAKE_PSP_TIMEOUT_DELAY_MS).toBeLessThan(60_000);
  });

  it("never logs the raw card number or CVC", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await processFakePayment({ cardNumber: FAKE_PSP_TEST_CARDS.decline, expiry: "12/30", cvc: "999" });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("returns a masked card number, never the raw number, expiry, or CVC", async () => {
    const input = { cardNumber: FAKE_PSP_TEST_CARDS.decline, expiry: "11/29", cvc: "999" };
    const result = await processFakePayment(input);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(input.cardNumber);
    expect(serialized).not.toContain(input.cvc);
    expect(serialized).not.toContain(input.expiry);
    if ("maskedCardNumber" in result) {
      expect(result.maskedCardNumber.endsWith(FAKE_PSP_TEST_CARDS.decline.slice(-4))).toBe(true);
    }
  });
});
