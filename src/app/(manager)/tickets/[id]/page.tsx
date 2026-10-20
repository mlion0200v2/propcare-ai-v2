import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isTeamRole, requireMembership } from "@/lib/workspace/server";
import { decideApproval } from "@/lib/actions/tickets";
import { formatCents } from "@/lib/workspace/tokens";
import { appUrl } from "@/lib/app-url";
import { buildVendorWorkOrderMessage, whatsappLink } from "@/lib/messages";
import { SendToVendorForm, ShareButtons } from "@/components/tickets/dispatch";
import { appTimeZone, formatDateTime, utcToZonedLocal } from "@/lib/utils/time";
import {
  ApprovalRequestForm,
  CommentComposer,
  StageSelect,
  VendorForm,
} from "@/components/tickets/ticket-forms";
import type { GatheredInfo, TenantInfo } from "@/lib/triage/types";

export const metadata = {
  title: "Request | PropCare",
};

const VISIBILITY_LABEL: Record<string, string> = {
  team: "Team only",
  team_owner: "Team and owner",
  tenant: "To tenant",
};

const ROLE_LABEL: Record<string, string> = {
  admin: "manager",
  manager: "manager",
  owner: "owner",
  tenant: "tenant",
};

const PRIORITY_LABEL: Record<string, string> = {
  emergency: "Emergency",
  high: "High priority",
  medium: "Normal priority",
  low: "Low priority",
};

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const membership = await requireMembership();
  const team = isTeamRole(membership.role);
  const supabase = await createClient();

  // Loaded with the user's session: RLS returns the ticket only to its
  // workspace team or the owner of its property. That check gates the
  // service-role media lookup below.
  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("*, units(id, unit_number, property_id, profile, properties(address_line1)), tenancies(name, email, phone)")
    .eq("id", id)
    .single();

  if (error || !ticket) notFound();

  const [
    { data: comments },
    { data: approvals },
    { data: messages },
    { data: owners },
    { data: outbox },
    { data: workOrders },
    { data: vendors },
  ] = await Promise.all([
    // RLS filters comments by visibility (owners never get "team only").
    supabase
      .from("ticket_comments")
      .select("id, author_name, author_role, visibility, body, created_at, delivered_at, delivery_error")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("approvals")
      .select("id, amount_cents, limit_cents, description, decision, decided_at, decided_by, decision_note, created_at")
      .eq("ticket_id", id)
      .order("created_at", { ascending: false }),
    // Owners get nothing here (chat is between tenant and team).
    supabase
      .from("messages")
      .select("id, body, is_bot_reply, created_at")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true }),
    ticket.units?.property_id
      ? supabase.from("owner_property_access").select("user_id").eq("property_id", ticket.units.property_id)
      : Promise.resolve({ data: [] as { user_id: string }[] }),
    // Team only (RLS): messages the app sent, or in a demo would have sent.
    supabase
      .from("outbox")
      .select("id, channel, recipient_label, subject, body, demo, created_at")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("work_orders")
      .select("id, vendor_name, token, status, quote_cents, quote_note, created_at")
      .eq("ticket_id", id)
      .order("created_at", { ascending: false }),
    supabase.from("vendors").select("id, name, email").eq("workspace_id", membership.workspaceId).order("name"),
  ]);

  type ActivityItem =
    | { kind: "comment"; at: string; c: NonNullable<typeof comments>[number] }
    | { kind: "outbox"; at: string; o: NonNullable<typeof outbox>[number] };
  const activity: ActivityItem[] = [
    ...(comments ?? []).map((c) => ({ kind: "comment" as const, at: c.created_at, c })),
    ...(outbox ?? []).map((o) => ({ kind: "outbox" as const, at: o.created_at, o })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const unitProfile = (ticket.units?.profile ?? {}) as { pets?: string };

  const ownerIds = (owners ?? []).map((o) => o.user_id);
  const { data: ownerMembers } = ownerIds.length
    ? await supabase
        .from("memberships")
        .select("user_id, display_name")
        .eq("workspace_id", membership.workspaceId)
        .in("user_id", ownerIds)
    : { data: [] as { user_id: string; display_name: string | null }[] };
  const ownerNames = (ownerMembers ?? []).map((m) => m.display_name ?? "Owner");
  const deciderName = (userId: string | null) =>
    (ownerMembers ?? []).find((m) => m.user_id === userId)?.display_name ?? (userId ? "an admin" : "");

  // Media: service client bypasses storage RLS (folder = tenant uid); only
  // reached after the RLS ticket read above succeeded.
  const serviceClient = createServiceClient();
  const { data: mediaRecords } = await serviceClient
    .from("ticket_media")
    .select("id, file_path, file_type, mime_type, created_at")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });
  const media = (
    await Promise.all(
      (mediaRecords ?? []).map(async (m) => {
        const { data } = await serviceClient.storage.from("ticket-media").createSignedUrl(m.file_path, 3600);
        return { ...m, signed_url: data?.signedUrl ?? "" };
      })
    )
  ).filter((m) => m.signed_url);

  const classification = ticket.classification as {
    gathered?: GatheredInfo;
    tenant_info?: TenantInfo;
    summary?: string;
    emergency?: { kind?: string; manager_notified?: boolean };
  } | null;
  const gathered = classification?.gathered;
  const tenantInfo = classification?.tenant_info;
  const tz = appTimeZone();
  const address = ticket.units?.properties?.address_line1 ?? tenantInfo?.reported_address ?? "No unit on file";
  const unitLabel = ticket.units?.unit_number ? `, Unit ${ticket.units.unit_number}` : "";
  const tenantName = ticket.tenancies?.name;
  const pendingApproval = (approvals ?? []).find((a) => a.decision === "pending");
  const canDecide = membership.role === "owner" || membership.role === "admin";
  const company = membership.kind === "company";

  return (
    <div>
      <p className="text-[13px] text-muted">
        <Link href="/dashboard" className="underline">
          Requests
        </Link>{" "}
        / {ticket.title.slice(0, 40)}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[32px] leading-tight">{ticket.title}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {address}
            {unitLabel}
            {tenantName ? ` · ${tenantName}` : ""} · reported {formatDateTime(ticket.created_at, tz)}
            {ownerNames.length > 0 ? ` · owner: ${ownerNames.join(", ")}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StageSelect ticketId={ticket.id} stage={ticket.stage} editable={team} />
          <span
            className={`px-2.5 py-1.5 text-xs font-semibold ${
              ticket.priority === "emergency" ? "bg-brick text-white" : "bg-sage text-pine"
            }`}
          >
            {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
          </span>
        </div>
      </div>

      {ticket.triage_state === "EMERGENCY" && (
        <p role="alert" className="mt-5 bg-brick px-4 py-3 text-sm text-white">
          Possible emergency{classification?.emergency?.kind ? ` (${classification.emergency.kind.replace(/_/g, " ")})` : ""}: the
          tenant was told to leave if unsafe. Contact them now.
        </p>
      )}

      <div className="mt-7 grid gap-7 xl:grid-cols-[5fr_6fr]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="border border-line bg-white p-5 sm:p-6">
            <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">From the chat</h2>
            <dl className="mt-3.5 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3.5 gap-y-2.5 text-sm leading-normal">
              <dt className="text-muted">Problem</dt>
              <dd>{ticket.description}</dd>
              {gathered?.location_in_unit && (
                <>
                  <dt className="text-muted">Where</dt>
                  <dd>{gathered.location_in_unit}</dd>
                </>
              )}
              {gathered?.started_when && (
                <>
                  <dt className="text-muted">Started</dt>
                  <dd>{gathered.started_when}</dd>
                </>
              )}
              <dt className="text-muted">Likely trade</dt>
              <dd className="capitalize">{(gathered?.category ?? ticket.category).replace(/_/g, " ")}</dd>
              <dt className="text-muted">Safety</dt>
              <dd>{gathered?.is_emergency ? "Possible emergency reported" : "No hazards reported"}</dd>
              {tenantInfo && team && (
                <>
                  <dt className="text-muted">Reported contact</dt>
                  <dd>{[tenantInfo.contact_phone, tenantInfo.contact_email].filter(Boolean).join(" · ") || "—"}</dd>
                </>
              )}
              {team && ticket.tenancies && (
                <>
                  <dt className="text-muted">Tenant</dt>
                  <dd>{[ticket.tenancies.name, ticket.tenancies.phone, ticket.tenancies.email].filter(Boolean).join(" · ")}</dd>
                </>
              )}
            </dl>
            {classification?.summary && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-pine underline">Summary for the property manager</summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-muted">{classification.summary}</pre>
              </details>
            )}
            {media.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2.5">
                {media.map((m) =>
                  m.file_type === "photo" ? (
                    <a key={m.id} href={m.signed_url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.signed_url} alt="Photo from the tenant" className="h-[72px] w-24 object-cover" />
                    </a>
                  ) : (
                    <video key={m.id} controls preload="metadata" className="h-[72px] w-32">
                      <source src={m.signed_url} type={m.mime_type} />
                    </video>
                  )
                )}
              </div>
            )}
            {team && messages && messages.length > 0 && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-pine underline">Read the whole conversation</summary>
                <ol className="mt-3 space-y-2">
                  {messages.map((msg) => (
                    <li key={msg.id} className={`p-2.5 ${msg.is_bot_reply ? "bg-paper" : "bg-sage"}`}>
                      <p className="text-xs text-muted">
                        {msg.is_bot_reply ? "PropCare" : tenantName ?? "Tenant"} · {formatDateTime(msg.created_at, tz)}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap">{msg.body}</p>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>

          <section className="border border-line bg-white p-5 sm:p-6">
            <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Vendor</h2>
            {ticket.vendor_name || ticket.vendor_booked_for ? (
              <p className="mt-3 text-[15px]">
                {ticket.vendor_name ?? "Vendor"}
                {ticket.vendor_booked_for ? ` · ${formatDateTime(ticket.vendor_booked_for, tz)}` : ""}
              </p>
            ) : (
              <p className="mt-3 text-sm text-muted">No vendor booked yet.</p>
            )}
            {ticket.entry_notice && <p className="mt-1.5 text-sm text-muted">{ticket.entry_notice}</p>}
            {team && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-pine underline">
                  {ticket.vendor_name ? "Change vendor or time" : "Book a vendor"}
                </summary>
                <VendorForm
                  ticketId={ticket.id}
                  vendorName={ticket.vendor_name ?? ""}
                  bookedForLocal={ticket.vendor_booked_for ? utcToZonedLocal(ticket.vendor_booked_for, tz) : ""}
                  entryNotice={ticket.entry_notice ?? ""}
                />
              </details>
            )}
          </section>

          {team && (
            <section className="border border-line bg-white p-5 sm:p-6">
              <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Send to vendor</h2>
              {(workOrders ?? []).length > 0 && (
                <ul className="mt-3 space-y-3">
                  {(workOrders ?? []).map((w) => {
                    const share = buildVendorWorkOrderMessage({
                      workspaceName: membership.workspaceName,
                      vendorName: w.vendor_name,
                      title: ticket.title,
                      address: `${address}${unitLabel}`,
                      link: appUrl(`/v/${w.token}`),
                    }).text;
                    return (
                      <li key={w.id} className="space-y-2 border-b border-line pb-3 last:border-b-0">
                        <p className="text-[15px]">
                          {w.vendor_name}{" "}
                          <span className="text-sm text-muted">
                            ·{" "}
                            {w.status === "quoted" && w.quote_cents
                              ? `quoted ${formatCents(w.quote_cents)}${w.quote_note ? ` (${w.quote_note})` : ""}`
                              : w.status === "cancelled"
                                ? "cancelled"
                                : "waiting for a quote"}
                          </span>
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <a href={`/v/${w.token}`} target="_blank" rel="noopener" className="text-[13px] text-pine underline">
                            Open the vendor&apos;s view
                          </a>
                          <ShareButtons text={share} whatsappHref={whatsappLink(share)} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <details className="mt-3" open={(workOrders ?? []).length === 0}>
                <summary className="cursor-pointer text-sm text-pine underline">New work order</summary>
                <SendToVendorForm
                  ticketId={ticket.id}
                  vendors={vendors ?? []}
                  defaultScope={(classification?.summary ?? ticket.description).slice(0, 4000)}
                  defaultPets={unitProfile.pets ?? ""}
                />
              </details>
            </section>
          )}

          {(company || (approvals ?? []).length > 0) && (
            <section className="border border-gold bg-cream p-5 sm:p-6">
              <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-brass">Owner approval</h2>
              {(approvals ?? []).length === 0 && <p className="mt-3 text-sm text-muted">No quotes need approval.</p>}
              <ul className="mt-1 space-y-3">
                {(approvals ?? []).map((a) => (
                  <li key={a.id} className="pt-2">
                    <p className="text-[15px]">
                      Quote {formatCents(a.amount_cents)}
                      {a.amount_cents > a.limit_cents ? `, over the ${formatCents(a.limit_cents)} limit` : ""}
                    </p>
                    {a.description && <p className="mt-1 text-sm text-muted">{a.description}</p>}
                    <p className="mt-1.5 text-sm text-muted">
                      {a.decision === "pending"
                        ? "Waiting for the owner"
                        : `${a.decision === "approved" ? "Approved" : "Declined"} by ${deciderName(a.decided_by)}${
                            a.decided_at ? `, ${formatDateTime(a.decided_at, tz)}` : ""
                          }`}
                      {a.decision_note ? ` · “${a.decision_note}”` : ""}
                    </p>
                    {a.decision === "pending" && canDecide && (
                      <form action={decideApproval} className="mt-3 flex flex-wrap items-end gap-2.5">
                        <input type="hidden" name="approval_id" value={a.id} />
                        <input type="hidden" name="ticket_id" value={ticket.id} />
                        <label className="text-sm">
                          <span className="sr-only">Note</span>
                          <input name="note" maxLength={1000} placeholder="Note (optional)" className="border border-line bg-white px-3 py-2.5 text-sm" />
                        </label>
                        <button type="submit" name="decision" value="approved" className="bg-pine px-4 py-2.5 text-sm text-white">
                          Approve
                        </button>
                        <button type="submit" name="decision" value="declined" className="border border-brick px-4 py-2.5 text-sm text-brick">
                          Decline
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              {team && company && !pendingApproval && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-pine underline">Ask the owner to approve a quote</summary>
                  <ApprovalRequestForm ticketId={ticket.id} limitLabel={formatCents(membership.approvalLimitCents)} />
                </details>
              )}
            </section>
          )}
        </div>

        <section className="flex min-w-0 flex-col border border-line bg-white p-5 sm:p-6">
          <h2 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Activity</h2>
          <ol className="mt-4 flex flex-col gap-3.5 text-sm leading-normal">
            <li className="flex gap-3">
              <span aria-hidden="true" className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-pine text-xs text-white">
                AI
              </span>
              <div>
                <b>PropCare</b> <span className="text-muted">· {formatDateTime(ticket.created_at, tz)}</span>
                <br />
                Created the request from {tenantName ? `${tenantName}'s` : "the tenant's"} chat.
              </div>
            </li>
            {activity.map((item) =>
              item.kind === "outbox" ? (
                <li key={item.o.id} className="flex gap-3">
                  <span aria-hidden="true" className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-cream text-[10px] text-brass">
                    {item.o.channel === "email" ? "@" : item.o.channel === "whatsapp" ? "WA" : "Msg"}
                  </span>
                  <div className="min-w-0 flex-1 border border-dashed border-gold bg-cream p-2.5">
                    <b>{item.o.demo ? "Sent (demo, not delivered)" : "Sent"}</b>{" "}
                    <span className="text-xs text-muted">
                      · {item.o.channel} to {item.o.recipient_label} · {formatDateTime(item.o.created_at, tz)}
                    </span>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[13px] text-pine underline">
                        {item.o.subject ?? "Show the exact message"}
                      </summary>
                      <pre className="mt-1.5 whitespace-pre-wrap break-words font-sans text-[13px] text-ink">{item.o.body}</pre>
                    </details>
                  </div>
                </li>
              ) : (
                <CommentItem key={item.c.id} c={item.c} tz={tz} team={team} />
              )
            )}
          </ol>
          <div className="mt-auto pt-5">
            <CommentComposer
              ticketId={ticket.id}
              allowed={team ? (company ? ["team", "team_owner", "tenant"] : ["team", "tenant"]) : ["team_owner"]}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function CommentItem({
  c,
  tz,
  team,
}: {
  c: {
    id: string;
    author_name: string;
    author_role: string;
    visibility: string;
    body: string;
    created_at: string;
    delivered_at: string | null;
    delivery_error: string | null;
  };
  tz: string;
  team: boolean;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs ${
          c.author_role === "system"
            ? "bg-pine text-white"
            : c.author_role === "owner"
              ? "bg-brass text-white"
              : c.author_role === "tenant"
                ? "bg-line text-ink"
                : "bg-gold text-ink"
        }`}
      >
        {c.author_role === "system" ? "AI" : initials(c.author_name)}
      </span>
      <div className={`min-w-0 flex-1 p-2.5 ${c.visibility === "tenant" ? "bg-sage" : "bg-paper"}`}>
        <b>
          {c.author_name}
          {c.author_role !== "system" ? ` (${ROLE_LABEL[c.author_role] ?? c.author_role})` : ""}
        </b>{" "}
        <span className="text-[11px] font-semibold uppercase tracking-[1px] text-muted">
          {c.visibility === "tenant" && c.author_role !== "tenant"
            ? c.delivered_at
              ? "Sent to tenant by email"
              : c.delivery_error === "demo"
                ? "To tenant · sent (demo, not delivered)"
                : c.delivery_error
                  ? "To tenant · not emailed"
                : "To tenant"
            : VISIBILITY_LABEL[c.visibility]}
        </span>
        <span className="text-xs text-muted"> · {formatDateTime(c.created_at, tz)}</span>
        <p className="mt-1 whitespace-pre-wrap break-words">{c.body}</p>
        {c.delivery_error && c.delivery_error !== "demo" && team && (
          <p className="mt-1 text-xs text-brick">{c.delivery_error}</p>
        )}
      </div>
    </li>
  );
}
