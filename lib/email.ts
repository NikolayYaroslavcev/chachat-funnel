// Deliberately not RFC 5322-exact — this assignment's focus is identity
// linking, not perfect email grammar (spec.md 20 leaves the exact
// validation approach open). Good enough to reject obviously malformed
// input while accepting real addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
}
