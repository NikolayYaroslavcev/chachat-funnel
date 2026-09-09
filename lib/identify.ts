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
            await recordFunnelEvent(
              tx,
              { sessionId: session.id, userId: linkedUser.id },
              { eventName: "email_submitted", isNewUser: false, isExistingUser: true },
            );
            return { visitor: freshVisitor, session, user: linkedUser, isNewUser: false };
          }

          const newVisitor = await tx.visitor.create({ data: {} });
          const newSession = await tx.session.create({
            data: { visitorId: newVisitor.id, ...attribution },
          });
          const { user, isNewUser } = await findOrCreateUser(tx, normalizedEmail);
          const linkedVisitor = await tx.visitor.update({
            where: { id: newVisitor.id },
            data: { userId: user.id },
          });
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
