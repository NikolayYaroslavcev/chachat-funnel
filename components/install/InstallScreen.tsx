import type { PurchaseSummary } from "@/lib/install";
import styles from "./install.module.css";

// Real, existing public ChaChat entry points (docs/product-research.md 1) —
// spec.md 16/19 requires Install to link to these, not a fabricated app
// build or download URL of our own.
const WEB_APP_URL = "https://app.chachat.app/en";
const APP_STORE_URL = "https://apps.apple.com/us/app/chachat-ai-roleplay-companion/id6444773124";

type Props = { purchase: PurchaseSummary };

function formatPrice(purchase: PurchaseSummary): string {
  return `$${Number(purchase.amount).toFixed(2)}`;
}

// Final funnel screen (spec.md 4.6, 16): confirms the purchase that's
// already been verified server-side by the page's resolveInstallAccess
// guard, and hands the user off to the real product — no real app build or
// email is created here, only a link out and a note about what happens next.
export function InstallScreen({ purchase }: Props) {
  return (
    <main className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.badge} aria-hidden="true">
          ✓
        </div>

        <h1 className={styles.headline}>You&apos;re in — payment confirmed</h1>
        <p className={styles.subhead}>
          Your {purchase.planName} subscription ({formatPrice(purchase)}) is active. Your ChaChat companion is ready
          whenever you are.
        </p>

        <div className={styles.actions}>
          <a className={styles.cta} href={WEB_APP_URL} target="_blank" rel="noopener noreferrer">
            Open ChaChat in your browser
          </a>
          <a className={styles.ctaSecondary} href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">
            Get the iOS app
          </a>
        </div>

        <div className={styles.emailNote}>
          <p className={styles.emailNoteTitle}>Linked to {purchase.userEmail}</p>
          <p className={styles.emailNoteBody}>
            Your subscription and access are tied to this email. This is a test environment, so we haven&apos;t sent
            a real confirmation email — but your account is ready to use right now with the links above.
          </p>
        </div>
      </div>
    </main>
  );
}
