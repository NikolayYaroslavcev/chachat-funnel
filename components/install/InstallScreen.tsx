import { Check, ArrowUpRight } from "lucide-react";
import type { PurchaseSummary } from "@/lib/install";
import styles from "./install.module.css";

const WEB_APP_URL = "https://app.chachat.app/en";
const APP_STORE_URL = "https://apps.apple.com/us/app/chachat-ai-roleplay-companion/id6444773124";

type Props = { purchase: PurchaseSummary };

function formatPrice(purchase: PurchaseSummary): string {
  return `$${Number(purchase.amount).toFixed(2)}`;
}

export function InstallScreen({ purchase }: Props) {
  return (
    <main className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.badge} aria-hidden="true">
          <Check size={22} strokeWidth={2.5} />
        </div>

        <h1 className={styles.headline}>You&apos;re in, payment confirmed</h1>
        <p className={styles.subhead}>
          Your {purchase.planName} subscription ({formatPrice(purchase)}) is active. Your ChaChat companion is ready
          whenever you are.
        </p>

        <div className={styles.actions}>
          <a className={styles.cta} href={WEB_APP_URL} target="_blank" rel="noopener noreferrer">
            Open ChaChat in your browser
            <ArrowUpRight size={18} strokeWidth={2.5} aria-hidden="true" />
          </a>
          <a className={styles.ctaSecondary} href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">
            Get the iOS app
            <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
          </a>
        </div>

        <div className={styles.emailNote}>
          <p className={styles.emailNoteTitle}>Linked to {purchase.userEmail}</p>
          <p className={styles.emailNoteBody}>
            Your subscription and access are tied to this email. This is a test environment, so we haven&apos;t sent
            a real confirmation email, but your account is ready to use right now with the links above.
          </p>
        </div>
      </div>
    </main>
  );
}
