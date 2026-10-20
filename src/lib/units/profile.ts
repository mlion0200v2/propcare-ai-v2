import { z } from "zod";

/**
 * A unit's profile, entered once by the manager (Homes > unit). The tenant
 * chat uses it for tap-answers ("Which room?") and damage-prevention tips
 * ("Your main water shut-off is in the laundry closet").
 */
export const fixtureSchema = z.object({
  name: z.string().trim().min(1).max(80),
  room: z.string().trim().max(80).optional(),
  brand: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
});

export const unitProfileSchema = z.object({
  rooms: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  fixtures: z.array(fixtureSchema).max(40).default([]),
  water_shutoff: z.string().trim().max(300).optional(),
  breaker_panel: z.string().trim().max(300).optional(),
  access_notes: z.string().trim().max(500).optional(),
  pets: z.string().trim().max(300).optional(),
});

export type UnitProfile = z.infer<typeof unitProfileSchema>;
export type Fixture = z.infer<typeof fixtureSchema>;

/** Tolerant read of stored JSON (old or partial profiles become empty fields). */
export function readUnitProfile(value: unknown): UnitProfile {
  const parsed = unitProfileSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : { rooms: [], fixtures: [] };
}

/** One fixture per line: "Dishwasher | Kitchen | Bosch | SHE3AR75UC". */
export function parseFixtureLines(text: string): Fixture[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts[0])
    .slice(0, 40)
    .map(([name, room, brand, model]) => ({
      name: name.slice(0, 80),
      ...(room ? { room: room.slice(0, 80) } : {}),
      ...(brand ? { brand: brand.slice(0, 60) } : {}),
      ...(model ? { model: model.slice(0, 60) } : {}),
    }));
}

export function fixtureLines(fixtures: Fixture[]): string {
  return fixtures.map((f) => [f.name, f.room ?? "", f.brand ?? "", f.model ?? ""].join(" | ").replace(/( \| )+$/, "")).join("\n");
}

export function fixtureLabel(f: Fixture): string {
  return [f.brand, f.name, f.model].filter(Boolean).join(" ");
}

const ROOM_SYNONYMS: Record<string, string[]> = {
  bathroom: ["bath", "ensuite", "en-suite", "washroom", "powder", "toilet"],
  bedroom: ["bedroom", "master", "nursery"],
  kitchen: ["kitchen"],
  laundry: ["laundry", "utility"],
  basement: ["basement"],
};

/**
 * Rooms in the unit profile the tenant may mean by a generic word:
 * "bathroom" → ["Main bathroom (hallway)", "Ensuite"].
 */
export function matchingRooms(generic: string, rooms: string[]): string[] {
  const g = generic.trim().toLowerCase();
  const keys = Object.entries(ROOM_SYNONYMS).find(([word]) => g.includes(word))?.[1] ?? [g];
  return rooms.filter((room) => keys.some((k) => room.toLowerCase().includes(k)));
}

/** "Which bathroom is it? (Main bathroom (hallway) or Ensuite)" */
export function whichRoomQuestion(generic: string, candidates: string[]): string {
  const list = candidates.length === 2 ? candidates.join(" or ") : candidates.join(", ");
  return `Which ${generic.trim().toLowerCase()} is it? (${list})`;
}

/** Form fields → profile (empty strings dropped). */
export function profileFromForm(form: {
  rooms: string;
  fixtures: string;
  water_shutoff: string;
  breaker_panel: string;
  access_notes: string;
  pets: string;
}): ReturnType<typeof unitProfileSchema.safeParse> {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return unitProfileSchema.safeParse({
    rooms: form.rooms
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean),
    fixtures: parseFixtureLines(form.fixtures),
    water_shutoff: opt(form.water_shutoff),
    breaker_panel: opt(form.breaker_panel),
    access_notes: opt(form.access_notes),
    pets: opt(form.pets),
  });
}
