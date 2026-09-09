import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { submitQuizAnswer, InvalidQuizAnswerError, QUIZ_QUESTIONS, TOTAL_QUIZ_STEPS } from "@/lib/quiz";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

function makeRequest(opts: { visitorId?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.visitorId) headers["cookie"] = `${VISITOR_COOKIE_NAME}=${opts.visitorId}`;
  return new NextRequest("http://localhost:3000/api/quiz/answer", { method: "POST", headers });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "funnel_events", "quiz_answers", "purchases", "payment_attempts", "plans", "sessions", "visitors", "users" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("QUIZ_QUESTIONS", () => {
  it("has between 3 and 7 questions, per spec.md 15", () => {
    expect(TOTAL_QUIZ_STEPS).toBeGreaterThanOrEqual(3);
    expect(TOTAL_QUIZ_STEPS).toBeLessThanOrEqual(7);
  });

  it("has steps numbered 1..N with no gaps, and unique question keys", () => {
    expect(QUIZ_QUESTIONS.map((q) => q.step)).toEqual(
      Array.from({ length: TOTAL_QUIZ_STEPS }, (_, i) => i + 1),
    );
    expect(new Set(QUIZ_QUESTIONS.map((q) => q.key)).size).toBe(TOTAL_QUIZ_STEPS);
  });

  it("has at least two product-aware questions (memory, voice)", () => {
    const keys = QUIZ_QUESTIONS.map((q) => q.key);
    expect(keys).toContain("memory_importance");
    expect(keys).toContain("voice_interest");
  });
});

describe("submitQuizAnswer", () => {
  it("persists an answer and records quiz_answer_submitted", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest());

    const { answer, completed } = await submitQuizAnswer(session, visitor, "looking_for", "just_curious");

    expect(answer.answerValue).toBe("just_curious");
    expect(completed).toBe(false);

    const events = await prisma.funnelEvent.findMany({ where: { eventName: "quiz_answer_submitted" } });
    expect(events).toHaveLength(1);
    expect(events[0].properties).toEqual({ question_key: "looking_for", answer_value: "just_curious" });
  });

  it("updates the existing row instead of creating a duplicate when the same question is answered again", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest());

    await submitQuizAnswer(session, visitor, "looking_for", "just_curious");
    await submitQuizAnswer(session, visitor, "looking_for", "romantic_companion");

    const rows = await prisma.quizAnswer.findMany({ where: { sessionId: session.id, questionKey: "looking_for" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].answerValue).toBe("romantic_companion");

    // Both submissions still fire their own quiz_answer_submitted event —
    // the event log isn't deduplicated, only the answer row is.
    const events = await prisma.funnelEvent.count({ where: { eventName: "quiz_answer_submitted" } });
    expect(events).toBe(2);
  });

  it("rejects an answer value that isn't one of the question's options", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest());

    await expect(submitQuizAnswer(session, visitor, "looking_for", "not-a-real-option")).rejects.toBeInstanceOf(
      InvalidQuizAnswerError,
    );
    expect(await prisma.quizAnswer.count()).toBe(0);
  });

  it("rejects an unknown question key", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest());

    await expect(submitQuizAnswer(session, visitor, "not_a_question", "x")).rejects.toBeInstanceOf(
      InvalidQuizAnswerError,
    );
  });

  it("fires quiz_completed exactly once, after the last question is answered", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest());

    let lastResult;
    for (const q of QUIZ_QUESTIONS) {
      lastResult = await submitQuizAnswer(session, visitor, q.key, q.options[0].value);
    }

    expect(lastResult?.completed).toBe(true);
    const completedEvents = await prisma.funnelEvent.count({ where: { eventName: "quiz_completed" } });
    expect(completedEvents).toBe(1);

    // Changing an already-answered question afterwards must not re-fire
    // quiz_completed a second time.
    const first = QUIZ_QUESTIONS[0];
    const otherOption = first.options[1] ?? first.options[0];
    const again = await submitQuizAnswer(session, visitor, first.key, otherOption.value);

    expect(again.completed).toBe(true);
    expect(await prisma.funnelEvent.count({ where: { eventName: "quiz_completed" } })).toBe(1);
  });

  it("carries the visitor's known user_id onto quiz events once identified", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest());
    const user = await prisma.user.create({ data: { email: "quiz-user@example.com" } });
    const linkedVisitor = await prisma.visitor.update({ where: { id: visitor.id }, data: { userId: user.id } });

    await submitQuizAnswer(session, linkedVisitor, "looking_for", "just_curious");

    const event = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "quiz_answer_submitted" } });
    expect(event.userId).toBe(user.id);
  });
});
