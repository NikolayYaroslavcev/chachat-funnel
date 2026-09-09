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

export async function hasSucceededPurchaseForVisitor(visitorId: string | undefined): Promise<boolean> {
  if (!visitorId) return false;
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!visitor || !visitor.userId) return false;
  return (await getSucceededPurchase(visitor.userId)) !== null;
}

export async function resolveInstallAccess(visitorId: string | undefined): Promise<InstallAccess> {
  if (!visitorId) return { status: "redirect", to: "/" };

  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!visitor || !visitor.userId) return { status: "redirect", to: "/" };

  const purchase = await getSucceededPurchase(visitor.userId);
  if (!purchase) return { status: "redirect", to: "/paywall" };

  return { status: "allowed", purchase };
}
