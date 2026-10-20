import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { formatCents } from "@/lib/workspace/tokens";
import { formatDateTime } from "@/lib/utils/time";
import { VendorQuoteForm } from "@/components/demo/vendor-quote-form";

export const metadata = {
  title: "Work order | PropCare",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * A vendor's work order (no account). Shows only what the job needs: the
 * address, the scope, access, pets, photos, and the tenant's phone only if
 * the manager allowed it. Never rent, owner or other tenants' details.
 */
export default async function VendorWorkOrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9]{32,128}$/.test(token)) notFound();

  const service = createServiceClient();
  const { data: order } = await service
    .from("work_orders")
    .select(
      "id, vendor_name, scope, access_window, entry_permission, pets, include_tenant_phone, status, quote_cents, quote_note, quoted_at, created_at, ticket_id, workspaces(name), tickets(title, vendor_booked_for, units(unit_number, properties(address_line1, city)), tenancies(name, phone))"
    )
    .eq("token", token)
    .maybeSingle();
  if (!order || order.status === "cancelled" || !order.tickets) notFound();

  const ticket = order.tickets;
  const { data: media } = await service
    .from("ticket_media")
    .select("id, file_path, file_type, mime_type")
    .eq("ticket_id", order.ticket_id)
    .order("created_at");
  const photos = (
    await Promise.all(
      (media ?? []).map(async (m) => ({
        ...m,
        url: (await service.storage.from("ticket-media").createSignedUrl(m.file_path, 3600)).data?.signedUrl ?? "",
      }))
    )
  ).filter((m) => m.url);

  const address = `${ticket.units?.properties?.address_line1 ?? ""}${ticket.units?.unit_number ? `, Unit ${ticket.units.unit_number}` : ""}${
    ticket.units?.properties?.city ? `, ${ticket.units.properties.city}` : ""
  }`;
  const firstName = ticket.tenancies?.name?.split(" ")[0];

  return (
    <div className="min-h-screen bg-paper px-4 py-8 font-brand text-ink">
      <div className="mx-auto max-w-2xl space-y-5">
        <div>
          <p className="text-xs uppercase tracking-[1.5px] text-brass">Work order from {order.workspaces?.name}</p>
          <h1 className="mt-2 font-display text-3xl">{ticket.title}</h1>
          <p className="mt-1 text-[15px]">{address}</p>
          <p className="mt-1 text-sm text-muted">For {order.vendor_name} · sent {formatDateTime(order.created_at)}</p>
        </div>

        <section className="border border-line bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Scope</h2>
          <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed">{order.scope}</p>
        </section>

        <section className="border border-line bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Access</h2>
          <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">When</dt>
            <dd>{order.access_window ?? "Arrange with the manager"}</dd>
            {ticket.vendor_booked_for && (
              <>
                <dt className="text-muted">Booked</dt>
                <dd>{formatDateTime(ticket.vendor_booked_for)}</dd>
              </>
            )}
            <dt className="text-muted">Entry if no one is home</dt>
            <dd>{order.entry_permission === true ? "Yes, permitted" : order.entry_permission === false ? "No, tenant must be home" : "Ask the manager"}</dd>
            <dt className="text-muted">Pets</dt>
            <dd>{order.pets ?? "None noted"}</dd>
            <dt className="text-muted">Tenant</dt>
            <dd>
              {order.include_tenant_phone && ticket.tenancies?.phone
                ? `${firstName ?? "Tenant"} · ${ticket.tenancies.phone}`
                : "Contact through the manager"}
            </dd>
          </dl>
        </section>

        {photos.length > 0 && (
          <section className="border border-line bg-white p-5">
            <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Photos from the tenant</h2>
            <div className="mt-3 flex flex-wrap gap-2.5">
              {photos.map((p) =>
                p.file_type === "photo" ? (
                  <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt="Photo of the problem" className="h-24 w-32 object-cover" />
                  </a>
                ) : (
                  <video key={p.id} controls preload="metadata" className="h-24 w-40">
                    <source src={p.url} type={p.mime_type} />
                  </video>
                )
              )}
            </div>
          </section>
        )}

        <section className="border border-gold bg-cream p-5">
          <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-brass">Your quote</h2>
          {order.quote_cents ? (
            <p className="mt-2 text-[15px]">
              {formatCents(order.quote_cents)}
              {order.quote_note ? ` · ${order.quote_note}` : ""}
              {order.quoted_at ? <span className="text-sm text-muted"> · sent {formatDateTime(order.quoted_at)}</span> : null}
            </p>
          ) : (
            <div className="mt-3">
              <VendorQuoteForm token={token} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
