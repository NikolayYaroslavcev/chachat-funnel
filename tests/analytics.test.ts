import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { recordFunnelEvent } from "@/lib/analytics";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { identifyVisitor } from "@/lib/identify";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

function makeRequest(opts: { url?: string; visitorId?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.visitorId) headers["cookie"] = `${VISITOR_COOKIE_NAME}=${opts.visitorId}`;
  return new NextRequest(opts.url ?? "http://localhost:3000/api/session", {
    method: "POST",
    headers,
  });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "funnel_events", "quiz_answers", "purchases", "payment_attempts", "plans", "sessions", "visitors", "users" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makePlan(slug = "monthly") {
  return prisma.plan.create({
    data: {
      slug,
      name: "Monthly",
      priceAmount: "14.99",
      currency: "USD",
      billingPeriodDays: 30,
      displayOrder: 1,
    },
  });
}

describe("recordFunnelEvent", () => {
  it("records an event for an anonymous visitor/session, attributable to the visitor via the session join", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));

    const event = await recordFunnelEvent(
      prisma,
      { sessionId: session.id },
      { eventName: "screen_view", screen: "start" },
    );

    expect(event.sessionId).toBe(session.id);
    expect(event.userId).toBeNull();

    const rows = await prisma.$queryRaw<{ visitor_id: string }[]>`
      SELECT s.visitor_id FROM funnel_events fe
      JOIN sessions s ON s.id = fe.session_id
      WHERE fe.id = ${event.id}
    `;
    expect(rows[0]?.visitor_id).toBe(visitor.id);
  });

  it("persists event properties with the exact keys spec.md 10 requires", async () => {
    const { session } = await resolveVisitorSession(makeRequest({}));

    const quizStep = await recordFunnelEvent(
      prisma,
      { sessionId: session.id },
      { eventName: "screen_view", screen: "quiz", step: "2" },
    );
    expect(quizStep.properties).toEqual({ screen: "quiz", step: "2" });

    const answer = await recordFunnelEvent(
      prisma,
      { sessionId: session.id },
      { eventName: "quiz_answer_submitted", questionKey: "age_range", answerValue: "25-34" },
    );
    expect(answer.properties).toEqual({ question_key: "age_range", answer_value: "25-34" });

    const completed = await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "quiz_completed" });
    expect(completed.properties).toBeNull();
  });

  it("represents plan/payment/purchase context via both relation columns and properties", async () => {
    const { session } = await resolveVisitorSession(makeRequest({}));
    const user = await prisma.user.create({ data: { email: "payer@example.com" } });
    const plan = await makePlan();
    const attempt = await prisma.paymentAttempt.create({
      data: { userId: user.id, planId: plan.id, status: "succeeded" },
    });
    const purchase = await prisma.purchase.create({
      data: {
        paymentAttemptId: attempt.id,
        userId: user.id,
        planId: plan.id,
        amount: "14.99",
        currency: "USD",
      },
    });

    const planSelected = await recordFunnelEvent(
      prisma,
      { sessionId: session.id, userId: user.id },
      { eventName: "plan_selected", planId: plan.id },
    );
    expect(planSelected.planId).toBe(plan.id);
    expect(planSelected.properties).toEqual({ plan_id: plan.id });

    const attempted = await recordFunnelEvent(
      prisma,
      { sessionId: session.id, userId: user.id },
      { eventName: "purchase_attempted", planId: plan.id, paymentAttemptId: attempt.id },
    );
    expect(attempted.paymentAttemptId).toBe(attempt.id);
    expect(attempted.planId).toBe(plan.id);

    const succeeded = await recordFunnelEvent(
      prisma,
      { sessionId: session.id, userId: user.id },
      {
        eventName: "purchase_succeeded",
        planId: plan.id,
        paymentAttemptId: attempt.id,
        purchaseId: purchase.id,
        amount: purchase.amount,
      },
    );
    expect(succeeded.purchaseId).toBe(purchase.id);
    expect(succeeded.properties).toEqual({
      payment_attempt_id: attempt.id,
      purchase_id: purchase.id,
      plan_id: plan.id,
      amount: "14.99",
    });

    const failed = await recordFunnelEvent(
      prisma,
      { sessionId: session.id, userId: user.id },
      { eventName: "purchase_failed", planId: plan.id, paymentAttemptId: attempt.id, reason: "declined" },
    );
    expect(failed.properties).toMatchObject({ reason: "declined" });

    const installViewed = await recordFunnelEvent(
      prisma,
      { sessionId: session.id, userId: user.id },
      { eventName: "install_viewed", purchaseId: purchase.id },
    );
    expect(installViewed.purchaseId).toBe(purchase.id);
  });

  it("does not deduplicate repeatable events — two screen_view calls for the same screen produce two rows", async () => {
    const { session } = await resolveVisitorSession(makeRequest({}));

    await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "screen_view", screen: "start" });
    await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "screen_view", screen: "start" });

    const count = await prisma.funnelEvent.count({ where: { sessionId: session.id, eventName: "screen_view" } });
    expect(count).toBe(2);
  });

  it("is append-only: updating or deleting a recorded event is rejected at the DB level", async () => {
    const { session } = await resolveVisitorSession(makeRequest({}));
    const event = await recordFunnelEvent(
      prisma,
      { sessionId: session.id },
      { eventName: "screen_view", screen: "start" },
    );

    await expect(
      prisma.funnelEvent.update({ where: { id: event.id }, data: { properties: { screen: "quiz" } } }),
    ).rejects.toThrow();

    await expect(prisma.funnelEvent.delete({ where: { id: event.id } })).rejects.toThrow();

    const stillThere = await prisma.funnelEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(stillThere.properties).toEqual({ screen: "start" });
  });
});

