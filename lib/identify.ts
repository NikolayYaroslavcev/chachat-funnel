import type { NextRequest } from "next/server";
import { Prisma, type Session, type User, type Visitor } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { extractAttribution } from "@/lib/attribution";
import { recordFunnelEvent } from "@/lib/analytics";

export class InvalidEmailError extends Error {}

export type IdentifyResult = {
  visitor: Visitor;
  session: Session;
  user: User;
  isNewUser: boolean;
};

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// users.email uniqueness is a case-insensitive functional index
// (LOWER(email)), not a plain Prisma @unique (see schema.prisma), so the
// lookup mirrors that exact expression via raw SQL rather than trusting
// Prisma's `mode: "insensitive"` translation to match it.
async function findOrCreateUser(
  tx: Prisma.TransactionClient,
  normalizedEmail: string,
): Promise<{ user: User; isNewUser: boolean }> {
  const existing = await tx.$queryRaw<User[]>`
    SELECT id, email, created_at AS "createdAt" FROM users
    WHERE LOWER(email) = LOWER(${normalizedEmail})
    LIMIT 1
  `;
  if (existing.length > 0) {
    return { user: existing[0], isNewUser: false };
  }
  const created = await tx.user.create({ data: { email: normalizedEmail } });
  return { user: created, isNewUser: true };
}

// Core identity-linking operation (spec.md 5-6). `visitor`/`session` are the
// already-resolved current identity (from resolveVisitorSession) — this
// re-reads the visitor fresh inside the transaction rather than trusting
// the passed-in snapshot, since another request may have linked it since.
//
// Wrapped in a retry loop instead of catching-and-continuing inside the
// same transaction: once Postgres raises a unique-violation inside a
// transaction, that transaction is aborted and no further statements can
// run on it. So on a race (two visitors identifying with the same
// brand-new email concurrently), the loser's whole attempt is retried from
// scratch — a fresh transaction whose SELECT now finds the row the winner
// already committed.
export async function identifyVisitor(
  request: NextRequest,
  visitor: Visitor,
  session: Session,
  rawEmail: string,
): Promise<IdentifyResult> {
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!isValidEmail(normalizedEmail)) {
    throw new InvalidEmailError("invalid email format");
  }

  const attribution = extractAttribution(request);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const freshVisitor = await tx.visitor.findUniqueOrThrow({ where: { id: visitor.id } });

        if (freshVisitor.userId) {
          const linkedUser = await tx.user.findUniqueOrThrow({ where: { id: freshVisitor.userId } });

          if (normalizeEmail(linkedUser.email) === normalizedEmail) {
            // Same email re-submitted against an already-linked visitor:
            // idempotent no-op for the identity link (spec.md 5), but the
            // form submission itself still happened, so the event still
            // fires — email_submitted is a repeatable action, not a
            // one-time transition (see lib/analytics.ts).
            await recordFunnelEvent(
              tx,
              { sessionId: session.id, userId: linkedUser.id },
              { eventName: "email_submitted", isNewUser: false, isExistingUser: true },
            );
            return { visitor: freshVisitor, session, user: linkedUser, isNewUser: false };
          }

          // Different email after this visitor is already linked: spec.md 5
          // forbids ever reassigning visitor.user_id to a different user
          // (also enforced by a DB trigger as a backstop). Instead, start a
          // fresh anonymous identity for the new email so the already
          // established visitor<->user link is never disturbed.
          const newVisitor = await tx.visitor.create({ data: {} });
          const newSession = await tx.session.create({
            data: { visitorId: newVisitor.id, ...attribution },
          });
          const { user, isNewUser } = await findOrCreateUser(tx, normalizedEmail);
          const linkedVisitor = await tx.visitor.update({
            where: { id: newVisitor.id },
            data: { userId: user.id },
          });
          // Attaches to the *new* session, since that's where this
          // (re-anchored) identity's email submission actually happened —
          // the original session stays with the original visitor/user.
          await recordFunnelEvent(
            tx,
            { sessionId: newSession.id, userId: user.id },
            { eventName: "email_submitted", isNewUser, isExistingUser: !isNewUser },
          );
          return { visitor: linkedVisitor, session: newSession, user, isNewUser };
        }

        const { user, isNewUser } = await findOrCreateUser(tx, normalizedEmail);
        const linkedVisitor = await tx.visitor.update({
          where: { id: freshVisitor.id },
          data: { userId: user.id },
        });
        await recordFunnelEvent(
          tx,
          { sessionId: session.id, userId: user.id },
          { eventName: "email_submitted", isNewUser, isExistingUser: !isNewUser },
        );
        return { visitor: linkedVisitor, session, user, isNewUser };
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err) && attempt < maxAttempts) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("identifyVisitor: exhausted retry attempts");
}
