import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/workspace/server";
import { STAGE_LABELS } from "@/lib/utils/constants";
import { formatDateTime } from "@/lib/utils/time";
import { TenantReplyForm } from "@/components/tickets/ticket-forms";

export const metadata = {
  title: "Your request | PropCare",
};

export const dynamic = "force-dynamic";

export default async function MyRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?tenant=1");
  const { id } = await params;
  const supabase = await createClient();

  // RLS: only the tenant's own (or their tenancy's) tickets.
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, title, stage, created_at, vendor_name, vendor_booked_for, units(unit_number, properties(address_line1))")
    .eq("id", id)
    .maybeSingle();
  if (!ticket) notFound();

  // RLS: tenants only ever receive "to tenant" comments.
  const { data: comments } = await supabase
    .from("ticket_comments")
    .select("id, author_name, author_role, body, created_at")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });

  return (
    <div className="space-y-6 px-4 py-8">
      <p className="text-[13px] text-muted">
        <Link href="/my-requests" className="underline">
          Your requests
        </Link>
      </p>
      <div>
        <p className="inline-block bg-sage px-2.5 py-1 text-xs font-semibold text-pine">{STAGE_LABELS[ticket.stage]}</p>
        <h1 className="mt-3 font-display text-3xl">{ticket.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {ticket.units?.properties?.address_line1}
          {ticket.units?.unit_number ? `, Unit ${ticket.units.unit_number}` : ""} · reported{" "}
          {new Date(ticket.created_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}
        </p>
      </div>
      {ticket.vendor_name && (
        <section className="border border-line bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Repair visit</h2>
          <p className="mt-2 text-[15px]">
            {ticket.vendor_name}
            {ticket.vendor_booked_for
              ? ` · ${new Date(ticket.vendor_booked_for).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`
              : ""}
          </p>
        </section>
      )}
      <section className="border border-line bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Messages</h2>
        {!comments || comments.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No replies yet. Your landlord usually replies within one business day.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {comments.map((c) => (
              <li key={c.id} className={`p-3 text-sm ${c.author_role === "tenant" ? "bg-paper" : "bg-sage"}`}>
                <p className="text-xs text-muted">
                  {c.author_role === "tenant" ? "You" : c.author_name} · {formatDateTime(c.created_at)}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-5">
          <TenantReplyForm ticketId={ticket.id} />
        </div>
      </section>
    </div>
  );
}
