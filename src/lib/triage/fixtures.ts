/**
 * Fixture-aware leak questions. Data, not branching: each fixture has its
 * own "where on it?" and "when?" questions with options that make sense
 * for it, and each option points at a likely source. The likely source
 * goes on the ticket summary and vendor work order, steers SOP retrieval,
 * and picks the damage-prevention step.
 */
import { normalizeVocabulary } from "./vocabulary";

export type SourceId =
  | "faucet_seal"
  | "faucet_cartridge"
  | "supply_line"
  | "drain_trap"
  | "disposal"
  | "dishwasher_connection"
  | "toilet_tank"
  | "toilet_base"
  | "toilet_supply"
  | "toilet_clog"
  | "tub_valve"
  | "tub_drain"
  | "shower_surround"
  | "water_heater_fittings"
  | "water_heater_relief"
  | "water_heater_tank"
  | "dishwasher_door"
  | "dishwasher_base"
  | "washer_hose"
  | "washer_drain"
  | "washer_door"
  | "fridge_water_line"
  | "fridge_drain"
  | "above_bathroom"
  | "above_kitchen"
  | "above_unit"
  | "roof"
  | "pipe_in_ceiling";

export interface LeakSource {
  /** Shown on the ticket summary and vendor work order. */
  label: string;
  /** Added to the SOP retrieval query. */
  sopQuery: string;
  /** First damage-prevention step for the tenant. */
  prevention: string;
}

