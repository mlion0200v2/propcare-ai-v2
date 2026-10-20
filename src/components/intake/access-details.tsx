"use client";

import { useActionState } from "react";
import { saveAccessDetails, type AccessState } from "@/lib/actions/access";

const initial: AccessState = { error: null, ok: null };
const WINDOWS = ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends", "Any time"];

/** After the summary is confirmed: entry permission, availability, pets. */
export function AccessDetailsCard({ ticketId, defaultPets }: { ticketId: string; defaultPets?: string }) {
  const [state, action, pending] = useActionState(saveAccessDetails, initial);
  if (state.ok) {
    return (
      <p role="status" className="border border-line bg-sage px-4 py-3 text-sm text-pine">
        {state.ok}
      </p>
    );
  }
  return (
    <form action={action} className="space-y-4 border border-line bg-white p-5 text-sm">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <p className="text-base font-semibold text-ink">For the repair visit</p>
      <fieldset>
        <legend className="font-medium">If nobody is home, may the repair person go in?</legend>
        <p className="text-xs text-muted">Your landlord still gives you written notice before entry.</p>
        <div className="mt-2 flex gap-4">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="entry_permission" value="yes" required className="accent-pine" /> Yes
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="entry_permission" value="no" className="accent-pine" /> No, I&apos;ll be home
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="font-medium">When are you usually available?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {WINDOWS.map((w) => (
            <label key={w} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 has-[:checked]:border-pine has-[:checked]:bg-sage">
              <input type="checkbox" name="availability" value={w} className="accent-pine" /> {w}
            </label>
          ))}
        </div>
        <input
          name="availability_note"
          maxLength={200}
          placeholder="Anything else? e.g. not Tuesdays"
          className="mt-2 block w-full border border-line bg-paper px-3 py-2"
        />
      </fieldset>
      <label className="block font-medium">
        Pets at home
        <input name="pets" maxLength={300} defaultValue={defaultPets} placeholder="e.g. one cat, stays in the bedroom" className="mt-1.5 block w-full border border-line bg-paper px-3 py-2 font-normal" />
      </label>
      {state.error && (
        <p role="alert" className="text-brick">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="w-full bg-pine p-3 text-[15px] text-white hover:bg-ink disabled:opacity-60">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
