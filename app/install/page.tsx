import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { resolveInstallAccess } from "@/lib/install";
import { ScreenView } from "@/components/ScreenView";
import { InstallScreen } from "@/components/install/InstallScreen";

// Install (spec.md 4.6, 16): the only funnel screen gated on a real,
// server-side succeeded purchase rather than any client navigation state or
// prior payment response — checked fresh on every request via
// resolveInstallAccess, so a refresh, a direct URL visit, or a stale client
// "success" flag all resolve from the same current DB state, not a cached
// one. No purchase is ever created or altered here (read-only guard).
export default async function InstallPage() {
  const cookieStore = await cookies();
  const visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;

  const access = await resolveInstallAccess(visitorId);
  if (access.status === "redirect") {
    redirect(access.to);
  }

  return (
    <>
      <ScreenView screen="install" />
      <InstallScreen purchase={access.purchase} />
    </>
  );
}