export const LEAK_SOURCES: Record<SourceId, LeakSource> = {
  faucet_seal: { label: "Faucet seal or cartridge (base/handle)", sopQuery: "faucet leaking at base handle o-ring cartridge", prevention: "Turn the tap fully off and keep it off; wipe up and leave a towel around the base." },
  faucet_cartridge: { label: "Faucet cartridge or washer (drips from the spout)", sopQuery: "dripping faucet spout cartridge washer aerator", prevention: "Put a cup under the spout; if the drip gets heavier, close the valves under the sink (clockwise)." },
  supply_line: { label: "Supply hose or shut-off valve under the sink", sopQuery: "sink supply line shut-off valve leak under sink", prevention: "Close both valves under the sink (turn clockwise) and put a bowl under the drip." },
  drain_trap: { label: "Drain pipe / P-trap slip nut", sopQuery: "p-trap slip nut drain pipe leak under sink", prevention: "Don't run the tap or the dishwasher; put a bowl under the trap." },
  disposal: { label: "Garbage disposal (seal or housing)", sopQuery: "garbage disposal leaking", prevention: "Don't run the disposal or the tap; never put your hand inside it." },
  dishwasher_connection: { label: "Dishwasher drain hose / connection under the sink", sopQuery: "dishwasher drain hose connection leak under sink", prevention: "Don't run the dishwasher; put a bowl under the hose connection." },
  toilet_tank: { label: "Toilet tank: flapper, fill valve or tank bolts", sopQuery: "toilet running flapper fill valve tank leak", prevention: "Turn off the toilet's valve (behind it, near the floor, clockwise) and flush once to empty the tank." },
  toilet_base: { label: "Wax ring at the toilet base", sopQuery: "toilet leaking at base wax ring", prevention: "Don't flush this toilet; use another one if you can and keep towels around the base." },
  toilet_supply: { label: "Toilet supply line or shut-off valve", sopQuery: "toilet supply line shut-off valve leak", prevention: "Turn off the toilet's valve (clockwise) and put a towel under the line." },
  toilet_clog: { label: "Toilet blockage (overflows when flushed)", sopQuery: "toilet clogged overflowing plunger", prevention: "Don't flush again; lift the tank lid and close the flapper, or turn off the toilet's valve." },
  tub_valve: { label: "Tub/shower valve or spout (drips when off)", sopQuery: "tub spout shower head dripping valve cartridge", prevention: "Turn the handle fully off; if it keeps running, tell us now and avoid using it." },
  tub_drain: { label: "Tub drain or overflow gasket", sopQuery: "bathtub drain overflow gasket leak", prevention: "Don't fill the tub until it's checked; showers are OK if no water shows below." },
  shower_surround: { label: "Caulking/grout or shower door seal (water escapes while showering)", sopQuery: "shower caulking grout door seal water on floor", prevention: "Keep the curtain inside the tub or the door closed, and dry the floor after showering." },
  water_heater_fittings: { label: "Water heater fittings on top (pipes or valve)", sopQuery: "water heater leaking from top fittings", prevention: "Close the cold-water valve on top of the tank (turn clockwise). Don't touch the gas controls." },
  water_heater_relief: { label: "Water heater pressure-relief (T&P) valve", sopQuery: "water heater temperature pressure relief valve leaking", prevention: "Keep clear of the pipe: the water can be very hot. Put a bucket under it." },
  water_heater_tank: { label: "Water heater tank (may need replacing)", sopQuery: "water heater tank leaking bottom", prevention: "Close the cold-water valve on top of the tank. Don't touch the gas controls or the burner area." },
  dishwasher_door: { label: "Dishwasher door seal", sopQuery: "dishwasher leaking from door gasket", prevention: "Don't run the dishwasher; wipe the floor dry." },
  dishwasher_base: { label: "Dishwasher pump, hose or valve (underneath)", sopQuery: "dishwasher leaking underneath pump hose", prevention: "Don't run the dishwasher; if water keeps coming, close the valve under the sink." },
  washer_hose: { label: "Washer fill hose or tap", sopQuery: "washing machine fill hose leak", prevention: "Turn off the two taps behind the washer (clockwise) and don't run it." },
  washer_drain: { label: "Washer drain hose or standpipe", sopQuery: "washing machine drain hose standpipe overflow", prevention: "Don't run the washer until it's checked." },
  washer_door: { label: "Washer door seal", sopQuery: "front load washer door gasket leak", prevention: "Don't run the washer; wipe the seal and the floor dry." },
  fridge_water_line: { label: "Fridge water line or ice maker", sopQuery: "refrigerator ice maker water line leak", prevention: "Turn off the fridge's water line valve (behind the fridge or under the sink)." },
  fridge_drain: { label: "Fridge defrost drain", sopQuery: "refrigerator defrost drain water inside", prevention: "Wipe up the water and keep food off the bottom shelf." },
  above_bathroom: { label: "Bathroom above (tub, shower, toilet or sink)", sopQuery: "ceiling leak below bathroom", prevention: "If you can reach it safely, ask that bathroom not be used; put a bucket under the drip." },
  above_kitchen: { label: "Kitchen above (sink or dishwasher)", sopQuery: "ceiling leak below kitchen", prevention: "Put a bucket under the drip and move things away from it." },
  above_unit: { label: "Another unit above", sopQuery: "ceiling leak from unit above", prevention: "Put a bucket under the drip; we'll contact the unit above." },
  roof: { label: "Roof or flashing (rain)", sopQuery: "roof leak ceiling stain rain", prevention: "Put a bucket under the drip and move valuables away." },
  pipe_in_ceiling: { label: "Pipe in the ceiling or wall (constant)", sopQuery: "pipe leak inside ceiling wall constant drip", prevention: "Turn off the main water if the drip is steady or growing." },
};

export interface FixtureOption {
  label: string;
  source?: SourceId;
  /** Free-text answers (and first messages) that mean this option. */
  match?: RegExp;
}

export interface FixtureQuestion {
  question: string;
  options: FixtureOption[];
}

export type FixtureId =
  | "kitchen_sink"
  | "bathroom_sink"
  | "toilet"
  | "tub_shower"
  | "water_heater"
  | "dishwasher"
  | "washer"
  | "fridge"
  | "ceiling_wall";

export interface FixtureSpec {
  id: FixtureId;
  label: string;
  part: FixtureQuestion | null;
  timing: FixtureQuestion | null;
}

