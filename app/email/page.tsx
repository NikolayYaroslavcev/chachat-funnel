import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { findActiveSession } from "@/lib/visitor-session";
import { TOTAL_QUIZ_STEPS } from "@/lib/quiz";
import { getSucceededPurchase } from "@/lib/install";
import { ScreenView } from "@/components/ScreenView";
import { EmailScreen } from "@/components/email/EmailScreen";

// Email screen (spec.md 4.3): only reachable once the Quiz is actually
// complete for the current visitor/session — same guard as
// /quiz/complete, since Email is that screen's forward destination and
// spec.md 4 forbids reaching a mid-funnel screen without its
// prerequisite (a fresh identity can't skip straight to Email).
export default async function EmailPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  let allAnswered = false;
  if (visitorId) {
    const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
    if (visitor) {
      // Repeat visit (spec.md 7): an already-identified visitor who already
      // has a succeeded purchase skips straight to Install, regardless of
      // which funnel screen the repeat visit lands on.
      if (visitor.userId && (await getSucceededPurchase(visitor.userId))) {
        redirect("/install");
      }

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
    <>
      <ScreenView screen="email" />
      <EmailScreen />
    </>
  );
}
