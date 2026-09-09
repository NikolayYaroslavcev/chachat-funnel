import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveVisitorSession, SESSION_INACTIVITY_MS } from "@/lib/visitor-session";
import { identifyVisitor, InvalidEmailError } from "@/lib/identify";
import { POST as identifyRoute } from "@/app/api/identify/route";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

function makeRequest(opts: {
  url?: string;
  referer?: string;
  visitorId?: string;
}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.referer) headers["referer"] = opts.referer;
  if (opts.visitorId) headers["cookie"] = `${VISITOR_COOKIE_NAME}=${opts.visitorId}`;
  return new NextRequest(opts.url ?? "http://localhost:3000/api/session", {
    method: "POST",
    headers,
  });
}

function makeIdentifyRequest(opts: { visitorId?: string; rawBody: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.visitorId) headers["cookie"] = `${VISITOR_COOKIE_NAME}=${opts.visitorId}`;
  return new NextRequest("http://localhost:3000/api/identify", {
    method: "POST",
    headers,
    body: opts.rawBody,
  });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "quiz_answers", "purchases", "payment_attempts", "plans", "sessions", "visitors", "users" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("resolveVisitorSession", () => {
  it("creates a new visitor and session on first contact", async () => {
    const req = makeRequest({ url: "http://localhost:3000/api/session?utm_source=google" });
    const result = await resolveVisitorSession(req);

    expect(result.isNewVisitor).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.session.visitorId).toBe(result.visitor.id);
    expect(result.session.utmSource).toBe("google");
  });

  it("persists the same visitor across requests via the cookie", async () => {
    const first = await resolveVisitorSession(makeRequest({}));
    const second = await resolveVisitorSession(makeRequest({ visitorId: first.visitor.id }));

    expect(second.visitor.id).toBe(first.visitor.id);
    expect(second.isNewVisitor).toBe(false);
  });

  it("reuses the current session on a repeat request within the inactivity window", async () => {
    const first = await resolveVisitorSession(makeRequest({}));
    const second = await resolveVisitorSession(makeRequest({ visitorId: first.visitor.id }));

    expect(second.session.id).toBe(first.session.id);
    expect(second.isNewSession).toBe(false);
  });

  it("starts a new session after the inactivity window elapses, without touching the old session's attribution", async () => {
    const first = await resolveVisitorSession(
      makeRequest({ url: "http://localhost:3000/api/session?utm_source=google" }),
    );

    await prisma.session.update({
      where: { id: first.session.id },
      data: { lastActivityAt: new Date(Date.now() - SESSION_INACTIVITY_MS - 60_000) },
    });

    const second = await resolveVisitorSession(
      makeRequest({
        url: "http://localhost:3000/api/session?utm_source=newsletter",
        visitorId: first.visitor.id,
      }),
    );

    expect(second.isNewVisitor).toBe(false);
    expect(second.isNewSession).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.utmSource).toBe("newsletter");

    const originalSession = await prisma.session.findUniqueOrThrow({ where: { id: first.session.id } });
    expect(originalSession.utmSource).toBe("google");
  });
});

