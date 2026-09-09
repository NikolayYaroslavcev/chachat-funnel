import { describe, expect, it } from "vitest";
import { formatCardNumber, formatExpiry, isValidCardNumber, isValidCvc, isValidExpiry } from "@/lib/card";

describe("isValidCardNumber", () => {
  it("accepts a well-known Luhn-valid test number", () => {
    expect(isValidCardNumber("4242424242424242")).toBe(true);
  });

  it("accepts a formatted (spaced) card number", () => {
    expect(isValidCardNumber("4242 4242 4242 4242")).toBe(true);
  });

  it("rejects a number that fails the Luhn checksum", () => {
    expect(isValidCardNumber("4242424242424241")).toBe(false);
  });

  it("rejects a too-short number", () => {
    expect(isValidCardNumber("42424242")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isValidCardNumber("")).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(isValidCardNumber("not-a-card")).toBe(false);
  });
});

describe("formatCardNumber", () => {
  it("groups digits in fours and strips non-digits", () => {
    expect(formatCardNumber("4242-4242-4242-4242")).toBe("4242 4242 4242 4242");
  });

  it("truncates beyond the max card length", () => {
    expect(formatCardNumber("1".repeat(30)).replace(/\s/g, "")).toHaveLength(19);
  });
});

describe("isValidExpiry", () => {
  const now = new Date("2026-06-15T00:00:00Z");

  it("accepts a future MM/YY", () => {
    expect(isValidExpiry("12/26", now)).toBe(true);
  });

  it("accepts the current month", () => {
    expect(isValidExpiry("06/26", now)).toBe(true);
  });

  it("rejects a past month in the current year", () => {
    expect(isValidExpiry("01/26", now)).toBe(false);
  });

  it("rejects a past year", () => {
    expect(isValidExpiry("12/25", now)).toBe(false);
  });

  it("rejects an invalid month", () => {
    expect(isValidExpiry("13/26", now)).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(isValidExpiry("2026-12", now)).toBe(false);
  });
});

describe("formatExpiry", () => {
  it("inserts a slash after two digits", () => {
    expect(formatExpiry("1226")).toBe("12/26");
  });

  it("leaves fewer than two digits unslashed", () => {
    expect(formatExpiry("1")).toBe("1");
  });
});

describe("isValidCvc", () => {
  it("accepts 3 digits", () => {
    expect(isValidCvc("123")).toBe(true);
  });

  it("accepts 4 digits", () => {
    expect(isValidCvc("1234")).toBe(true);
  });

  it("rejects 2 digits", () => {
    expect(isValidCvc("12")).toBe(false);
  });

  it("rejects non-digits", () => {
    expect(isValidCvc("12a")).toBe(false);
  });
});
