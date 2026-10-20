"use client";

import { useActionState, useState } from "react";
import { sendToVendor, type TicketFormState } from "@/lib/actions/tickets";

const initial: TicketFormState = { error: null, ok: null };
const field =
  "mt-1.5 block w-full border border-line bg-paper px-3 py-2.5 text-sm text-ink focus:border-pine focus:outline-none focus:ring-1 focus:ring-pine";

export function SendToVendorForm({
  ticketId,
  vendors,
  defaultScope,
  defaultPets,
}: {
  ticketId: string;
  vendors: { id: string; name: string; email: string | null }[];
  defaultScope: string;
  defaultPets: string;
}) {
  const [state, action, pending] = useActionState(sendToVendor, initial);
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Vendor
          <select name="vendor_id" defaultValue={vendors[0]?.id ?? ""} className={field}>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.email ? "" : " (no email: share by WhatsApp/WeChat)"}
              </option>
            ))}
            <option value="">Someone else…</option>
          </select>
        </label>
        <label className="text-sm font-medium">
          Or name
          <input name="vendor_name" maxLength={200} className={field} placeholder="Only if not in the list" />
        </label>
      </div>
      <label className="block text-sm font-medium">
        Scope (what the vendor sees)
        <textarea name="scope" rows={4} required maxLength={4000} defaultValue={defaultScope} className={field} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Access window
          <input name="access_window" maxLength={300} className={field} placeholder="Weekdays 9 a.m. to 5 p.m." />
        </label>
        <label className="text-sm font-medium">
          Pets
          <input name="pets" maxLength={300} defaultValue={defaultPets} className={field} />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="mb-1 font-medium">Entry if no one is home</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="entry_permission" value="yes" className="accent-pine" /> Permitted
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="entry_permission" value="no" className="accent-pine" /> Tenant must be home
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="entry_permission" value="" defaultChecked className="accent-pine" /> Not asked yet
        </label>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="include_tenant_phone" className="accent-pine" />
        Show the tenant&apos;s phone number to the vendor
      </label>
      <p className="text-xs text-muted">The vendor never sees rent, the owner, or other tenants.</p>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="bg-pine px-5 py-3 text-sm text-white hover:bg-ink disabled:opacity-60">
          {pending ? "Sending…" : "Send work order"}
        </button>
        {state.error && (
          <p role="alert" className="text-sm text-brick">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-sm text-pine">
            {state.ok}
          </p>
        )}
      </div>
    </form>
  );
}

/** "Send via WhatsApp" (wa.me, prefilled) and "Copy for WeChat". */
export function ShareButtons({ text, whatsappHref }: { text: string; whatsappHref: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={whatsappHref}
        target="_blank"
        rel="noopener noreferrer"
        className="min-h-9 border border-line bg-white px-3 py-1.5 text-[13px] hover:border-pine"
      >
        Send via WhatsApp
      </a>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="min-h-9 border border-line bg-white px-3 py-1.5 text-[13px] hover:border-pine"
      >
        {copied ? "Copied" : "Copy for WeChat"}
      </button>
    </div>
  );
}