const NOT_SURE: FixtureOption = { label: "Not sure", match: /^\s*(not sure|unsure|don'?t know|no idea|idk)\b/i };

const SINK_TIMING: FixtureQuestion = {
  question: "When does it leak?",
  options: [
    { label: "Only while the tap is running", source: "faucet_seal", match: /\b(tap|faucet|water)\b.*\b(on|running|use)\b|\bwhen I (turn on|use|run)\b/i },
    { label: "Only while water is draining", source: "drain_trap", match: /\bdrain(s|ing)?\b|\bempty(ing)?\b/i },
    { label: "All the time, even with the tap off", source: "supply_line", match: /\b(all the time|constant|always|even (when|with)|tap (is )?off)\b/i },
    NOT_SURE,
  ],
};

const SINK_PARTS: FixtureOption[] = [
  { label: "Around the faucet base or handle", source: "faucet_seal", match: /\b(base|handle|around the (tap|faucet))\b/i },
  { label: "From the spout (it drips when off)", source: "faucet_cartridge", match: /\bspout\b|\bdrips? (when|even when) (it'?s )?off\b/i },
  { label: "The supply hoses or shut-off valves under the sink", source: "supply_line", match: /\b(supply|hose|hoses|valve|valves|line)\b/i },
  { label: "The drain pipe / P-trap under the sink", source: "drain_trap", match: /\b(drain pipe|p[\s-]?trap|trap|u[\s-]?bend|slip nut)\b/i },
];

export const FIXTURES: Record<FixtureId, FixtureSpec> = {
  kitchen_sink: {
    id: "kitchen_sink",
    label: "kitchen sink",
    part: {
      question: "Where on the sink is the water coming from?",
      options: [
        ...SINK_PARTS,
        { label: "The garbage disposal", source: "disposal", match: /\b(garbage disposal|disposal)\b/i },
        { label: "The dishwasher hose", source: "dishwasher_connection", match: /\bdishwasher\b/i },
        NOT_SURE,
      ],
    },
    timing: SINK_TIMING,
  },
  bathroom_sink: {
    id: "bathroom_sink",
    label: "bathroom sink",
    part: {
      question: "Where on the sink is the water coming from?",
      options: [...SINK_PARTS, { label: "The drain stopper", source: "drain_trap", match: /\b(stopper|pop[\s-]?up)\b/i }, NOT_SURE],
    },
    timing: SINK_TIMING,
  },
  toilet: {
    id: "toilet",
    label: "toilet",
    part: {
      question: "Where is the water coming from?",
      options: [
        { label: "The tank, or water running into the bowl", source: "toilet_tank", match: /\b(tank|running|keeps running|into the bowl|flapper|fill valve)\b/i },
        { label: "Around the base, on the floor", source: "toilet_base", match: /\b(base|floor|bottom|around (the|my) toilet)\b/i },
        { label: "The supply line or valve behind it", source: "toilet_supply", match: /\b(supply|line|hose|valve|behind)\b/i },
        { label: "It overflows when flushed", source: "toilet_clog", match: /\b(overflow|overflows|overflowing|clogged|blocked)\b/i },
        NOT_SURE,
      ],
    },
    timing: {
      question: "When does it happen?",
      options: [
        { label: "Only when it's flushed", match: /\bflush/i },
        { label: "All the time", source: "toilet_tank", match: /\b(all the time|constant|always)\b/i },
        NOT_SURE,
      ],
    },
  },
  tub_shower: {
    id: "tub_shower",
    label: "tub or shower",
    part: {
      question: "Where is the water coming from?",
      options: [
        { label: "The spout or shower head (drips when off)", source: "tub_valve", match: /\b(spout|shower ?head|head|drips? when off)\b/i },
        { label: "Around the handle or valve", source: "tub_valve", match: /\b(handle|valve|knob)\b/i },
        { label: "Water gets out onto the floor", source: "shower_surround", match: /\b(floor|curtain|door|caulk|grout|outside the)\b/i },
        { label: "The drain or overflow", source: "tub_drain", match: /\b(drain|overflow)\b/i },
        { label: "Through the ceiling below", source: "shower_surround", match: /\bceiling\b/i },
        NOT_SURE,
      ],
    },
    timing: {
      question: "When does it leak?",
      options: [
        { label: "Only while showering or bathing", match: /\b(while|when) (I )?(shower|bath|showering|bathing)\b|\bduring\b/i },
        { label: "All the time, even when it's off", source: "tub_valve", match: /\b(all the time|constant|always|even (when )?off)\b/i },
        NOT_SURE,
      ],
    },
  },
  water_heater: {
    id: "water_heater",
    label: "water heater",
    part: {
      question: "Where is the water coming from?",
      options: [
        { label: "Dripping from a pipe or valve on top", source: "water_heater_fittings", match: /\b(top|pipe|fitting)\b/i },
        { label: "From the side pipe (relief valve)", source: "water_heater_relief", match: /\b(side|relief|t\s?&\s?p|pressure)\b/i },
        { label: "Pooling under the tank", source: "water_heater_tank", match: /\b(under|bottom|pool|pooling|floor|base)\b/i },
        NOT_SURE,
      ],
    },
    timing: null,
  },
  dishwasher: {
    id: "dishwasher",
    label: "dishwasher",
    part: {
      question: "Where does the water come out?",
      options: [
        { label: "From the door, at the front", source: "dishwasher_door", match: /\b(door|front|gasket|seal)\b/i },
        { label: "Underneath or around the bottom", source: "dishwasher_base", match: /\b(under|underneath|bottom|below)\b/i },
        { label: "Under the sink (the hose)", source: "dishwasher_connection", match: /\b(sink|hose)\b/i },
        NOT_SURE,
      ],
    },
    timing: {
      question: "When does it leak?",
      options: [
        { label: "Only while it's running", match: /\b(running|washing|during)\b/i },
        { label: "When it drains, at the end", source: "dishwasher_connection", match: /\b(drain|end|finish)/i },
        { label: "All the time, even when off", source: "dishwasher_base", match: /\b(all the time|always|constant|off)\b/i },
        NOT_SURE,
      ],
    },
  },
  washer: {
    id: "washer",
    label: "washing machine",
    part: {
      question: "Where is the water coming from?",
      options: [
        { label: "Behind the machine (hoses or taps)", source: "washer_hose", match: /\b(behind|hose|hoses|taps?|faucet)\b/i },
        { label: "From the door", source: "washer_door", match: /\b(door|front|seal|gasket)\b/i },
        { label: "The drain pipe or standpipe", source: "washer_drain", match: /\b(drain|standpipe|stand pipe)\b/i },
        { label: "Underneath", source: "washer_hose", match: /\b(under|underneath|bottom)\b/i },
        NOT_SURE,
      ],
    },
    timing: {
      question: "When does it leak?",
      options: [
        { label: "Only while it's filling", source: "washer_hose", match: /\bfill/i },
        { label: "Only while it's draining or spinning", source: "washer_drain", match: /\b(drain|spin)/i },
        { label: "All the time, even when off", source: "washer_hose", match: /\b(all the time|always|constant|off)\b/i },
        NOT_SURE,
      ],
    },
  },
  fridge: {
    id: "fridge",
    label: "fridge",
    part: {
      question: "Where is the water?",
      options: [
        { label: "Under or behind the fridge", source: "fridge_water_line", match: /\b(under|behind|floor|underneath)\b/i },
        { label: "From the ice or water dispenser", source: "fridge_water_line", match: /\b(ice|dispenser)\b/i },
        { label: "Inside the fridge, at the bottom", source: "fridge_drain", match: /\b(inside|bottom shelf|crisper|in the fridge)\b/i },
        NOT_SURE,
      ],
    },
    timing: null,
  },
  ceiling_wall: {
    id: "ceiling_wall",
    label: "ceiling or wall",
    part: {
      question: "What's above it, or behind that wall?",
      options: [
        { label: "A bathroom", source: "above_bathroom", match: /\b(bathroom|toilet|shower|tub|bath)\b/i },
        { label: "A kitchen", source: "above_kitchen", match: /\bkitchen\b/i },
        { label: "Another unit (a neighbour's)", source: "above_unit", match: /\b(neighbou?r|unit|apartment|upstairs|suite)\b/i },
        { label: "The roof or attic", source: "roof", match: /\b(roof|attic)\b/i },
        NOT_SURE,
      ],
    },
    timing: {
      question: "When does it drip?",
      options: [
        { label: "Only when that's used (shower, toilet or tap above)", match: /\b(when|only).*\b(used|shower|flush|tap|run)/i },
        { label: "All the time", source: "pipe_in_ceiling", match: /\b(all the time|constant|always|non[\s-]?stop)\b/i },
        { label: "When it rains", source: "roof", match: /\brain/i },
        NOT_SURE,
      ],
    },
  },
};

/** Generic "where is the water?" when no fixture was named. Answers can name a fixture. */
export const LEAK_WHERE_OPTIONS = [
  "Ceiling",
  "Wall",
  "Floor",
  "Under the kitchen sink",
  "Bathroom sink",
  "Toilet",
  "Tub or shower",
  "Water heater",
  "Dishwasher",
  "Washing machine",
  "Fridge",
  "Not sure",
];

/** Which fixture the tenant means, from their words and the room (null if unclear). */
export function detectFixture(text: string, room?: string | null): FixtureId | null {
  const t = normalizeVocabulary(`${text} ${room ?? ""}`).toLowerCase();
  if (/\bwater heater\b/.test(t)) return "water_heater";
  if (/\bdishwasher\b/.test(t) && !/\b(hose|connection)\b.*\bsink\b/.test(t)) return "dishwasher";
  if (/\b(washing machine|washer)\b/.test(t)) return "washer";
  if (/\b(refrigerator|fridge|freezer|ice maker)\b/.test(t)) return "fridge";
  if (/\btoilet\b/.test(t)) return "toilet";
  if (/\b(tub|bathtub|shower)\b/.test(t) && !/\bceiling\b/.test(t)) return "tub_shower";
  if (/\b(sink|faucet|vanity)\b/.test(t)) {
    if (/\b(kitchen)\b/.test(t)) return "kitchen_sink";
    if (/\b(bath|bathroom|ensuite|washroom|powder|vanity)\b/.test(t)) return "bathroom_sink";
    return null; // need the room first
  }
  if (/\b(ceiling|wall)\b/.test(t)) return "ceiling_wall";
  return null;
}

/** The option a free-text answer (or first message) means, if any. */
export function matchOption(question: FixtureQuestion, answer: string): FixtureOption | null {
  const a = answer.trim().toLowerCase();
  const exact = question.options.find((o) => o.label.toLowerCase() === a);
  if (exact) return exact;
  return question.options.find((o) => o.match && o.match.test(answer)) ?? null;
}

/** Likely source: the "where" answer if specific, else the "when" answer. */
export function resolveLikelySource(fixture: FixtureId | null, part: string | null | undefined, timing: string | null | undefined): SourceId | null {
  if (!fixture) return null;
  const spec = FIXTURES[fixture];
  const fromPart = spec.part && part ? matchOption(spec.part, part)?.source : undefined;
  const fromTiming = spec.timing && timing ? matchOption(spec.timing, timing)?.source : undefined;
  // Toilet: "only when flushed" with an unknown part points at the base.
  if (fixture === "toilet" && !fromPart && timing && /flush/i.test(timing)) return "toilet_base";
  return fromPart ?? fromTiming ?? null;
}
