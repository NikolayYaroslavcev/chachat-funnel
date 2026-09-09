const CARD_NUMBER_MIN_DIGITS = 13;
const CARD_NUMBER_MAX_DIGITS = 19;

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, CARD_NUMBER_MAX_DIGITS);
  return (digits.match(/.{1,4}/g) ?? []).join(" ");
}

export function isValidCardNumber(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= CARD_NUMBER_MIN_DIGITS && digits.length <= CARD_NUMBER_MAX_DIGITS && luhnCheck(digits);
}

export function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

const EXPIRY_RE = /^(\d{2})\/(\d{2})$/;

export function isValidExpiry(raw: string, now: Date = new Date()): boolean {
  const match = EXPIRY_RE.exec(raw.trim());
  if (!match) return false;

  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;

  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (year < currentYear) return false;
  if (year === currentYear && month < currentMonth) return false;
  return true;
}

export function isValidCvc(raw: string): boolean {
  return /^\d{3,4}$/.test(raw.trim());
}
