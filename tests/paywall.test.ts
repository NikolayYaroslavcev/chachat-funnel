import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { getActivePlans, recordPlanSelection, InvalidPlanError } from "@/lib/paywall";
import { POST as planSelectedRoute } from "@/app/api/plan-selected/route";
import { POST as purchaseRoute } from "@/app/api/purchase/route";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

function makeRequest(opts: { url: string; visitorId?: string; rawBody: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.visitorId) headers["cookie"] = `${VISITOR_COOKIE_NAME}=${opts.visitorId}`;
  return new NextRequest(opts.url, { method: "POST", headers, body: opts.rawBody });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "funnel_events", "quiz_answers", "purchases", "payment_attempts", "plans", "sessions", "visitors", "users" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makePlans() {
  const weekly = await prisma.plan.create({
    data: { slug: "weekly", name: "Weekly", priceAmount: "6.99", currency: "USD", billingPeriodDays: 7, displayOrder: 1 },
  });
  const monthly = await prisma.plan.create({
    data: { slug: "monthly", name: "Monthly", priceAmount: "14.99", currency: "USD", billingPeriodDays: 30, displayOrder: 2 },
  });
  const threeMonths = await prisma.plan.create({
    data: { slug: "3-months", name: "3 Months", priceAmount: "29.99", currency: "USD", billingPeriodDays: 90, displayOrder: 3 },
  });
  return { weekly, monthly, threeMonths };
}

async function identifiedVisitor() {
  const { visitor, session } = await resolveVisitorSession(
    new NextRequest("http://localhost:3000/api/session", { method: "POST" }),
  );
  const user = await prisma.user.create({ data: { email: `user-${visitor.id}@example.com` } });
  const linked = await prisma.visitor.update({ where: { id: visitor.id }, data: { userId: user.id } });
  return { visitor: linked, session, user };
}

describe("getActivePlans", () => {
  it("returns exactly the three active plans ordered by displayOrder", async () => {
    await makePlans();
    const plans = await getActivePlans();
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.slug)).toEqual(["weekly", "monthly", "3-months"]);
  });

  it("excludes inactive plans", async () => {
    const { weekly } = await makePlans();
    await prisma.plan.update({ where: { id: weekly.id }, data: { isActive: false } });

    const plans = await getActivePlans();
    expect(plans.map((p) => p.slug)).not.toContain("weekly");
    expect(plans).toHaveLength(2);
  });
});

describe("recordPlanSelection", () => {
  it("records plan_selected with session/user/plan context", async () => {
    const { monthly } = await makePlans();
    const { visitor, session, user } = await identifiedVisitor();

    await recordPlanSelection(session, visitor, monthly.id);

    const event = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "plan_selected" } });
    expect(event.sessionId).toBe(session.id);
    expect(event.userId).toBe(user.id);
    expect(event.planId).toBe(monthly.id);
    expect(event.properties).toEqual({ plan_id: monthly.id });
  });

  it("rejects an unknown plan id without recording an event", async () => {
    const { visitor, session } = await identifiedVisitor();

    await expect(recordPlanSelection(session, visitor, "not-a-plan")).rejects.toBeInstanceOf(InvalidPlanError);
    expect(await prisma.funnelEvent.count()).toBe(0);
  });

  it("rejects an inactive plan", async () => {
    const { weekly } = await makePlans();
    await prisma.plan.update({ where: { id: weekly.id }, data: { isActive: false } });
    const { visitor, session } = await identifiedVisitor();

    await expect(recordPlanSelection(session, visitor, weekly.id)).rejects.toBeInstanceOf(InvalidPlanError);
  });
});

describe("POST /api/plan-selected (route)", () => {
  it("rejects a visitor who hasn't identified with an email", async () => {
    const { visitor } = await resolveVisitorSession(
      new NextRequest("http://localhost:3000/api/session", { method: "POST" }),
    );
    const { monthly } = await makePlans();

    const res = await planSelectedRoute(
      makeRequest({
        url: "http://localhost:3000/api/plan-selected",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: monthly.id }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await prisma.funnelEvent.count()).toBe(0);
  });

  it("records plan_selected for an identified visitor", async () => {
    const { monthly } = await makePlans();
    const { visitor } = await identifiedVisitor();

    const res = await planSelectedRoute(
      makeRequest({
        url: "http://localhost:3000/api/plan-selected",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: monthly.id }),
      }),
    );

    expect(res.status).toBe(200);
    const event = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "plan_selected" } });
    expect(event.planId).toBe(monthly.id);
  });

  it("rejects a missing planId", async () => {
    const { visitor } = await identifiedVisitor();

    const res = await planSelectedRoute(
      makeRequest({ url: "http://localhost:3000/api/plan-selected", visitorId: visitor.id, rawBody: "{}" }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects an unknown plan for an identified visitor without recording an event", async () => {
    const { visitor } = await identifiedVisitor();

    const res = await planSelectedRoute(
      makeRequest({
        url: "http://localhost:3000/api/plan-selected",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: "not-a-plan" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await prisma.funnelEvent.count()).toBe(0);
  });
});

describe("POST /api/purchase (route boundary)", () => {
  it("rejects a visitor who hasn't identified with an email", async () => {
    const { visitor } = await resolveVisitorSession(
      new NextRequest("http://localhost:3000/api/session", { method: "POST" }),
    );
    const { monthly } = await makePlans();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: monthly.id, card: { number: "4242424242424242", expiry: "12/30", cvc: "123" } }),
      }),
    );

    expect(res.status).toBe(403);
  });

  it("rejects an unknown plan", async () => {
    const { visitor } = await identifiedVisitor();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: "not-a-plan" }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects a request missing card details without creating a payment_attempt", async () => {
    const { monthly } = await makePlans();
    const { visitor } = await identifiedVisitor();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: monthly.id }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await prisma.paymentAttempt.count()).toBe(0);
  });
});
