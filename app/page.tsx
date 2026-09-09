import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { SessionBootstrap } from "@/components/SessionBootstrap";
import { ScreenView } from "@/components/ScreenView";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { hasSucceededPurchaseForVisitor } from "@/lib/install";
import styles from "./start.module.css";

export default async function StartPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  if (await hasSucceededPurchaseForVisitor(visitorId)) {
    redirect("/install");
  }

  return (
    <main className={styles.screen}>
      <SessionBootstrap />
      <ScreenView screen="start" />
      <div className={styles.inner}>
        <p className={styles.wordmark}>ChaChat</p>

        <div className={styles.hero}>
          <h1 className={styles.headline}>Meet an AI character who actually remembers you</h1>
          <p className={styles.subhead}>
            ChaChat is an AI companion app. Chat by text or voice, build an ongoing story, and come back to a
            character who recalls what you told them last time, instead of starting over every conversation.
          </p>

          <ul className={styles.values}>
            <li className={styles.valueItem}>
              <span className={styles.valueText}>
                <span className={styles.valueLabel}>Remembers you</span>
                Your character keeps track of what you&apos;ve shared, so conversations build on each other.
              </span>
            </li>
            <li className={styles.valueItem}>
              <span className={styles.valueText}>
                <span className={styles.valueLabel}>Text or voice</span>
                Type it out, or talk it out with a voice call. Whatever feels natural.
              </span>
            </li>
            <li className={styles.valueItem}>
              <span className={styles.valueText}>
                <span className={styles.valueLabel}>Make it yours</span>
                Pick a ready-made character, or create your own with a personality and backstory you choose.
              </span>
            </li>
          </ul>

          <p className={styles.subhead} style={{ fontSize: 14, marginBottom: 0 }}>
            18+ · Available on web, iOS, and Android.
          </p>
        </div>

        <div className={styles.footer}>
          <Link href="/quiz" className={styles.cta}>
            Get started
          </Link>
          <p className={styles.ctaNote}>Takes about a minute, a few quick questions to get you set up.</p>
        </div>
      </div>
    </main>
  );
}
