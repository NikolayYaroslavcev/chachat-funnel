import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { findActiveSession } from "@/lib/visitor-session";
import { TOTAL_QUIZ_STEPS } from "@/lib/quiz";
import styles from "@/components/quiz/quiz.module.css";

// Quiz completion holding screen (spec.md: "finish the Quiz ready for the
// Email stage"). Not one of the 6 canonical funnel screens, so it
// deliberately fires no screen_view (spec.md 10 only defines that event for
// start/quiz/email/paywall/payment/install). Guards against being reached
// before every question is answered — redirects back into the quiz instead
// of showing a confusing empty completion state.
export default async function QuizCompletePage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

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
          ✅
        </div>
        <h1 className={styles.completeHeadline}>That&apos;s everything — thanks!</h1>
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
