import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { findUnitByToken, unitLabel } from "@/lib/intake/server";
import { TenantShell } from "@/components/intake/tenant-shell";
import { KeepAccountCard } from "@/components/intake/keep-account";
import { TriageChat } from "@/components/triage/chat";

export const metadata = {
  title: "Report a problem | PropCare",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function TenantChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { token } = await params;
  const { t } = await searchParams;

  const unit = await findUnitByToken(token);
  if (!unit) redirect(`/r/${token}`);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/r/${token}`);

  // RLS returns the tenancy only if this session holds it or confirmed a
  // code for it (verifications are cleared when the link is turned off or
  // regenerated).
  let query = supabase.from("tenancies").select("id").eq("unit_id", unit.unit_id).is("ended_at", null);
  if (t && /^[0-9a-f-]{36}$/i.test(t)) query = query.eq("id", t);
  const { data: tenancy } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!tenancy) redirect(`/r/${token}`);

  return (
    <TenantShell workspaceName={unit.workspace_name} address={unitLabel(unit)}>
      <div className="h-[calc(100vh-80px)] sm:h-[calc(100vh-136px)]">
        <TriageChat
          tenancyId={tenancy.id}
          afterComplete={<KeepAccountCard isGuest={!!user.is_anonymous} reportAgainHref={`/r/${token}/chat?t=${tenancy.id}`} />}
        />
      </div>
    </TenantShell>
  );
}
