/**
 * What the assistant may know about the home: rooms, fixtures, where the
 * shut-offs are, whether there are pets. Never who lives there, the
 * address, access notes (door codes) or anything about the lease.
 */

export interface PropertyFixture {
  name: string;
  room?: string;
  brand?: string;
  model?: string;
}

export interface PropertyContext {
  /** Room names as the manager entered them ("Main bathroom (hallway)", "Ensuite"…). */
  rooms: string[];
  fixtures: PropertyFixture[];
  water_shutoff?: string;
  breaker_panel?: string;
  /** e.g. "dog, friendly": a tradesperson should know; the assistant only passes it on. */
  pets?: string;
}

export const EMPTY_PROPERTY: PropertyContext = { rooms: [], fixtures: [] };

export function fixtureLabel(f: PropertyFixture): string {
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
 * The unit's rooms a generic word may mean ("bathroom" → hallway bathroom
 * and ensuite). Empty when nothing matches.
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
