/**
 * What the app sends the assistant, built from what it knows: the unit's
 * non-sensitive details, the stored state, and the tenant's words with
 * contact details taken out. Pure (tests import it directly).
 */
import type { AssistantState, PropertyContext } from "@/assistant";
import { readUnitProfile } from "@/lib/units/profile";
import type { TriageStateName } from "@/assistant/triage/types";

/** The non-sensitive part of a unit profile: never access notes (door codes), address or people. */
export function propertyContext(profile: unknown): PropertyContext {
  const p = readUnitProfile(profile);
  return {
    rooms: p.rooms,
    fixtures: p.fixtures.map((f) => ({ name: f.name, room: f.room, brand: f.brand, model: f.model })),
    water_shutoff: p.water_shutoff,
    breaker_panel: p.breaker_panel,
    pets: p.pets,
  };
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// 10+ digit phone numbers, with or without +1, spaces, dots, dashes or brackets.
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
// "123 Main St", "4500 West 10th Avenue", with an optional unit before or after.
const STREET =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|cres|crescent|ct|court|pl|place|hwy|highway|terrace|trail|parkway|pkwy)\b\.?/gi;
// Canadian postal codes and US ZIP+4.
const POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b|\b\d{5}-\d{4}\b/gi;

/** Remove contact details a tenant types ("call me at 604…", their address) before the assistant sees it. */
export function redactContactDetails(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(STREET, "[address]").replace(POSTAL, "[postal code]");
}

/**
 * The stored conversation state. Tickets from before the assistant
 * boundary (no `v`) are lifted into it from their columns.
 */
export function stateFromTicket(ticket: { description: string; triage_state: string; classification: unknown }): AssistantState | null {
  const c = ticket.classification as Partial<AssistantState> | null;
  if (!c || !c.gathered) return null;
  if (c.v === 1) return c as AssistantState;
  return {
    ...(c as AssistantState),
    v: 1,
    phase: ticket.triage_state as TriageStateName,
    description: redactContactDetails(ticket.description),
    ui: c.ui ?? { options: [], notes: [] },
  };
}

/** A whole message that only declines photos ("skip", "no thanks", "跳过"); "no, it's on the carpet" is an answer. */
const DECLINE_PHOTOS = /^\s*(skip|no|none|nope|no thanks|not now|later|non|pas maintenant|跳过|没有|不用)\s*[.!。！]?\s*$/i;

/**
 * What a tenant's input means while the photo buttons are showing. Only the
 * buttons (and a bare "skip") are photo actions; typed words are a message
 * for the assistant, with photos already uploaded counted as added.
 */
export function photoStepAction(
  mediaAction: string | undefined,
  message: string,
  mediaCount: number
): { action: "skip_photos" | "photos_added" | undefined; shown: string } {
  if (mediaAction === "skip") return { action: "skip_photos", shown: "Skip" };
  if (mediaAction === "done") return { action: mediaCount > 0 ? "photos_added" : "skip_photos", shown: "Done" };
  if (DECLINE_PHOTOS.test(message)) return { action: "skip_photos", shown: message };
  return { action: mediaCount > 0 ? "photos_added" : undefined, shown: message };
}
