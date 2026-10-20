"use client";

import { useActionState } from "react";
import { submitVendorQuote, type QuoteState } from "@/lib/actions/vendor";

const initial: QuoteState = { error: null, ok: null };

export function VendorQuoteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(submitVendorQuote, initial);
  if (state.ok) {
    return (
      <p role="status" className="text-sm text-pine">
        {state.ok}
      </p>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <label className="text-sm font-medium">
          Quote (CAD, before tax)
          <input name="amount" inputMode="decimal" required className="mt-1.5 block w-full border border-line bg-white px-3 py-2.5 text-sm" placeholder="340" />
        </label>
        <label className="text-sm font-medium">
          What it covers
          <input name="note" maxLength={2000} className="mt-1.5 block w-full border border-line bg-white px-3 py-2.5 text-sm" placeholder="Camera inspection; clear roots if present" />
        </label>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-brick">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="bg-pine px-5 py-3 text-sm text-white hover:bg-ink disabled:opacity-60">
        {pending ? "Sending…" : "Send quote"}
      </button>
    </form>
  );
}