describe("identifyVisitor", () => {
  it("creates exactly one new user for a new email and links the visitor", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    const result = await identifyVisitor(req, visitor, session, "New@Example.com");

    expect(result.isNewUser).toBe(true);
    expect(result.user.email).toBe("new@example.com");

    const linkedVisitor = await prisma.visitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(linkedVisitor.userId).toBe(result.user.id);

    const userCount = await prisma.user.count({ where: { email: { equals: "new@example.com", mode: "insensitive" } } });
    expect(userCount).toBe(1);
  });

  it("rejects a malformed email without creating anything", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    await expect(identifyVisitor(req, visitor, session, "not-an-email")).rejects.toBeInstanceOf(
      InvalidEmailError,
    );

    const linkedVisitor = await prisma.visitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(linkedVisitor.userId).toBeNull();
    expect(await prisma.user.count()).toBe(0);
  });

  it("links to the existing user for an existing email without creating a duplicate, preserving prior history and existing purchases", async () => {
    const existingUser = await prisma.user.create({ data: { email: "existing@example.com" } });

    const priorVisitor = await prisma.visitor.create({ data: { userId: existingUser.id } });
    await prisma.session.create({
      data: { visitorId: priorVisitor.id, utmSource: "old-campaign" },
    });
    const plan = await prisma.plan.create({
      data: {
        slug: "test-plan",
        name: "Test",
        priceAmount: "9.99",
        currency: "USD",
        billingPeriodDays: 30,
        displayOrder: 1,
      },
    });
    const attempt = await prisma.paymentAttempt.create({
      data: { userId: existingUser.id, planId: plan.id, status: "succeeded" },
    });
    const purchase = await prisma.purchase.create({
      data: {
        paymentAttemptId: attempt.id,
        userId: existingUser.id,
        planId: plan.id,
        amount: "9.99",
        currency: "USD",
      },
    });

    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    await prisma.quizAnswer.create({
      data: { sessionId: session.id, questionKey: "q1", answerValue: "a1" },
    });

    const req = makeRequest({ visitorId: visitor.id });
    const result = await identifyVisitor(req, visitor, session, "Existing@Example.com");

    expect(result.isNewUser).toBe(false);
    expect(result.user.id).toBe(existingUser.id);
    expect(await prisma.user.count()).toBe(1);

    const answer = await prisma.quizAnswer.findFirstOrThrow({ where: { sessionId: session.id } });
    expect(answer.answerValue).toBe("a1");

    const stillThere = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    expect(stillThere.userId).toBe(existingUser.id);

    const linkedVisitor = await prisma.visitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(linkedVisitor.userId).toBe(existingUser.id);
  });

  it("is idempotent for a repeated identical identify call", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    const first = await identifyVisitor(req, visitor, session, "repeat@example.com");
    const second = await identifyVisitor(req, visitor, session, "repeat@example.com");
    const third = await identifyVisitor(req, visitor, session, "REPEAT@EXAMPLE.COM");

    expect(first.user.id).toBe(second.user.id);
    expect(second.user.id).toBe(third.user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("never reassigns an already-linked visitor to a different user; starts a new identity instead", async () => {
    const { visitor, session } = await resolveVisitorSession(makeRequest({}));
    const req = makeRequest({ visitorId: visitor.id });

    const first = await identifyVisitor(req, visitor, session, "first@example.com");
    const second = await identifyVisitor(req, visitor, session, "second@example.com");

    expect(second.user.id).not.toBe(first.user.id);
    expect(second.visitor.id).not.toBe(visitor.id);

    const originalVisitor = await prisma.visitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(originalVisitor.userId).toBe(first.user.id);

    expect(await prisma.user.count()).toBe(2);
  });

  it("handles concurrent identify calls for two different visitors submitting the same new email without creating duplicate users", async () => {
    const a = await resolveVisitorSession(makeRequest({}));
    const b = await resolveVisitorSession(makeRequest({}));

    const [resultA, resultB] = await Promise.all([
      identifyVisitor(makeRequest({ visitorId: a.visitor.id }), a.visitor, a.session, "concurrent@example.com"),
      identifyVisitor(makeRequest({ visitorId: b.visitor.id }), b.visitor, b.session, "concurrent@example.com"),
    ]);

    expect(resultA.user.id).toBe(resultB.user.id);
    expect(await prisma.user.count({ where: { email: { equals: "concurrent@example.com", mode: "insensitive" } } })).toBe(1);

    const visitorA = await prisma.visitor.findUniqueOrThrow({ where: { id: a.visitor.id } });
    const visitorB = await prisma.visitor.findUniqueOrThrow({ where: { id: b.visitor.id } });
    expect(visitorA.userId).toBe(resultA.user.id);
    expect(visitorB.userId).toBe(resultA.user.id);
  });
});

