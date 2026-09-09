import type { NextRequest } from "next/server";
import type { Prisma, Session, Visitor } from "@prisma/client";
import { prisma } from "@/lib/db";
import { extractAttribution, type Attribution } from "@/lib/attribution";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

// A session is considered expired after 30 minutes of inactivity
// (spec.md 7). The exact number is explicitly a non-critical implementation
// detail per spec.md 20, hence a plain constant rather than configuration.
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

// Resolves (creating if necessary) the visitor + session for the current
// request: reads the visitor cookie, creates a visitor if it's absent or
// stale, and finds-or-creates a session per the inactivity rule (spec.md 7).
// Does not write the response cookie itself — the caller (a route handler)
// owns the response and must call setVisitorCookie with the returned
// visitor.id.
//
// `attributionOverride`, when given, is used instead of attribution derived
// from `request` itself (see attributionFromLandingUrl's comment) — only
// relevant the moment a *new* session actually gets created; an existing,
// still-active session's attribution is never touched either way.
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

// Read-only counterpart to resolveVisitorSession, for Server Component pages
// that need to know "what's the visitor's current session" (e.g. to prefill
// a previously saved quiz answer) without creating/touching anything — a
// page render must stay side-effect-free (it can't set cookies, and
// bumping lastActivityAt or creating a session here would make prefetches
// and re-renders mutate state). Applies the same inactivity rule as
// getOrCreateSession (spec.md 7): a session past the window is treated as
// absent, so a stale session's answers never appear as "resumable" — the
// next real (mutating) request will transparently start a fresh session.
export async function findActiveSession(visitorId: string): Promise<Session | null> {
  const latest = await prisma.session.findFirst({
    where: { visitorId },
    orderBy: { startedAt: "desc" },
  });
  if (!latest) return null;
  if (Date.now() - latest.lastActivityAt.getTime() >= SESSION_INACTIVITY_MS) return null;
  return latest;
}
