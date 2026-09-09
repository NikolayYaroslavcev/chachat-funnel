import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { getActivePlans } from "@/lib/paywall";
import { getSucceededPurchase } from "@/lib/install";
import { ScreenView } from "@/components/ScreenView";
import { PaywallScreen } from "@/components/paywall/PaywallScreen";

// Paywall (spec.md 4.4): reachable only for an already-identified visitor
// (email known) — same server-enforced guard the Stage 8 placeholder had,
// since spec.md 4 forbids relying on client navigation alone to keep a
// fresh identity off this screen.
export default async function PaywallPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  const visitor = visitorId ? await prisma.visitor.findUnique({ where: { id: visitorId } }) : null;
  if (!visitor || !visitor.userId) {
    redirect("/email");
  }

  // Repeat visit (spec.md 7): an already-identified user who already has a
  // succeeded purchase is sent straight to Install instead of being asked
  // to pay again, no matter which funnel screen the repeat visit lands on.
  if (await getSucceededPurchase(visitor.userId)) {
    redirect("/install");
  }

  const plans = await getActivePlans();

  return (
    <>
      <ScreenView screen="paywall" />
      <PaywallScreen plans={plans} />
    </>
  );
}
