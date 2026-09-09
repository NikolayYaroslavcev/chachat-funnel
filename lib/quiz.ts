import type { QuizAnswer, Session, Visitor } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordFunnelEvent } from "@/lib/analytics";

// The funnel's 5 quiz questions, fixed by spec.md 15 (count, order, prompts
// and options are specified there verbatim — not a product decision left to
// implementation). `key` is question_key (spec.md 9, 10); option `value` is
// answer_value. Questions 2 and 4 are the "product-aware" pair spec.md 15
// requires (memory, voice) — both confirmed ChaChat features per
// product-research.md 1. Everything else is segmentation, not invented
// product functionality.
export type QuizQuestion = {
  step: number;
  key: string;
  prompt: string;
  options: { value: string; label: string }[];
};

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    step: 1,
    key: "looking_for",
    prompt: "What are you hoping to find in an AI companion?",
    options: [
      { value: "someone_to_talk_to", label: "Someone to talk to" },
      { value: "creative_cowriter", label: "A creative co-writer for stories" },
      { value: "romantic_companion", label: "A companion who feels romantic" },
      { value: "just_curious", label: "Just curious, exploring" },
    ],
  },
  {
    step: 2,
    key: "memory_importance",
    prompt:
      "ChaChat's AI characters remember details from your past conversations. How important is it to you that a companion remembers what you've told them before?",
    options: [
      { value: "very_important", label: "Very important" },
      { value: "somewhat_important", label: "Somewhat important" },
      { value: "not_important", label: "Not important" },
    ],
  },
  {
    step: 3,
    key: "story_genre",
    prompt: "What kind of characters or stories interest you most?",
    options: [
      { value: "fantasy_adventure", label: "Fantasy & adventure" },
      { value: "romance", label: "Romance" },
      { value: "everyday_conversation", label: "Everyday conversation" },
      { value: "something_else", label: "Something else" },
    ],
  },
  {
    step: 4,
    key: "voice_interest",
    prompt: "ChaChat also supports voice conversations, not just text. Would you like to talk with your AI character by voice?",
    options: [
      { value: "yes_love_that", label: "Yes, I'd love that" },
      { value: "maybe_try_it", label: "Maybe, I'll try it" },
      { value: "text_only", label: "I prefer text only" },
    ],
  },
  {
    step: 5,
    key: "chat_frequency",
    prompt: "How often do you imagine chatting with your AI companion?",
    options: [
      { value: "multiple_times_day", label: "Multiple times a day" },
      { value: "once_a_day", label: "Once a day" },
      { value: "few_times_week", label: "A few times a week" },
      { value: "just_occasionally", label: "Just occasionally" },
    ],
  },
];

export const TOTAL_QUIZ_STEPS = QUIZ_QUESTIONS.length;

export function getQuestionByStep(step: number): QuizQuestion | undefined {
  return QUIZ_QUESTIONS.find((q) => q.step === step);
}

function getQuestionByKey(key: string): QuizQuestion | undefined {
  return QUIZ_QUESTIONS.find((q) => q.key === key);
}

export class InvalidQuizAnswerError extends Error {}

export type SubmitQuizAnswerResult = {
  answer: QuizAnswer;
  completed: boolean;
};

// Persists one quiz answer (spec.md 4.2, 9): upserts on the (session,
// question) unique constraint so re-answering (back/refresh, changing a
// choice) updates the existing row instead of duplicating it, records
// quiz_answer_submitted (spec.md 10), and — once every question in the
// session has an answer — records quiz_completed exactly once. Wrapped in a
// single transaction so the answer, its event, and (when applicable) the
// completion event are committed atomically.
export async function submitQuizAnswer(
  session: Session,
  visitor: Visitor,
  questionKey: string,
  answerValue: string,
): Promise<SubmitQuizAnswerResult> {
  const question = getQuestionByKey(questionKey);
  if (!question || !question.options.some((o) => o.value === answerValue)) {
    throw new InvalidQuizAnswerError(`unknown question/answer: ${questionKey}/${answerValue}`);
  }

  return prisma.$transaction(async (tx) => {
    const answer = await tx.quizAnswer.upsert({
      where: { sessionId_questionKey: { sessionId: session.id, questionKey } },
      create: { sessionId: session.id, questionKey, answerValue },
      update: { answerValue },
    });

    await recordFunnelEvent(
      tx,
      { sessionId: session.id, userId: visitor.userId },
      { eventName: "quiz_answer_submitted", questionKey, answerValue },
    );

    const answeredCount = await tx.quizAnswer.count({ where: { sessionId: session.id } });
    const completed = answeredCount >= TOTAL_QUIZ_STEPS;

    if (completed) {
      const alreadyCompleted = await tx.funnelEvent.findFirst({
        where: { sessionId: session.id, eventName: "quiz_completed" },
      });
      if (!alreadyCompleted) {
        await recordFunnelEvent(
          tx,
          { sessionId: session.id, userId: visitor.userId },
          { eventName: "quiz_completed" },
        );
      }
    }

    return { answer, completed };
  });
}
