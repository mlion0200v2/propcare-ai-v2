import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireMembership } from "@/lib/workspace/server";
import { STAGE_LABELS } from "@/lib/utils/constants";
import { appTimeZone } from "@/lib/utils/time";

export const metadata = {
  title: "Requests | PropCare",
};

const OPEN_STAGES = ["new", "waiting_for_owner", "vendor_booked"] as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const membership = await requireMembership();
  const { show } = await searchParams;
  const showDone = show === "done";
  const supabase = await createClient();

  // RLS limits this to the caller's workspace (owners: their properties only).
  let query = supabase
    .from("tickets")
    .select(`
      id,
      title,
      priority,
      stage,
      triage_state,
      created_at,
      vendor_name,
      units(unit_number, properties(address_line1)),
      tenancies(name)
    `)
    .eq("workspace_id", membership.workspaceId)
    .order("created_at", { ascending: false })
    .limit(100);
  query = showDone ? query.in("stage", ["fixed", "closed"]) : query.in("stage", [...OPEN_STAGES]);
  const { data: tickets } = await query;
  const tz = appTimeZone();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-[34px] leading-tight">Requests</h1>
        <nav aria-label="Filter requests" className="flex gap-1 text-sm">
          <Link
            href="/dashboard"
            aria-current={!showDone ? "page" : undefined}
            className={`px-3 py-2 ${!showDone ? "bg-sage font-semibold text-pine" : "text-muted"}`}
          >
            Open
          </Link>
          <Link
            href="/dashboard?show=done"
            aria-current={showDone ? "page" : undefined}
            className={`px-3 py-2 ${showDone ? "bg-sage font-semibold text-pine" : "text-muted"}`}
          >
            Fixed and closed
          </Link>
        </nav>
      </div>

      {!tickets || tickets.length === 0 ? (
        <div className="border border-line bg-white px-6 py-10 text-center text-[15px] text-muted">
          {showDone
            ? "Nothing fixed or closed yet."
            : membership.role === "owner"
              ? "No open requests for your homes."
              : "No open requests. They arrive here when tenants use a unit's link."}
        </div>
      ) : (
        <ul className="divide-y divide-line border border-line bg-white">
          {tickets.map((t) => {
            const emergency = t.triage_state === "EMERGENCY" || t.priority === "emergency";
            return (
              <li key={t.id}>
                <Link href={`/tickets/${t.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-paper">
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium">{t.title}</span>
                    <span className="text-sm text-muted">
                      {t.units?.properties?.address_line1 ?? "No unit"}
                      {t.units?.unit_number ? `, Unit ${t.units.unit_number}` : ""}
                      {t.tenancies?.name ? ` · ${t.tenancies.name}` : ""} ·{" "}
                      {new Date(t.created_at).toLocaleDateString("en-CA", { timeZone: tz, month: "short", day: "numeric" })}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                    {emergency && <span className="bg-brick px-2 py-1 text-white">Emergency: contact tenant now</span>}
                    {!emergency && t.triage_state !== "DONE" && <span className="bg-cream px-2 py-1 text-brass">Chat in progress</span>}
                    <span className={t.stage === "waiting_for_owner" ? "text-brass" : "text-pine"}>{STAGE_LABELS[t.stage]}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
