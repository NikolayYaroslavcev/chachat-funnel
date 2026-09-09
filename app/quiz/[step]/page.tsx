import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { findActiveSession } from "@/lib/visitor-session";
import { getQuestionByStep, TOTAL_QUIZ_STEPS } from "@/lib/quiz";
import { QuizStepScreen } from "@/components/quiz/QuizStepScreen";

// Server Component: validates the step, and — read-only, no session/visitor
// is created or touched here (a GET render must stay side-effect-free) —
// looks up any existing answer for this session/question so refresh/back
// shows the prior choice (spec.md 4.2). A stale (expired) session is treated
// as having no answers, per findActiveSession's comment.
export default async function QuizStepPage({ params }: { params: Promise<{ step: string }> }) {
  const { step: stepParam } = await params;
  const step = Number(stepParam);
  if (!Number.isInteger(step) || step < 1 || step > TOTAL_QUIZ_STEPS) {
    notFound();
  }
  const question = getQuestionByStep(step);
  if (!question) notFound();

  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  let selectedValue: string | null = null;
  if (visitorId) {
    const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
    if (visitor) {
      const session = await findActiveSession(visitor.id);
      if (session) {
        const answer = await prisma.quizAnswer.findUnique({
          where: { sessionId_questionKey: { sessionId: session.id, questionKey: question.key } },
        });
        selectedValue = answer?.answerValue ?? null;
      }
    }
  }

  return (
    <QuizStepScreen
      step={step}
      totalSteps={TOTAL_QUIZ_STEPS}
      question={question}
      initialSelectedValue={selectedValue}
    />
  );
}
