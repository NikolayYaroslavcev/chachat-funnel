import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { findActiveSession } from "@/lib/visitor-session";
import { TOTAL_QUIZ_STEPS } from "@/lib/quiz";
import { getSucceededPurchase } from "@/lib/install";
import { ScreenView } from "@/components/ScreenView";
import { EmailScreen } from "@/components/email/EmailScreen";

export default async function EmailPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  let allAnswered = false;
  if (visitorId) {
    const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
    if (visitor) {
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
