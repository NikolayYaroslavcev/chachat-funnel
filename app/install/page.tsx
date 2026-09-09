import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";
import { resolveInstallAccess } from "@/lib/install";
import { ScreenView } from "@/components/ScreenView";
import { InstallScreen } from "@/components/install/InstallScreen";

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