describe("email_submitted wiring in identifyVisitor", () => {
  it("records email_submitted for a new user, associated with the correct session and user", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    const result = await identifyVisitor(req, visitor, session, "new@example.com");

    const events = await prisma.funnelEvent.findMany({ where: { eventName: "email_submitted" } });
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe(session.id);
    expect(events[0].userId).toBe(result.user.id);
    expect(events[0].properties).toEqual({ is_new_user: true, is_existing_user: false });
  });

  it("does not duplicate pre-identification anonymous events, and leaves their user_id null even after the visitor links", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const preIdEvent = await recordFunnelEvent(
      prisma,
      { sessionId: session.id },
      { eventName: "screen_view", screen: "start" },
    );
    expect(preIdEvent.userId).toBeNull();

    const req = makeRequest({ visitorId: visitor.id });
    await identifyVisitor(req, visitor, session, "linked@example.com");

    const unchanged = await prisma.funnelEvent.findUniqueOrThrow({ where: { id: preIdEvent.id } });
    expect(unchanged.userId).toBeNull();
    expect(unchanged.sessionId).toBe(session.id);

    const totalScreenViews = await prisma.funnelEvent.count({ where: { eventName: "screen_view" } });
    expect(totalScreenViews).toBe(1);
  });

  it("fires email_submitted again (not deduplicated) on a repeated identical submission, per repeatable-action semantics", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    await identifyVisitor(req, visitor, session, "repeat@example.com");
    await identifyVisitor(req, visitor, session, "repeat@example.com");

    const events = await prisma.funnelEvent.findMany({
      where: { eventName: "email_submitted" },
      orderBy: { occurredAt: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(await prisma.user.count()).toBe(1);
    // First submission creates the user; the repeated submission is the
    // idempotent no-op path, but still fires its own event.
    expect(events[0].properties).toEqual({ is_new_user: true, is_existing_user: false });
    expect(events[1].properties).toEqual({ is_new_user: false, is_existing_user: true });
  });

  it("attaches email_submitted to the new session/user when re-anchoring identity for a different email", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    const first = await identifyVisitor(req, visitor, session, "first@example.com");
    const second = await identifyVisitor(req, visitor, session, "second@example.com");

    const events = await prisma.funnelEvent.findMany({
      where: { eventName: "email_submitted" },
      orderBy: { occurredAt: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events[0].sessionId).toBe(session.id);
    expect(events[0].userId).toBe(first.user.id);
    expect(events[1].sessionId).toBe(second.session.id);
    expect(events[1].sessionId).not.toBe(session.id);
    expect(events[1].userId).toBe(second.user.id);
  });
});

describe("funnel analytics SQL scenarios", () => {
  it("supports funnel drop-off by screen via count(distinct session) per screen_view", async () => {
    const { session: s1 } = await resolveVisitorSession(makeRequest({}));
    const { session: s2 } = await resolveVisitorSession(makeRequest({}));

    await recordFunnelEvent(prisma, { sessionId: s1.id }, { eventName: "screen_view", screen: "start" });
    await recordFunnelEvent(prisma, { sessionId: s1.id }, { eventName: "screen_view", screen: "quiz", step: "1" });
    await recordFunnelEvent(prisma, { sessionId: s1.id }, { eventName: "screen_view", screen: "email" });
    await recordFunnelEvent(prisma, { sessionId: s2.id }, { eventName: "screen_view", screen: "start" });

    const rows = await prisma.$queryRaw<{ screen: string; sessions: bigint }[]>`
      SELECT properties->>'screen' AS screen, COUNT(DISTINCT session_id) AS sessions
      FROM funnel_events
      WHERE event_name = 'screen_view'
      GROUP BY properties->>'screen'
      ORDER BY sessions DESC
    `;
    const byScreen = Object.fromEntries(rows.map((r) => [r.screen, Number(r.sessions)]));
    expect(byScreen.start).toBe(2);
    expect(byScreen.quiz).toBe(1);
    expect(byScreen.email).toBe(1);
  });

  it("supports paywall/purchase conversion and plan popularity from plan_id/purchase events", async () => {
    const plan = await makePlan("weekly");
    const user1 = await prisma.user.create({ data: { email: "conv1@example.com" } });
    const user2 = await prisma.user.create({ data: { email: "conv2@example.com" } });
    const { session: s1 } = await resolveVisitorSession(makeRequest({}));
    const { session: s2 } = await resolveVisitorSession(makeRequest({}));

    const attempt1 = await prisma.paymentAttempt.create({ data: { userId: user1.id, planId: plan.id, status: "succeeded" } });
    const purchase1 = await prisma.purchase.create({
      data: { paymentAttemptId: attempt1.id, userId: user1.id, planId: plan.id, amount: "6.99", currency: "USD" },
    });
    const attempt2 = await prisma.paymentAttempt.create({ data: { userId: user2.id, planId: plan.id, status: "declined" } });

    await recordFunnelEvent(prisma, { sessionId: s1.id, userId: user1.id }, { eventName: "plan_selected", planId: plan.id });
    await recordFunnelEvent(prisma, { sessionId: s1.id, userId: user1.id }, { eventName: "purchase_attempted", planId: plan.id, paymentAttemptId: attempt1.id });
    await recordFunnelEvent(prisma, { sessionId: s1.id, userId: user1.id }, { eventName: "purchase_succeeded", planId: plan.id, paymentAttemptId: attempt1.id, purchaseId: purchase1.id, amount: purchase1.amount });

    await recordFunnelEvent(prisma, { sessionId: s2.id, userId: user2.id }, { eventName: "plan_selected", planId: plan.id });
    await recordFunnelEvent(prisma, { sessionId: s2.id, userId: user2.id }, { eventName: "purchase_attempted", planId: plan.id, paymentAttemptId: attempt2.id });
    await recordFunnelEvent(prisma, { sessionId: s2.id, userId: user2.id }, { eventName: "purchase_failed", planId: plan.id, paymentAttemptId: attempt2.id, reason: "declined" });

    const rows = await prisma.$queryRaw<{ attempted: bigint; succeeded: bigint }[]>`
      SELECT
        COUNT(*) FILTER (WHERE event_name = 'purchase_attempted') AS attempted,
        COUNT(*) FILTER (WHERE event_name = 'purchase_succeeded') AS succeeded
      FROM funnel_events
      WHERE plan_id = ${plan.id}
    `;
    expect(Number(rows[0].attempted)).toBe(2);
    expect(Number(rows[0].succeeded)).toBe(1);
  });

  it("supports acquisition by UTM via the funnel_events -> sessions join", async () => {
    const { session: googleSession } = await resolveVisitorSession(
      makeRequest({ url: "http://localhost:3000/api/session?utm_source=google" }),
    );
    const { session: directSession } = await resolveVisitorSession(makeRequest({}));

    await recordFunnelEvent(prisma, { sessionId: googleSession.id }, { eventName: "screen_view", screen: "start" });
    await recordFunnelEvent(prisma, { sessionId: directSession.id }, { eventName: "screen_view", screen: "start" });

    const rows = await prisma.$queryRaw<{ utm_source: string | null; sessions: bigint }[]>`
      SELECT s.utm_source, COUNT(DISTINCT fe.session_id) AS sessions
      FROM funnel_events fe
      JOIN sessions s ON s.id = fe.session_id
      WHERE fe.event_name = 'screen_view'
      GROUP BY s.utm_source
    `;
    const byUtm = Object.fromEntries(rows.map((r) => [r.utm_source ?? "(none)", Number(r.sessions)]));
    expect(byUtm.google).toBe(1);
    expect(byUtm["(none)"]).toBe(1);
  });

  it("supports quiz per-question drop-off via question_key", async () => {
    const { session } = await resolveVisitorSession(makeRequest({}));
    await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "quiz_answer_submitted", questionKey: "q1", answerValue: "a" });
    await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "quiz_answer_submitted", questionKey: "q2", answerValue: "b" });

    const rows = await prisma.$queryRaw<{ question_key: string; sessions: bigint }[]>`
      SELECT properties->>'question_key' AS question_key, COUNT(DISTINCT session_id) AS sessions
      FROM funnel_events
      WHERE event_name = 'quiz_answer_submitted'
      GROUP BY properties->>'question_key'
    `;
    expect(rows).toHaveLength(2);
  });

  it("supports reconstructing a single user's full funnel history in occurred_at order", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "screen_view", screen: "start" });
    await recordFunnelEvent(prisma, { sessionId: session.id }, { eventName: "quiz_answer_submitted", questionKey: "q1", answerValue: "a" });

    const req = makeRequest({ visitorId: visitor.id });
    const identified = await identifyVisitor(req, visitor, session, "history@example.com");

    const plan = await makePlan("history-plan");
    await recordFunnelEvent(prisma, { sessionId: session.id, userId: identified.user.id }, { eventName: "plan_selected", planId: plan.id });

    const rows = await prisma.$queryRaw<{ event_name: string }[]>`
      SELECT fe.event_name
      FROM funnel_events fe
      JOIN sessions s ON s.id = fe.session_id
      JOIN visitors v ON v.id = s.visitor_id
      WHERE v.user_id = ${identified.user.id}
      ORDER BY fe.occurred_at ASC
    `;
    expect(rows.map((r) => r.event_name)).toEqual([
      "screen_view",
      "quiz_answer_submitted",
      "email_submitted",
      "plan_selected",
    ]);
  });
});