describe("POST /api/identify (route)", () => {
  it("rejects a missing email field without creating anything", async () => {
    const res = await identifyRoute(makeIdentifyRequest({ rawBody: "{}" }));
    expect(res.status).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects an invalid JSON body", async () => {
    const res = await identifyRoute(makeIdentifyRequest({ rawBody: "not json" }));
    expect(res.status).toBe(400);
  });

  it("returns a 400 with message 'invalid email' for a malformed address, which the Email UI maps to its inline validation copy", async () => {
    const res = await identifyRoute(makeIdentifyRequest({ rawBody: JSON.stringify({ email: "not-an-email" }) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe("invalid email");
  });

  it("identifies a new email, sets the visitor cookie, and reports isNewUser: true", async () => {
    const { visitor } = await resolveVisitorSession(makeRequest({}));
    const res = await identifyRoute(
      makeIdentifyRequest({ visitorId: visitor.id, rawBody: JSON.stringify({ email: "route-new@example.com" }) }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", isNewUser: true });
    expect(res.cookies.get(VISITOR_COOKIE_NAME)?.value).toBe(visitor.id);

    const linked = await prisma.visitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(linked.userId).not.toBeNull();
    expect(await prisma.user.count()).toBe(1);
  });

  it("links an existing email via the route without creating a duplicate user", async () => {
    const existing = await prisma.user.create({ data: { email: "route-existing@example.com" } });
    const { visitor } = await resolveVisitorSession(makeRequest({}));

    const res = await identifyRoute(
      makeIdentifyRequest({
        visitorId: visitor.id,
        rawBody: JSON.stringify({ email: "Route-Existing@Example.com" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isNewUser).toBe(false);
    expect(await prisma.user.count()).toBe(1);

    const linked = await prisma.visitor.findUniqueOrThrow({ where: { id: visitor.id } });
    expect(linked.userId).toBe(existing.id);
  });

  it("is idempotent via the route for a repeated identical submission (same visitor cookie, no duplicate user)", async () => {
    const { visitor } = await resolveVisitorSession(makeRequest({}));
    const body = JSON.stringify({ email: "route-repeat@example.com" });

    const first = await identifyRoute(makeIdentifyRequest({ visitorId: visitor.id, rawBody: body }));
    const second = await identifyRoute(makeIdentifyRequest({ visitorId: visitor.id, rawBody: body }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.cookies.get(VISITOR_COOKIE_NAME)?.value).toBe(visitor.id);
    expect(second.cookies.get(VISITOR_COOKIE_NAME)?.value).toBe(visitor.id);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("attribution", () => {
  it("computes canonical first-touch attribution as the earliest session across a user's linked visitors", async () => {
    const user = await prisma.user.create({ data: { email: "firsttouch@example.com" } });

    const visitor1 = await prisma.visitor.create({ data: { userId: user.id } });
    const earlySession = await prisma.session.create({
      data: {
        visitorId: visitor1.id,
        utmSource: "google",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const visitor2 = await prisma.visitor.create({ data: { userId: user.id } });
    await prisma.session.create({
      data: {
        visitorId: visitor2.id,
        utmSource: "newsletter",
        startedAt: new Date("2026-02-01T00:00:00Z"),
        lastActivityAt: new Date("2026-02-01T00:00:00Z"),
      },
    });

    const rows = await prisma.$queryRaw<{ utm_source: string | null }[]>`
      SELECT s.utm_source
      FROM sessions s
      JOIN visitors v ON v.id = s.visitor_id
      WHERE v.user_id = ${user.id}
      ORDER BY s.started_at ASC
      LIMIT 1
    `;

    expect(rows[0]?.utm_source).toBe("google");
    expect(rows[0]?.utm_source).not.toBe("newsletter");
    expect(earlySession.utmSource).toBe("google");
  });
});
