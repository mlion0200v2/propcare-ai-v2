import Link from "next/link";
import { clientIp } from "@/lib/request-ip";
import { intakeLinkLimiter } from "@/lib/rate-limit";
import { findUnitByToken, unitLabel } from "@/lib/intake/server";
import { EmergencyNotice, TenantShell } from "@/components/intake/tenant-shell";
import { IntakeForm } from "@/components/intake/intake-form";
import { ConfirmHome } from "@/components/intake/confirm-home";

export const metadata = {
  title: "Report a problem | PropCare",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function TenantLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const allowed = intakeLinkLimiter.check(await clientIp()).allowed;
  const unit = allowed ? await findUnitByToken(token) : null;

  if (!unit) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-4 font-brand text-ink">
        <div className="max-w-sm space-y-4">
          <h1 className="font-display text-3xl">{allowed ? "This link isn't active" : "Please try again shortly"}</h1>
          <p className="text-[15px] leading-relaxed text-muted">
            {allowed
              ? "Your landlord may have turned it off or sent a new one. Ask them for the current link."
              : "Too many requests from this network. Wait a few minutes and reload."}
          </p>
          <EmergencyNotice />
        </div>
      </div>
    );
  }

  return (
    <TenantShell workspaceName={unit.workspace_name} address={unitLabel(unit)}>
      <div className="flex flex-1 flex-col gap-5 px-5 py-6">
        <h1 className="font-display text-[28px] leading-tight">Report a problem in your home</h1>
        <p className="text-sm leading-relaxed text-muted">
          No account needed. Your landlord gets your message, photos, and what you&apos;ve tried.
        </p>
        <EmergencyNotice />
        <ConfirmHome address={unitLabel(unit)}>
          <IntakeForm token={token} />
        </ConfirmHome>
        <p className="mt-auto pt-6 text-xs leading-normal text-muted">
          Your details are used only to handle repairs for this home.{" "}
          <Link href="/login?tenant=1" className="text-pine underline">
            Sign in
          </Link>
        </p>
      </div>
    </TenantShell>
  );
}
