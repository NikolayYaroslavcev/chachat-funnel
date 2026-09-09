import type { NextRequest } from "next/server";
import type { Prisma, Session, Visitor } from "@prisma/client";
import { prisma } from "@/lib/db";
import { extractAttribution, type Attribution } from "@/lib/attribution";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

export const SESSION_INACTIVITY_MS = 30 * 60 * 1000;

export type VisitorSessionResult = {
  visitor: Visitor;
  session: Session;
  isNewVisitor: boolean;
  isNewSession: boolean;
};

async function getOrCreateSession(
  tx: Prisma.TransactionClient,
  visitorId: string,
  attribution: Attribution,
): Promise<{ session: Session; isNewSession: boolean }> {
  const latest = await tx.session.findFirst({
    where: { visitorId },
    orderBy: { startedAt: "desc" },
  });

  const now = new Date();
  if (latest && now.getTime() - latest.lastActivityAt.getTime() < SESSION_INACTIVITY_MS) {
    const session = await tx.session.update({
      where: { id: latest.id },
      data: { lastActivityAt: now },
    });
    return { session, isNewSession: false };
  }

  const session = await tx.session.create({
    data: { visitorId, ...attribution },
  });
  return { session, isNewSession: true };
}

export async function resolveVisitorSession(
  request: NextRequest,
  attributionOverride?: Attribution,
): Promise<VisitorSessionResult> {
  const attribution = attributionOverride ?? extractAttribution(request);
  const cookieVisitorId = request.cookies.get(VISITOR_COOKIE_NAME)?.value;

  return prisma.$transaction(async (tx) => {
    let visitor: Visitor | null = null;
    let isNewVisitor = false;

    if (cookieVisitorId) {
      visitor = await tx.visitor.findUnique({ where: { id: cookieVisitorId } });
    }

    if (!visitor) {
      visitor = await tx.visitor.create({ data: {} });
      isNewVisitor = true;
    }

    const { session, isNewSession } = await getOrCreateSession(tx, visitor.id, attribution);

    return { visitor, session, isNewVisitor, isNewSession };
  });
}

export async function findActiveSession(visitorId: string): Promise<Session | null> {
  const latest = await prisma.session.findFirst({
    where: { visitorId },
    orderBy: { startedAt: "desc" },
  });
  if (!latest) return null;
  if (Date.now() - latest.lastActivityAt.getTime() >= SESSION_INACTIVITY_MS) return null;
  return latest;
}
