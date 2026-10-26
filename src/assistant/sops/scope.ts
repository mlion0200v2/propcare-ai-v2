/**
 * Scope rule: every intake question and tap option must fit what is
 * already known. One filter, applied inside the intake engine
 * (optionsFor / nextIntakeQuestion), so no flow can bypass it.
 *
 * - Room known → only fixtures that exist in (or plausibly affect) that
 *   room: no shower or toilet for a kitchen, no dishwasher for a bathroom.
 *   The unit profile's fixture rooms win over the default map. Ceilings and
 *   walls are the exception: what's *above* can be any room.
 * - Equipment known → only that equipment and the parts around it.
 * - Substance known → only questions that fit it (grease isn't water; a gas
 *   smell gets no questions at all, it's an emergency).
 */
import type { PropertyContext } from "../property";
import { mentionedEquipment, mentionedRoom } from "@/assistant/understanding/rules";
import type { Equipment, Room, Substance } from "@/assistant/understanding/taxonomy";
import type { IntakeOption, IntakeQuestion } from "./schema";

export interface ScopeFrame {
  equipment: string;
  substance: string;
  room: string;
}

/** Where a fixture can be, when the unit profile doesn't say. Unlisted equipment can be anywhere. */
export const DEFAULT_FIXTURE_ROOMS: Partial<Record<Equipment, Room[]>> = {
  range_hood: ["kitchen"],
  stove_oven: ["kitchen"],
  microwave: ["kitchen"],
  fridge: ["kitchen", "basement", "garage"],
  dishwasher: ["kitchen"],
  garbage_disposal: ["kitchen"],
  kitchen_sink: ["kitchen"],
  bathroom_sink: ["bathroom"],
  toilet: ["bathroom"],
  tub_shower: ["bathroom"],
  bathroom_fan: ["bathroom", "laundry"],
  washer: ["laundry", "bathroom", "kitchen", "hallway", "basement"],
  dryer: ["laundry", "bathroom", "kitchen", "hallway", "basement"],
  garage_door: ["garage", "exterior"],
  gutter: ["exterior", "balcony"],
};

/** Parts and neighbours of a piece of equipment (a sink's disposal, a washer's taps, an appliance's own door). */
const RELATED: Partial<Record<Equipment, Equipment[]>> = {
  kitchen_sink: ["sink", "faucet", "garbage_disposal", "dishwasher"],
  bathroom_sink: ["sink", "faucet"],
  sink: ["kitchen_sink", "bathroom_sink", "faucet", "garbage_disposal", "dishwasher"],
  faucet: ["sink", "kitchen_sink", "bathroom_sink", "tub_shower", "garbage_disposal", "dishwasher", "water_heater"],
  tub_shower: ["faucet", "bathroom_fan", "door", "water_heater"],
  toilet: [],
  dishwasher: ["kitchen_sink", "sink", "garbage_disposal", "faucet", "door"],
  garbage_disposal: ["kitchen_sink", "sink", "dishwasher", "faucet"],
  fridge: ["door"],
  washer: ["faucet", "dryer", "door"],
  dryer: ["washer", "door"],
  range_hood: ["stove_oven", "bathroom_fan"],
  stove_oven: ["range_hood", "microwave", "door"],
  microwave: ["stove_oven", "range_hood", "door"],
  water_heater: ["faucet", "tub_shower", "kitchen_sink", "bathroom_sink", "sink"],
  furnace: ["thermostat", "baseboard_heater", "vent"],
  heat_pump: ["thermostat", "ac", "vent"],
  vent: ["furnace", "thermostat", "heat_pump", "ac"],
  blinds: ["window"],
  gutter: ["roof"],
  roof: ["gutter"],
  garage_door: ["door", "lock"],
  elevator: ["door"],
  baseboard_heater: ["thermostat"],
  thermostat: ["furnace", "baseboard_heater", "ac", "heat_pump", "vent"],
  ac: ["thermostat"],
  smoke_alarm: ["co_alarm"],
  co_alarm: ["smoke_alarm"],
  lock: ["door", "window"],
  window: ["lock", "blinds"],
  door: ["lock", "intercom"],
  intercom: ["door", "lock"],
  bathroom_fan: [],
  drain: ["sink", "kitchen_sink", "bathroom_sink", "tub_shower", "toilet", "washer", "dishwasher"],
};

/** Safety and surroundings: always fair to mention (water near an outlet, a pipe behind it). */
const ALWAYS_OK = new Set<Equipment>(["pipe", "drain", "outlet", "light", "switch", "breaker", "wall", "floor", "ceiling"]);
/** Where water ends up: a ceiling or wall leak can come from any room above or behind. */
const SURFACES = new Set<string>(["ceiling", "wall"]);
/** Where the water is, not what it comes from: any fixture (in the room) may be the source. */
export const NOT_A_SOURCE = new Set<string>(["ceiling", "wall", "floor", "pipe", "unknown"]);
/** Substances that make water questions wrong. */
const NOT_WATER = new Set<Substance>(["grease", "oil", "smoke", "gas"]);
const WATER_TEXT = /\b(water|puddle|wet)\b/i;

function roomsFor(e: Equipment, profile: PropertyContext | null): Room[] | null {
  const fromProfile = (profile?.fixtures ?? [])
    .filter((f) => f.room && mentionedEquipment(f.name).has(e))
    .map((f) => mentionedRoom(f.room!))
    .filter((r): r is Room => !!r);
  if (fromProfile.length > 0) return [...new Set(fromProfile)];
  return DEFAULT_FIXTURE_ROOMS[e] ?? null;
}

/** Why a text is out of scope for this frame, or null when it fits. */
export function outOfScope(text: string, frame: ScopeFrame, profile: PropertyContext | null): string | null {
  const named = mentionedEquipment(text);
  const known = frame.equipment as Equipment;
  const parts = new Set<Equipment>(frame.equipment !== "unknown" ? [known, ...(RELATED[known] ?? [])] : []);
  if (NOT_WATER.has(frame.substance as Substance) && WATER_TEXT.test(text)) return `water, but it's ${frame.substance}`;
  const surface = SURFACES.has(frame.equipment);
  if (frame.room !== "unknown" && !surface) {
    for (const e of named) {
      const rooms = roomsFor(e, profile);
      if (rooms && !rooms.includes(frame.room as Room)) return `${e} isn't in the ${frame.room}`;
    }
  }
  if (!NOT_A_SOURCE.has(frame.equipment)) {
    for (const e of named) if (!parts.has(e) && !ALWAYS_OK.has(e)) return `${e} isn't part of the ${known}`;
  }
  return null;
}

export interface ScopedQuestion {
  question: IntakeQuestion;
  options: IntakeOption[];
}

/**
 * The question and the options that fit what's known; null when the
 * question itself doesn't fit (or nothing but "not sure" would be left).
 */
export function scopeOptions(frame: ScopeFrame, profile: PropertyContext | null, question: IntakeQuestion): ScopedQuestion | null {
  if (frame.substance === "gas") return null; // an emergency: no intake questions
  // A question that asks for the equipment or room is how they become known; its text can name any.
  const asksWhat = question.slot === "equipment" || question.slot === "room";
  if (!asksWhat && outOfScope(question.question, frame, profile)) return null;
  const options = question.options.filter((o) => !outOfScope(o.label, frame, profile));
  if (question.options.length > 0 && options.every((o) => o.value === "not_sure")) return null;
  return { question, options };
}
