/**
 * Scripted tenant conversations for the conversation eval.
 *
 * Each scenario: the tenant's first message, the facts they give when
 * asked (keyed by question id), and what must (not) happen. Question ids:
 * classify_category, location_in_unit, started_when, current_status,
 * leak_where, leak_part, leak_timing, leak_amount, leak_electrical,
 * brand_model, safety_check.
 */

export interface Scenario {
  id: string;
  name: string;
  first: string;
  rooms?: string[];
  /** Answers by question id; anything unlisted gets a neutral default. */
  facts?: Record<string, string>;
  /** Stubbed LLM fallback classifier result (only used when rules find nothing). */
  fallback?: { category: string; equipment: string | null } | null;
  expect: {
    category?: string;
    equipment?: string;
    /** The bot must not ask "what type of issue is this?". */
    noCategoryQuestion?: boolean;
    /** 1 = the first reply is already the emergency response. */
    emergencyAtTurn?: number;
    /** Escalated as an emergency at some turn. */
    emergency?: boolean;
    neverAsk?: string[];
    mustAsk?: string[];
    optionsInclude?: Record<string, string[]>;
    optionsExclude?: Record<string, string[]>;
    /** Substring of the recorded likely source label (case-insensitive). */
    likelySource?: string;
    /** Strings the first reply must not contain (case-insensitive). */
    firstReplyExcludes?: string[];
  };
}

const KITCHEN_ROOMS = ["Kitchen", "Main bathroom (hallway)", "Laundry closet", "Bedroom", "Living room"];
const TWO_BATH_ROOMS = ["Main bathroom (upstairs hallway)", "Ensuite", "Kitchen", "Laundry (basement)", "Basement"];

/** One-word / two-word forms and variants → category + equipment, no category question. */
const SYNONYMS: [string, string, string, string][] = [
  // [id, message, category, equipment]
  ["syn-rangehood", "my rangehood is not working", "appliance", "range hood"],
  ["syn-range-hood", "the range hood won't turn on", "appliance", "range hood"],
  ["syn-hood-fan", "hood fan is really loud", "appliance", "range hood"],
  ["syn-stove-fan", "stove fan stopped working", "appliance", "range hood"],
  ["syn-exhaust-fan-kitchen", "the kitchen exhaust fan doesn't work", "appliance", "range hood"],
  ["syn-dish-washer", "dish washer won't drain", "appliance", "dishwasher"],
  ["syn-dishwasher", "dishwasher is not cleaning", "appliance", "dishwasher"],
  ["syn-fridge", "fridge is warm", "appliance", "refrigerator"],
  ["syn-refrigerator", "refrigerator not cooling", "appliance", "refrigerator"],
  ["syn-washing-machine", "washing machine won't spin", "appliance", "washer"],
  ["syn-washer", "the washer is shaking a lot", "appliance", "washer"],
  ["syn-dryer", "dryer doesn't heat", "appliance", "dryer"],
  ["syn-microwave", "microwave stopped heating", "appliance", "microwave"],
  ["syn-garburator", "garburator is jammed", "appliance", "garbage disposal"],
  ["syn-garbage-disposal", "garbage disposal hums but doesn't spin", "appliance", "garbage disposal"],
  ["syn-disposal", "the disposal is stuck", "appliance", "garbage disposal"],
  ["syn-hot-water-tank", "hot water tank making noises", "plumbing", "water heater"],
  ["syn-water-heater", "no hot water, I think the water heater is broken", "plumbing", "water heater"],
  ["syn-baseboard", "baseboard heater in the bedroom isn't working", "hvac", "baseboard heater"],
  ["syn-thermostat", "thermostat screen is blank", "hvac", "thermostat"],
  ["syn-smoke-detector", "smoke detector keeps chirping", "electrical", "smoke alarm"],
  ["syn-smoke-alarm", "the smoke alarm beeps every minute", "electrical", "smoke alarm"],
  ["syn-gfci", "GFCI in the bathroom keeps tripping", "electrical", "outlet"],
  ["syn-plug", "the plug by my bed doesn't work", "electrical", "outlet"],
  ["syn-toilet", "toilet keeps running", "plumbing", "toilet"],
  ["syn-tap", "kitchen tap won't turn off all the way", "plumbing", "faucet"],
  ["syn-faucet", "bathroom faucet is dripping", "plumbing", "faucet"],
  ["syn-plugged", "my toilet is plugged", "plumbing", "toilet"],
];

