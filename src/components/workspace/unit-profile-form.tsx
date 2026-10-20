"use client";

import { useActionState } from "react";
import { saveUnitProfile, type FormState } from "@/lib/actions/workspace";

const initial: FormState = { error: null, ok: null };
const field =
  "mt-1.5 block w-full border border-line bg-paper px-3 py-2.5 text-sm text-ink focus:border-pine focus:outline-none focus:ring-1 focus:ring-pine";

export function UnitProfileForm({
  unitId,
  rooms,
  fixtures,
  waterShutoff,
  breakerPanel,
  accessNotes,
  pets,
}: {
  unitId: string;
  rooms: string;
  fixtures: string;
  waterShutoff: string;
  breakerPanel: string;
  accessNotes: string;
  pets: string;
}) {
  const [state, action, pending] = useActionState(saveUnitProfile, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="unit_id" value={unitId} />
      <div className="grid gap-4 lg:grid-cols-2">
        <label className="text-sm font-medium">
          Rooms <span className="font-normal text-muted">(one per line; tenants tap these)</span>
          <textarea name="rooms" rows={6} defaultValue={rooms} className={field} placeholder={"Main bathroom (hallway)\nEnsuite\nKitchen\nLaundry"} />
        </label>
        <label className="text-sm font-medium">
          Fixtures and appliances{" "}
          <span className="font-normal text-muted">(one per line: name | room | brand | model)</span>
          <textarea
            name="fixtures"
            rows={6}
            defaultValue={fixtures}
            className={`${field} font-mono text-[13px]`}
            placeholder={"Dishwasher | Kitchen | Bosch | SHE3AR75UC\nHot water tank | Laundry | GSW | JW540"}
          />
        </label>
        <label className="text-sm font-medium">
          Main water shut-off
          <input name="water_shutoff" maxLength={300} defaultValue={waterShutoff} className={field} placeholder="Laundry closet, blue lever behind the washer" />
        </label>
        <label className="text-sm font-medium">
          Breaker panel
          <input name="breaker_panel" maxLength={300} defaultValue={breakerPanel} className={field} placeholder="Hallway closet, above the coat rail" />
        </label>
        <label className="text-sm font-medium">
          Access notes <span className="font-normal text-muted">(shown to vendors)</span>
          <input name="access_notes" maxLength={500} defaultValue={accessNotes} className={field} placeholder="Buzz 304; lockbox by the side door" />
        </label>
        <label className="text-sm font-medium">
          Pets
          <input name="pets" maxLength={300} defaultValue={pets} className={field} placeholder="One cat, stays in the bedroom" />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="bg-pine px-5 py-3 text-sm text-white hover:bg-ink disabled:opacity-60">
          {pending ? "Saving…" : "Save unit profile"}
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
