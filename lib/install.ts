import { prisma } from "@/lib/db";

export type PurchaseSummary = {
  id: string;
  planName: string;
  amount: string;
  currency: string;
  purchasedAt: Date;
  userEmail: string;
};

export type InstallAccess =
  | { status: "allowed"; purchase: PurchaseSummary }
  | { status: "redirect"; to: "/" | "/paywall" };

// A `purchases` row only ever exists for a succeeded payment_attempt
// (enforced by the purchases_require_succeeded_attempt trigger — see
// schema.prisma), so finding a row here already means "has a succeeded
// purchase" — no separate status filter needed. Most recent wins, in the
// unlikely event a user has more than one.
export async function getSucceededPurchase(userId: string): Promise<PurchaseSummary | null> {
  const purchase = await prisma.purchase.findFirst({
    where: { userId },
    orderBy: { purchasedAt: "desc" },
    include: { plan: true, user: true },
  });
  if (!purchase) return null;

  return {
    id: purchase.id,
    planName: purchase.plan.name,
    amount: purchase.amount.toString(),
    currency: purchase.currency,
    purchasedAt: purchase.purchasedAt,
    userEmail: purchase.user.email,
  };
}

// Repeat-visit guard (spec.md 7, 18): every funnel screen a repeat visitor
// could land on first — not only Email/Paywall — must send them straight to
// Install once their identity already has a succeeded purchase, "regardless
// of which screen the repeat visit starts from".
export async function hasSucceededPurchaseForVisitor(visitorId: string | undefined): Promise<boolean> {
  if (!visitorId) return false;
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!visitor || !visitor.userId) return false;
  return (await getSucceededPurchase(visitor.userId)) !== null;
}

// Install access guard (spec.md 16): checked on every request, derived
// purely from server-side state keyed off the visitor cookie value. Accepts
// no client-supplied user/purchase id or success flag — there is nothing to
// trust here because nothing but the cookie's opaque visitor id is read as
// input in the first place.
//
// - No visitor at all, or a visitor that's never linked to a user (email
//   unknown) -> "/" (spec.md 16: "Start, если email вовсе не известен").
// - Identified but no succeeded purchase -> "/paywall".
// - Succeeded purchase exists -> allowed, with a snapshot to render.
export async function resolveInstallAccess(visitorId: string | undefined): Promise<InstallAccess> {
  if (!visitorId) return { status: "redirect", to: "/" };

  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!visitor || !visitor.userId) return { status: "redirect", to: "/" };

  const purchase = await getSucceededPurchase(visitor.userId);
  if (!purchase) return { status: "redirect", to: "/paywall" };

  return { status: "allowed", purchase };
}
