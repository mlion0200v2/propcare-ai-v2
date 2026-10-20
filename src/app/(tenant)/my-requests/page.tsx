import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/workspace/server";
import { STAGE_LABELS } from "@/lib/utils/constants";

export const metadata = {
  title: "Your requests | PropCare",
};

export const dynamic = "force-dynamic";

export default async function MyRequestsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?tenant=1");
  const supabase = await createClient();

  // RLS: the tenant's own tickets, plus every ticket of a tenancy they hold.
  const [{ data: tickets }, { data: tenancies }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, title, stage, created_at, units(unit_number, properties(address_line1))")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("tenancies")
      .select("id, units(unit_number, intake_token, link_active, properties(address_line1))")
      .is("ended_at", null),
  ]);

  return (
    <div className="space-y-8 px-4 py-8">
      <div>
        <h1 className="font-display text-3xl">Your requests</h1>
        {user.is_anonymous && (
          <p className="mt-2 text-sm text-muted">
            You&apos;re using a guest session on this device. Keep an account after your next request to see these anywhere.
          </p>
        )}
      </div>

      {(tenancies ?? []).some((t) => t.units?.link_active) && (
        <div className="flex flex-wrap gap-3">
          {(tenancies ?? [])
            .filter((t) => t.units?.link_active)
            .map((t) => (
              <a
                key={t.id}
                href={`/r/${t.units!.intake_token}/chat?t=${t.id}`}
                className="bg-pine px-5 py-3 text-sm text-white hover:bg-ink"
              >
                Report a problem
                {t.units?.properties?.address_line1 ? ` at ${t.units.properties.address_line1}` : ""}
                {t.units?.unit_number ? `, Unit ${t.units.unit_number}` : ""}
              </a>
            ))}
        </div>
      )}

      {!tickets || tickets.length === 0 ? (
        <p className="text-[15px] text-muted">
          No requests yet. To report a problem, open the link or QR code your landlord gave you.
        </p>
      ) : (
        <ul className="divide-y divide-line border border-line bg-white">
          {tickets.map((t) => (
            <li key={t.id}>
              <Link href={`/my-requests/${t.id}`} className="flex flex-wrap justify-between gap-3 px-5 py-4 hover:bg-paper">
                <span>
                  <span className="block text-[15px]">{t.title}</span>
                  <span className="text-sm text-muted">
                    {t.units?.properties?.address_line1}
                    {t.units?.unit_number ? `, Unit ${t.units.unit_number}` : ""} ·{" "}
                    {new Date(t.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                  </span>
                </span>
                <span className="text-sm font-semibold text-brass">{STAGE_LABELS[t.stage]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
