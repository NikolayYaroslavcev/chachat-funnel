import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { Check } from "lucide-react";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { findActiveSession } from "@/lib/visitor-session";
import { TOTAL_QUIZ_STEPS } from "@/lib/quiz";
import { hasSucceededPurchaseForVisitor } from "@/lib/install";
import styles from "@/components/quiz/quiz.module.css";

export default async function QuizCompletePage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  if (await hasSucceededPurchaseForVisitor(visitorId)) {
    redirect("/install");
  }

  let allAnswered = false;
  if (visitorId) {
    const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
    if (visitor) {
      const session = await findActiveSession(visitor.id);
      if (session) {
        const count = await prisma.quizAnswer.count({ where: { sessionId: session.id } });
        allAnswered = count >= TOTAL_QUIZ_STEPS;
      }
    }
  }

  if (!allAnswered) {
    redirect("/quiz/1");
  }

  return (
    <main className={styles.completeScreen}>
      <div className={styles.completeInner}>
        <div className={styles.completeIcon} aria-hidden="true">
          <Check size={22} strokeWidth={2.5} />
        </div>
        <h1 className={styles.completeHeadline}>That&apos;s everything, thanks!</h1>
        <p className={styles.completeBody}>
          We&apos;ve got a good sense of what you&apos;re looking for. Next up: verifying your email to get you set
          up with ChaChat.
        </p>
        <Link href="/email" className={styles.completeCta}>
          Continue
        </Link>
      </div>
    </main>
  );
}
