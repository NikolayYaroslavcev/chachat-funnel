"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { isValidEmail } from "@/lib/email";
import styles from "./email.module.css";

// Email screen (spec.md 4.3): the one form standing between Quiz and
// Paywall. Submits to the existing /api/identify endpoint, which owns all
// identity logic (new vs. existing user, visitor linking, email
// normalization, concurrency, and recording `email_submitted` — see
// lib/identify.ts) — this component only renders the form and reacts to
// the endpoint's result. It fires no analytics itself beyond the
// screen_view already recorded by the parent page's <ScreenView>.
export function EmailScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const trimmed = email.trim();
    if (!trimmed) {
      setError("Enter your email to continue.");
      return;
    }
    if (!isValidEmail(trimmed)) {
      setError("That doesn't look like a valid email address.");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(
          data?.message === "invalid email"
            ? "That doesn't look like a valid email address."
            : "Something went wrong — please try again.",
        );
        setSubmitting(false);
        return;
      }

      // Navigate on success; leave `submitting` true so the form stays
      // disabled during the transition instead of briefly re-enabling.
      router.push("/paywall");
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
      setSubmitting(false);
    }
  }

  return (
    <main className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.hero}>
          <h1 className={styles.headline}>What&apos;s your email?</h1>
          <p className={styles.subhead}>
            We use this to save your quiz answers and set up your ChaChat account — no spam, and this assignment
            doesn&apos;t send real emails.
          </p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <label className={styles.label} htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            className={styles.input}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            disabled={submitting}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "email-error" : undefined}
          />
          {error && (
            <p id="email-error" className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className={styles.cta} disabled={submitting}>
            {submitting ? "Continuing…" : "Continue"}
          </button>
        </form>
      </div>
    </main>
  );
}
