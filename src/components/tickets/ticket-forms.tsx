"use client";

import { useActionState, useState } from "react";
import {
  addTenantReply,
  addTicketComment,
  requestOwnerApproval,
  updateTicketStage,
  updateTicketVendor,
  type TicketFormState,
} from "@/lib/actions/tickets";
import { STAGE_LABELS, TICKET_STAGES } from "@/lib/utils/constants";

const initial: TicketFormState = { error: null, ok: null };
const field =
  "mt-1.5 block w-full border border-line bg-paper px-3 py-2.5 text-sm text-ink focus:border-pine focus:outline-none focus:ring-1 focus:ring-pine";
const primary = "bg-pine px-5 py-3 text-sm text-white hover:bg-ink disabled:opacity-60";

function Status({ state }: { state: TicketFormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-brick">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-pine">
        {state.ok}
      </p>
    );
  return null;
}

export function StageSelect({ ticketId, stage, editable }: { ticketId: string; stage: string; editable: boolean }) {
  return (
    <form action={updateTicketStage} className="flex items-center gap-2">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <label className="text-[13px] text-muted">
        Status{" "}
        <select
          name="stage"
          defaultValue={stage}
          disabled={!editable}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="ml-1.5 h-11 border border-line bg-white px-3 text-sm text-ink disabled:opacity-80"
        >
          {TICKET_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit">Save</button>
      </noscript>
    </form>
  );
}

export function VendorForm({
  ticketId,
  vendorName,
  bookedForLocal,
  entryNotice,
}: {
  ticketId: string;
  vendorName: string;
  bookedForLocal: string;
  entryNotice: string;
}) {
  const [state, action, pending] = useActionState(updateTicketVendor, initial);
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Vendor
          <input name="vendor_name" defaultValue={vendorName} maxLength={200} className={field} placeholder="Westside Plumbing" />
        </label>
        <label className="text-sm font-medium">
          Booked for
          <input name="vendor_booked_for" type="datetime-local" defaultValue={bookedForLocal} className={field} />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Entry notice
        <input
          name="entry_notice"
          defaultValue={entryNotice}
          maxLength={1000}
          className={field}
          placeholder="Written notice sent Oct 19 (24 hours' notice)"
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Saving…" : "Save vendor"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function ApprovalRequestForm({ ticketId, limitLabel }: { ticketId: string; limitLabel: string }) {
  const [state, action, pending] = useActionState(requestOwnerApproval, initial);
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <p className="text-sm text-muted">Quotes over {limitLabel} need the owner&apos;s approval.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <label className="text-sm font-medium">
          Quote (CAD)
          <input name="amount" inputMode="decimal" required className={field} placeholder="340" />
        </label>
        <label className="text-sm font-medium">
          What it covers
          <input name="description" maxLength={1000} className={field} placeholder="Scope the drain line, not just snake it" />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Sending…" : "Ask the owner"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

const VISIBILITY_OPTIONS = [
  { value: "team", label: "Team only" },
  { value: "team_owner", label: "Team and owner" },
  { value: "tenant", label: "To tenant" },
] as const;

export function CommentComposer({
  ticketId,
  allowed,
}: {
  ticketId: string;
  allowed: readonly ("team" | "team_owner" | "tenant")[];
}) {
  const [state, action, pending] = useActionState(addTicketComment, initial);
  const [visibility, setVisibility] = useState(allowed[0]);
  return (
    <form action={action} className="space-y-2.5">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <input type="hidden" name="visibility" value={visibility} />
      <div role="group" aria-label="Who sees this comment" className="flex flex-wrap gap-2">
        {VISIBILITY_OPTIONS.filter((o) => allowed.includes(o.value)).map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={visibility === o.value}
            onClick={() => setVisibility(o.value)}
            className={`min-h-10 border px-3.5 py-2 text-[13px] ${
              visibility === o.value ? "border-pine bg-pine text-white" : "border-line bg-white text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="sr-only">Comment</span>
        <textarea
          name="body"
          rows={3}
          required
          maxLength={5000}
          placeholder={visibility === "tenant" ? "Write to the tenant (sent by email)" : "Write a note"}
          className="w-full resize-y border border-line bg-paper p-3 text-sm text-ink"
        />
      </label>
      <div className="flex items-center justify-end gap-3">
        <Status state={state} />
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Posting…" : visibility === "tenant" ? "Send to tenant" : "Post"}
        </button>
      </div>
    </form>
  );
}

export function TenantReplyForm({ ticketId }: { ticketId: string }) {
  const [state, action, pending] = useActionState(addTenantReply, initial);
  return (
    <form action={action} className="space-y-2.5">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <label className="block text-sm font-medium">
        Add a message
        <textarea name="body" rows={3} required maxLength={5000} className="mt-1.5 w-full border border-line bg-white p-3 text-sm" />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Sending…" : "Send"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}
