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

export async function getActivePlans(): Promise<PlanSummary[]> {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { displayOrder: "asc" },
  });
  return plans.map(toPlanSummary);
}

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
