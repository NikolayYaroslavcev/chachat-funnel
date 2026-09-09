import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { getActivePlans } from "@/lib/paywall";
import { getSucceededPurchase } from "@/lib/install";
import { ScreenView } from "@/components/ScreenView";
import { PaywallScreen } from "@/components/paywall/PaywallScreen";

export default async function PaywallPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  const visitor = visitorId ? await prisma.visitor.findUnique({ where: { id: visitorId } }) : null;
  if (!visitor || !visitor.userId) {
    redirect("/email");
  }

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
