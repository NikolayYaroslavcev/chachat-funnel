"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatCardNumber, formatExpiry, isValidCardNumber, isValidCvc, isValidExpiry } from "@/lib/card";
import type { PlanSummary } from "@/lib/paywall";
import styles from "./paywall.module.css";

const IDEMPOTENCY_KEY_STORAGE_KEY = "chachat:purchase-idempotency-key";

function getOrCreateIdempotencyKey(): string {
  try {
    const existing = sessionStorage.getItem(IDEMPOTENCY_KEY_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(IDEMPOTENCY_KEY_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function clearIdempotencyKey() {
  try {
    sessionStorage.removeItem(IDEMPOTENCY_KEY_STORAGE_KEY);
  } catch {
  }
}

type Props = { plans: PlanSummary[] };

const PLAN_POSITIONING: Record<string, { badge?: string; tagline: string }> = {
  weekly: { tagline: "Try it out, no long-term commitment." },
  monthly: { badge: "Most popular", tagline: "The regular way most people stay connected with their companion." },
  "3-months": { badge: "Best value", tagline: "Lowest price per week, for the long run." },
};

type FieldErrors = { cardNumber?: string; expiry?: string; cvc?: string };
type Status = "idle" | "submitting" | "error" | "success";

function formatPrice(plan: PlanSummary): string {
  return `$${Number(plan.priceAmount).toFixed(2)}`;
}

function periodLabel(days: number): string {
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return `${Math.round(days / 30)} months`;
}

export function PaywallScreen({ plans }: Props) {
  const router = useRouter();
  const defaultPlan = plans.find((p) => p.slug === "monthly") ?? plans[0];
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(defaultPlan?.id ?? null);
  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;

  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const submitting = status === "submitting";
  const succeeded = status === "success";

  async function handleSelectPlan(planId: string) {
    if (submitting || planId === selectedPlanId) return;
    setSelectedPlanId(planId);

    try {
      await fetch("/api/plan-selected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
        keepalive: true,
      });
    } catch {
    }
  }

  function validateForm(): boolean {
    const errors: FieldErrors = {};
    if (!isValidCardNumber(cardNumber)) errors.cardNumber = "Enter a valid card number.";
    if (!isValidExpiry(expiry)) errors.expiry = "Enter a valid expiry date (MM/YY).";
    if (!isValidCvc(cvc)) errors.cvc = "Enter a valid CVC.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (!selectedPlanId) {
      setFormError("Select a plan to continue.");
      return;
    }
    if (!validateForm()) return;

    setFormError(null);
    setStatus("submitting");

    const idempotencyKey = getOrCreateIdempotencyKey();

    try {
      const res = await fetch("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: selectedPlanId,
          card: { number: cardNumber.replace(/\s+/g, ""), expiry, cvc },
          idempotencyKey,
        }),
      });

      const data = await res.json().catch(() => null);

      if (res.ok && data?.status === "succeeded") {
        clearIdempotencyKey();
        setStatus("success");
        router.push("/install");
        return;
      }

      if (data?.status === "duplicate") {
        setFormError("Your payment is already being processed. Please wait a moment and try again.");
        setStatus("error");
        return;
      }

      if (data?.status === "declined") {
        setFormError("Your card was declined. Please check your details or try a different card.");
      } else if (data?.status === "timed_out") {
        setFormError("The payment timed out. Please try again.");
      } else {
        setFormError("Something went wrong, please try again.");
      }
      clearIdempotencyKey();
      setStatus("error");
    } catch {
      setFormError("Couldn't reach the server, check your connection and try again.");
      setStatus("error");
    }
  }

  if (succeeded) {
    return (
      <main className={styles.screen}>
        <div className={styles.inner}>
          <div className={styles.hero}>
            <h1 className={styles.headline}>You&apos;re in</h1>
            <p className={styles.subhead}>
              Your payment went through{selectedPlan ? ` for the ${selectedPlan.name} plan` : ""}. Taking you to the
              next step…
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.hero}>
          <h1 className={styles.headline}>Keep the conversation going</h1>
          <p className={styles.subhead}>
            Your ChaChat companion remembers what you&apos;ve told them, talks back by voice, and brings your
            stories to life with images. Subscribe to keep it all going.
          </p>
        </div>

        <div className={styles.plans} role="radiogroup" aria-label="Choose a plan">
          {plans.map((plan) => {
            const positioning = PLAN_POSITIONING[plan.slug];
            const selected = plan.id === selectedPlanId;
            return (
              <button
                key={plan.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`${styles.plan} ${selected ? styles.planSelected : ""}`}
                onClick={() => handleSelectPlan(plan.id)}
                disabled={submitting}
              >
                {positioning?.badge && <span className={styles.badge}>{positioning.badge}</span>}
                <span className={styles.planTop}>
                  <span className={styles.planName}>{plan.name}</span>
                  <span className={styles.planPrice}>
                    {formatPrice(plan)}
                    <span className={styles.planPeriod}>/{periodLabel(plan.billingPeriodDays)}</span>
                  </span>
                </span>
                {positioning?.tagline && <span className={styles.planTagline}>{positioning.tagline}</span>}
              </button>
            );
          })}
        </div>

        <p className={styles.autoRenewNote}>
          Plans renew automatically at the price shown until you cancel. This is a subscription, not a one-time
          payment.
        </p>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cardNumber">
              Card number
            </label>
            <input
              id="cardNumber"
              name="cardNumber"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="4242 4242 4242 4242"
              className={styles.input}
              value={cardNumber}
              onChange={(e) => {
                setCardNumber(formatCardNumber(e.target.value));
                if (fieldErrors.cardNumber) setFieldErrors((f) => ({ ...f, cardNumber: undefined }));
              }}
              disabled={submitting}
              aria-invalid={fieldErrors.cardNumber ? true : undefined}
              aria-describedby={fieldErrors.cardNumber ? "cardNumber-error" : undefined}
            />
            {fieldErrors.cardNumber && (
              <p id="cardNumber-error" className={styles.error}>
                {fieldErrors.cardNumber}
              </p>
            )}
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="expiry">
                Expiry
              </label>
              <input
                id="expiry"
                name="expiry"
                inputMode="numeric"
                autoComplete="cc-exp"
                placeholder="MM/YY"
                className={styles.input}
                value={expiry}
                onChange={(e) => {
                  setExpiry(formatExpiry(e.target.value));
                  if (fieldErrors.expiry) setFieldErrors((f) => ({ ...f, expiry: undefined }));
                }}
                disabled={submitting}
                aria-invalid={fieldErrors.expiry ? true : undefined}
                aria-describedby={fieldErrors.expiry ? "expiry-error" : undefined}
              />
              {fieldErrors.expiry && (
                <p id="expiry-error" className={styles.error}>
                  {fieldErrors.expiry}
                </p>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="cvc">
                CVC
              </label>
              <input
                id="cvc"
                name="cvc"
                inputMode="numeric"
                autoComplete="cc-csc"
                placeholder="123"
                className={styles.input}
                value={cvc}
                onChange={(e) => {
                  setCvc(e.target.value.replace(/\D/g, "").slice(0, 4));
                  if (fieldErrors.cvc) setFieldErrors((f) => ({ ...f, cvc: undefined }));
                }}
                disabled={submitting}
                aria-invalid={fieldErrors.cvc ? true : undefined}
                aria-describedby={fieldErrors.cvc ? "cvc-error" : undefined}
              />
              {fieldErrors.cvc && (
                <p id="cvc-error" className={styles.error}>
                  {fieldErrors.cvc}
                </p>
              )}
            </div>
          </div>

          {formError && (
            <p className={styles.formError} role="alert">
              {formError}
            </p>
          )}

          <button type="submit" className={styles.cta} disabled={submitting || !selectedPlanId}>
            {submitting ? "Processing…" : `Purchase${selectedPlan ? ` for ${formatPrice(selectedPlan)}` : ""}`}
          </button>

          <p className={styles.trustNote}>
            This is a test environment, no real charge will occur. It&apos;s safe to click Purchase once and wait;
            we&apos;ll never charge you twice for the same request.
          </p>
        </form>
      </div>
    </main>
  );
}