export const SCENARIOS: Scenario[] = [
  // ── Simone's live-demo transcripts, verbatim ──
  {
    id: "simone-1",
    name: "Simone transcript: rangehood",
    first: "my rangehood is not working",
    rooms: KITCHEN_ROOMS,
    expect: {
      category: "appliance",
      equipment: "range hood",
      noCategoryQuestion: true,
      neverAsk: ["classify_category"],
      firstReplyExcludes: ["what type of issue", "rangehood is not working"],
    },
  },
  {
    id: "simone-3",
    name: "Simone transcript: rangehood is leaking gease (typo; grease, not water)",
    first: "rangehood is leaking gease",
    rooms: KITCHEN_ROOMS,
    expect: {
      category: "appliance",
      equipment: "range hood",
      noCategoryQuestion: true,
      neverAsk: ["classify_category", "location_in_unit", "leak_where", "leak_amount", "leak_electrical"],
    },
  },
  {
    id: "simone-2",
    name: "Simone transcript: my sink is leaking → Kitchen",
    first: "my sink is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { location_in_unit: "Kitchen", leak_part: "The drain pipe / P-trap under the sink", leak_timing: "Only while water is draining" },
    expect: {
      category: "plumbing",
      noCategoryQuestion: true,
      mustAsk: ["location_in_unit", "leak_part", "leak_timing"],
      optionsInclude: {
        leak_part: ["Around the faucet base or handle", "The drain pipe / P-trap under the sink", "The garbage disposal", "The dishwasher hose"],
        leak_timing: ["Only while the tap is running", "Only while water is draining", "All the time, even with the tap off"],
      },
      optionsExclude: { leak_timing: ["shower", "bath", "toilet", "flushed"] },
      likelySource: "P-trap",
    },
  },

  // ── Synonyms ──
  ...SYNONYMS.map<Scenario>(([id, first, category, equipment]) => ({
    id,
    name: `Synonym: "${first}"`,
    first,
    rooms: KITCHEN_ROOMS,
    expect: { category, equipment, noCategoryQuestion: true, neverAsk: ["classify_category"] },
  })),

  // ── Fixture-aware leak questions ──
  {
    id: "leak-kitchen-sink-supply",
    name: "Kitchen sink, water runs even with the tap off",
    first: "water under my kitchen sink",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "Not sure", leak_timing: "All the time, even with the tap off" },
    expect: {
      neverAsk: ["location_in_unit", "leak_where"],
      mustAsk: ["leak_part", "leak_timing"],
      optionsExclude: { leak_timing: ["shower", "toilet"] },
      likelySource: "supply",
    },
  },
  {
    id: "leak-kitchen-faucet-base",
    name: "Kitchen sink, leaking around the faucet base (said up front)",
    first: "my kitchen sink is leaking around the base of the faucet",
    rooms: KITCHEN_ROOMS,
    expect: { neverAsk: ["location_in_unit", "leak_where", "leak_part"], likelySource: "faucet" },
  },
  {
    id: "leak-bathroom-sink",
    name: "Bathroom sink: no disposal or dishwasher options",
    first: "bathroom sink is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "The drain pipe / P-trap under the sink" },
    expect: {
      mustAsk: ["leak_part", "leak_timing"],
      optionsExclude: { leak_part: ["disposal", "dishwasher"], leak_timing: ["shower", "flushed"] },
      likelySource: "P-trap",
    },
  },
  {
    id: "leak-toilet-base",
    name: "Toilet leaking at the base when flushed",
    first: "water on the floor around my toilet",
    rooms: KITCHEN_ROOMS,
    facts: { leak_timing: "Only when it's flushed" },
    expect: {
      neverAsk: ["location_in_unit", "leak_where", "leak_part"],
      mustAsk: ["leak_timing"],
      optionsExclude: { leak_timing: ["tap is running", "shower", "dishwasher"] },
      likelySource: "wax ring",
    },
  },
  {
    id: "leak-toilet-tank",
    name: "Toilet: water keeps running into the bowl",
    first: "my toilet is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "The tank, or water running into the bowl", leak_timing: "All the time" },
    expect: {
      mustAsk: ["leak_part"],
      optionsInclude: { leak_part: ["Around the base, on the floor", "The supply line or valve behind it"] },
      likelySource: "flapper",
    },
  },
  {
    id: "leak-shower-ceiling-below",
    name: "Shower: only when showering",
    first: "the shower is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "Water gets out onto the floor", leak_timing: "Only while showering or bathing" },
    expect: {
      mustAsk: ["leak_part", "leak_timing"],
      optionsExclude: { leak_timing: ["tap is running", "flushed", "dishwasher"] },
      likelySource: "caulking",
    },
  },
  {
    id: "leak-water-heater",
    name: "Water heater pooling underneath (no 'when' question)",
    first: "my hot water tank is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "Pooling under the tank" },
    expect: {
      neverAsk: ["leak_where", "leak_timing"],
      mustAsk: ["leak_part"],
      likelySource: "tank",
    },
  },
  {
    id: "leak-dishwasher",
    name: "Dishwasher leaking from the door",
    first: "dishwasher is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "From the door, at the front", leak_timing: "Only while it's running" },
    expect: {
      category: "appliance",
      neverAsk: ["classify_category", "location_in_unit", "leak_where"],
      mustAsk: ["leak_part"],
      optionsExclude: { leak_timing: ["shower", "flushed", "tap is running"] },
      likelySource: "door seal",
    },
  },
  {
    id: "leak-washer",
    name: "Washing machine leaking while filling",
    first: "washing machine is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "Behind the machine (hoses or taps)", leak_timing: "Only while it's filling" },
    expect: { neverAsk: ["leak_where"], mustAsk: ["leak_part", "leak_timing"], likelySource: "fill hose" },
  },
  {
    id: "leak-fridge",
    name: "Fridge: water under it (said up front) → ice maker line",
    first: "there's water under my fridge",
    rooms: KITCHEN_ROOMS,
    expect: { neverAsk: ["leak_where", "leak_timing", "leak_part"], likelySource: "ice maker" },
  },
  {
    id: "leak-ceiling",
    name: "Ceiling leak: what's above",
    first: "There's water dripping from the bathroom ceiling",
    rooms: KITCHEN_ROOMS,
    facts: { leak_part: "A bathroom", leak_timing: "Only when that's used (shower, toilet or tap above)" },
    expect: {
      neverAsk: ["leak_where"],
      mustAsk: ["leak_part", "leak_timing"],
      optionsInclude: { leak_part: ["Another unit (a neighbour's)"], leak_timing: ["All the time", "When it rains"] },
      likelySource: "above",
    },
  },
  {
    id: "leak-which-bathroom",
    name: "Two bathrooms: asks which, then the sink questions",
    first: "the bathroom sink is leaking",
    rooms: TWO_BATH_ROOMS,
    facts: { location_in_unit: "Ensuite" },
    expect: { mustAsk: ["location_in_unit", "leak_part"], optionsInclude: { location_in_unit: ["Main bathroom (upstairs hallway)", "Ensuite"] } },
  },
  {
    id: "leak-unknown-source",
    name: "Leak with no fixture named: where is the water, then fixture questions",
    first: "something is leaking",
    rooms: KITCHEN_ROOMS,
    facts: { location_in_unit: "Kitchen", leak_where: "Under the kitchen sink", leak_part: "The supply hoses or shut-off valves under the sink" },
    expect: { mustAsk: ["leak_where", "leak_part"], optionsInclude: { leak_where: ["Ceiling", "Toilet"] }, likelySource: "supply" },
  },

  // ── Never re-ask what was said ──
  {
    id: "noreask-timing-location",
    name: "Location and timing in the first message aren't asked again",
    first: "since yesterday the kitchen faucet drips",
    rooms: KITCHEN_ROOMS,
    expect: { neverAsk: ["location_in_unit", "started_when"] },
  },
  {
    id: "noreask-appliance-location",
    name: "Appliance implies its room",
    first: "the dryer is making a loud noise",
    rooms: KITCHEN_ROOMS,
    expect: { neverAsk: ["location_in_unit", "classify_category"] },
  },

  // ── Emergencies route at once ──
  { id: "emerg-gas", name: "Gas smell", first: "I smell gas in the kitchen", rooms: KITCHEN_ROOMS, expect: { emergencyAtTurn: 1 } },
  { id: "emerg-co", name: "CO alarm going off", first: "the carbon monoxide alarm is going off", rooms: KITCHEN_ROOMS, expect: { emergencyAtTurn: 1 } },
  { id: "emerg-sparks", name: "Sparks", first: "the outlet is sparking and smells like burning", rooms: KITCHEN_ROOMS, expect: { emergencyAtTurn: 1 } },
  {
    id: "emerg-water-electrical",
    name: "Leak near a light fixture (answered in the deep-dive)",
    first: "water is leaking from the ceiling",
    rooms: KITCHEN_ROOMS,
    facts: { leak_electrical: "yes, it's dripping onto the light" },
    expect: { emergency: true, mustAsk: ["leak_electrical"] },
  },

  // ── LLM fallback only when rules find nothing ──
  {
    id: "fallback-llm",
    name: "Unknown wording: the model classifies it, no category question",
    first: "the thingamajig is dead",
    rooms: KITCHEN_ROOMS,
    fallback: { category: "appliance", equipment: "range hood" },
    expect: { category: "appliance", equipment: "range hood", noCategoryQuestion: true },
  },
];
