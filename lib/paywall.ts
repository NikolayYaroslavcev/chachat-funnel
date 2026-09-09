import type { Plan, Session, Visitor } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordFunnelEvent } from "@/lib/analytics";

export class InvalidPlanError extends Error {}

export type PlanSummary = {
  id: string;
  slug: string;
  name: string;
  priceAmount: string;
  currency: string;
  billingPeriodDays: number;
};

// Decimal isn't a plain serializable value across the Server Component ->
// Client Component boundary, so callers get a plain string instead —
// display formatting stays a UI concern, not this module's.
function toPlanSummary(plan: Plan): PlanSummary {
  return {
    id: plan.id,
    slug: plan.slug,
    name: plan.name,
    priceAmount: plan.priceAmount.toString(),
    currency: plan.currency,
    billingPeriodDays: plan.billingPeriodDays,
  };
}

// The Paywall's three plans (spec.md 14), read from the seeded `plans`
// catalog (prisma/seed.mjs) rather than a second hardcoded list, so pricing
// and copy can never drift from what's actually in the database.
export async function getActivePlans(): Promise<PlanSummary[]> {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: "asc" },
  });
  return plans.map(toPlanSummary);
}

// Records a user's plan choice on the Paywall (spec.md 4.4, 10). Re-reads
// the plan from the DB rather than trusting a client-sent id, so an
// unknown/inactive plan can never be recorded as "selected".
export async function recordPlanSelection(session: Session, visitor: Visitor, planId: string): Promise<PlanSummary> {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    throw new InvalidPlanError(`unknown or inactive plan: ${planId}`);
  }

  await recordFunnelEvent(
    prisma,
    { sessionId: session.id, userId: visitor.userId },
    { eventName: "plan_selected", planId: plan.id },
  );

  return toPlanSummary(plan);
}
