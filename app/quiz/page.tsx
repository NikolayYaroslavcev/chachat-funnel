import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { findActiveSession } from "@/lib/visitor-session";
import { QUIZ_QUESTIONS } from "@/lib/quiz";
import { hasSucceededPurchaseForVisitor } from "@/lib/install";

export default async function QuizIndexPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  if (await hasSucceededPurchaseForVisitor(visitorId)) {
    redirect("/install");
  }

  if (visitorId) {
    const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
    if (visitor) {
      const session = await findActiveSession(visitor.id);
      if (session) {
        const answers = await prisma.quizAnswer.findMany({
          where: { sessionId: session.id },
          select: { questionKey: true },
        });
        const answeredKeys = new Set(answers.map((a) => a.questionKey));
        const firstUnanswered = QUIZ_QUESTIONS.find((q) => !answeredKeys.has(q.key));
        redirect(firstUnanswered ? `/quiz/${firstUnanswered.step}` : "/quiz/complete");
      }
    }
  }

  redirect("/quiz/1");
}
