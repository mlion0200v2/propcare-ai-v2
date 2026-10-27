/**
 * Shared emergency detector — the single source of truth for "is this an
 * emergency?" across the triage flow (first message, every follow-up, safety
 * answers, guided troubleshooting replies, summary corrections).
 *
 * Pure, deterministic — no LLM calls. Errs on the side of escalating: a
 * phrase is only ignored when it is clearly negated ("no gas smell") or is a
 * known benign phrase ("smoke detector chirping", "fireplace").
 */

export type EmergencyKind =
  | "gas"
  | "carbon_monoxide"
  | "fire"
  | "electrical"
  | "water_electrical"
  | "sewage"
  | "flooding"
  | "no_heat"
  | "structural"
  | "unconfirmed_safety";

export interface EmergencyMatch {
  kind: EmergencyKind;
  /** The text that triggered the match (for logs and the manager summary). */
  phrase: string;
}

/** FortisBC 24-hour gas emergency line (BC). */
export const FORTISBC_EMERGENCY_PHONE = "1-800-663-9911";

interface Rule {
  kind: EmergencyKind;
  pattern: RegExp;
  /** Ignore the match when it is clearly negated ("no gas smell"). */
  negatable?: boolean;
}

// Order matters only for which `kind` is reported when several match.
const RULES: Rule[] = [
  // ── Gas ──
  { kind: "gas", negatable: true, pattern: /\bgas (leak|leaking|smell|odou?r)s?\b/ },
  { kind: "gas", negatable: true, pattern: /\bsmell(s|ing|ed)?\s+(of\s+|like\s+)?(natural\s+|propane\s+)?gas\b/ },
  { kind: "gas", negatable: true, pattern: /\b(odou?r|scent|whiff)\s+of\s+(natural\s+)?gas\b/ },
  { kind: "gas", negatable: true, pattern: /\b(gas|propane)\s+(is\s+)?(smell|odou?r)/ },
  { kind: "gas", negatable: true, pattern: /\brotten\s+eggs?\b/ },
  { kind: "gas", negatable: true, pattern: /\b(sulph?ur)\s+(smell|odou?r)\b/ },
  { kind: "gas", negatable: true, pattern: /\bhiss\w*\b[^.!?]{0,30}\bgas\b|\bgas\b[^.!?]{0,30}\bhiss\w*/ },
  { kind: "gas", negatable: true, pattern: /\bleaking gas\b/ },

  // ── Carbon monoxide ──
  { kind: "carbon_monoxide", negatable: true, pattern: /\bcarbon monoxide\b(?![^.!?]*\b(chirp\w*|battery)\b)/ },
  // "CO alarm/detector" — any state except a low-battery chirp (handled below).
  { kind: "carbon_monoxide", pattern: /\bco(2)?\s*(alarm|detector|monitor|sensor)s?\b(?![^.!?]*\bchirp)/ },

  // ── Fire / smoke ──
  // \bfire\b does not match "fireplace", "firewood", "firefly"; skip fire-safety
  // equipment and exits, which are maintenance items, not active fires.
  {
    kind: "fire",
    negatable: true,
    pattern: /\bfire\b(?!\s*(exit|escape|door|extinguisher|inspection|code|hydrant|drill|safety|alarm test|alarms?\b(?=[^.!?]{0,40}\b(chirp\w*|beep\w*|battery)\b)))/,
  },
  { kind: "fire", negatable: true, pattern: /\b(flames?|on fire|caught fire|burning up)\b/ },
  // Smoke, but not "smoke detector/alarm" (chirping detectors are battery issues).
  { kind: "fire", negatable: true, pattern: /\bsmok(e|ing|y)\b(?!\s*(detect\w*|alarm|alrm))/ },
  // A smoke alarm actually sounding is treated as a possible fire.
  {
    kind: "fire",
    // …unless it's the low-battery chirp ("battery chirp won't stop").
    pattern: /\bsmoke\s*(detector|alarm)s?\b(?![^.!?]*\b(chirp\w*|batter(y|ies))\b)[^.!?]{0,25}\b(going off|went off|sounding|blaring|won'?t stop|keeps going off|alarming)\b/,
  },
  { kind: "fire", negatable: true, pattern: /\b(burning|burnt|burned)\s+(smell|odou?r|plastic|rubber|wires?|wiring)\b|\bsmell(s|ing)?\s+(of\s+|like\s+)?(something\s+)?(burning|burnt|burned)\b/ },

  // ── Electrical ──
  { kind: "electrical", negatable: true, pattern: /\bspark(s|ing|ed|y)?\b/ },
  { kind: "electrical", negatable: true, pattern: /\b(exposed|bare|live|frayed)\s+wir(e|es|ing)\b/ },
  { kind: "electrical", negatable: true, pattern: /\b(got|getting|been)\s+(shocked|zapped|electrocuted)\b|\belectric(al)?\s+shock\b|\belectrocut/ },
  { kind: "electrical", negatable: true, pattern: /\b(outlet|socket|panel|switch|plug)\b[^.!?]{0,30}\b(melt(ed|ing)?|scorch(ed)?|charred|smoking)\b/ },

  // ── Water + electricity ──
  {
    kind: "water_electrical",
    pattern:
      /\b(water|leak\w*|drip\w*|flood\w*)\b[^.!?]{0,30}\b(through|from|out of|into|in|inside|near|around|onto|on|behind|over)\s+(the\s+|a\s+|my\s+|our\s+)?(ceiling\s+)?(?<!pilot\s)(light|lights|light fixture|pot ?lights?|outlets?|sockets?|electrical panel|breaker (panel|box)|wiring|wires|switch(es)?)\b/,
  },
  {
    kind: "water_electrical",
    pattern:
      /(?<!pilot\s)\b(ceiling light|light fixture|pot ?lights?|outlets?|sockets?|electrical panel|breaker (panel|box)|wiring)\b[^.!?]{0,20}\b(is |are )?(leaking|dripping|wet|full of water|filling with water)\b/,
  },

  // ── Sewage ──
  // Sewage itself, but not just a smell of it ("smells like sewage" is a drain smell).
  { kind: "sewage", pattern: /(?<!\bsmells?\s(?:like\s|of\s)?)\bsewage\b/ },
  { kind: "sewage", pattern: /\bsewer\b[^.!?]{0,30}\bback(ing|ed|s)?[\s-]?up\b|\bback(ing|ed|s)?[\s-]?up\b[^.!?]{0,30}\bsewer\b|\bsewer\s+back[\s-]?up\b/ },
  {
    kind: "sewage",
    pattern: /\btoilet\b[^.!?]{0,40}\boverflow\w*\b[^.!?]{0,30}\b(floor|floors|everywhere|carpet|hallway|bathroom)\b/,
  },
  { kind: "sewage", pattern: /\b(toilet|drain)s?\b[^.!?]{0,30}\bback(ing|ed)?\s+up\b[^.!?]{0,30}\b(tub|shower|sink|floor)\b/ },

  // ── Flooding ──
  { kind: "flooding", pattern: /\b(burst|ruptured|split)\s+(water\s+|supply\s+)?(pipe|line|hose)\b|\bpipe\b[^.!?]{0,15}\b(burst|ruptured|exploded|broke)\b/ },
  { kind: "flooding", pattern: /\bwater\b[^.!?]{0,20}\b(pouring|gushing|spraying|flooding)\b|\b(pouring|gushing|spraying)\b[^.!?]{0,20}\bwater\b/ },
  { kind: "flooding", pattern: /\bwater everywhere\b|\bwater main break\b/ },

  // ── Structural ──
  { kind: "structural", pattern: /\b(collaps(e|ed|ing)|caving in|caved in)\b/ },
  { kind: "structural", pattern: /\bceiling\b[^.!?]{0,20}\b(fell|fallen|falling|came down|coming down)\b/ },
];

// "No heat" — an emergency in the cold months (BC primary-heat outage).
const NO_HEAT_PATTERN =
  /\b(no heat|no heating|without heat|heat(ing)?\s+(is\s+|has\s+|went\s+|stopped\s+)?(out|off|not working|isn'?t working|stopped working|broken|dead)|furnace\s+(is\s+|has\s+|went\s+)?(out|off|not working|isn'?t working|stopped working|broken|dead)|(furnace|heater|heating|boiler|radiators?)\s+(won'?t|will not|doesn'?t|does not)\s+(turn on|come on|work|start|heat))\b/;
const WINTER_CONTEXT_PATTERN =
  /\b(winter|freezing|below (zero|freezing)|sub-?zero|snow\w*|frost\w*|icy|minus \d+|-\d+\s*°?\s*c|really cold|so cold|very cold|cold outside|ice)\b/;
const SUMMER_CONTEXT_PATTERN = /\b(summer|heat ?wave|hot outside|july|august)\b/;
/** Cold months in BC: November–March (0-based months). */
const COLD_MONTHS = new Set([10, 11, 0, 1, 2]);

// A negation shortly before the match, e.g. "no gas smell", "don't smell gas".
const NEGATION_BEFORE = /\b(no|not|never|without|don'?t|do not|doesn'?t|does not|didn'?t|did not|isn'?t|is not|aren'?t|wasn'?t|haven'?t|hasn'?t|nothing|none|zero)\b[^.!?,;]{0,20}$/;
// …unless the tenant is unsure ("not sure if I smell gas") — then escalate.
const UNCERTAINTY = /\b(sure|certain|know|tell|think|maybe|might|possibly|probably|unsure)\b/;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isNegated(text: string, matchIndex: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  if (!NEGATION_BEFORE.test(before)) return false;
  // Uncertainty anywhere in the same clause beats the negation.
  const clauseStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"));
  return !UNCERTAINTY.test(before.slice(clauseStart + 1));
}

/**
 * Detect an emergency in free text from the tenant.
 *
 * @param now used for the "no heat in winter" rule (defaults to the current date).
 */
export function detectEmergency(text: string, now: Date = new Date()): EmergencyMatch | null {
  if (!text) return null;
  const lower = normalise(text);

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      if (!(rule.negatable && isNegated(lower, m.index))) {
        return { kind: rule.kind, phrase: m[0] };
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  const noHeat = NO_HEAT_PATTERN.exec(lower);
  if (noHeat && !isNegated(lower, noHeat.index)) {
    const explicitWinter = WINTER_CONTEXT_PATTERN.test(lower);
    const explicitSummer = SUMMER_CONTEXT_PATTERN.test(lower);
    if (explicitWinter || (!explicitSummer && COLD_MONTHS.has(now.getMonth()))) {
      return { kind: "no_heat", phrase: noHeat[0] };
    }
  }

  return null;
}

/** Back-compat boolean wrapper used across the triage code. */
export function hasEmergencyKeywords(text: string, now?: Date): boolean {
  return detectEmergency(text, now) !== null;
}

// ── Answers to a targeted safety question ──

export type SafetyAnswer = "concern" | "no_concern" | "unclear";

const UNSURE_ANSWER =
  /\b(not sure|unsure|don'?t know|do not know|dunno|idk|no idea|maybe|might|possibly|perhaps|i think so|i guess|kind of|sort of|a little|a bit|slightly|hard to tell|can'?t tell|cannot tell|not certain|hmm+)\b|\?/;
const YES_ANSWER = /\b(yes|yeah|yep|yup|y|true|definitely|absolutely|for sure|it is|there is|there are|i do|i can)\b/;
const NO_ANSWER =
  /^(no|nope|nah|n|none|nothing|not really|not at all|negative|all good|it'?s fine|its fine|it is fine|everything'?s fine|no concerns?)\b/;
const CONCERN_WORDS =
  /\b(sparks?|smoke|smoking|burning|smell\w*|odou?r|hot|warm|melt\w*|spreading|getting worse|worse|unstable|exposed|flood\w*|leak\w*|crack\w*|sag\w*|shock\w*)\b/g;
const NEGATIVE_STATEMENT = /\b(isn'?t|is not|aren'?t|doesn'?t|does not|don'?t|do not|didn'?t|haven'?t|hasn'?t|not|no|none|nothing|nope)\b/;

/**
 * Classify a reply to a targeted safety question ("Do you notice any sparks…?").
 * Only a clear, unhedged "no" counts as no concern — anything unclear is
 * escalated, never cleared.
 */
export function classifySafetyAnswer(response: string, now?: Date): SafetyAnswer {
  const lower = normalise(response);
  if (!lower) return "unclear";

  if (detectEmergency(lower, now)) return "concern";
  if (UNSURE_ANSWER.test(lower)) return "unclear";

  if (NO_ANSWER.test(lower)) {
    // "No, but it smells a bit" / "no... actually yes" → not a clean no.
    if (/\b(but|although|except|actually|though)\b/.test(lower)) return "unclear";
    return "no_concern";
  }
  if (YES_ANSWER.test(lower)) return "concern";

  // Concern words count unless every one of them is negated ("it's not spreading").
  const concernMatches = [...lower.matchAll(CONCERN_WORDS)];
  if (concernMatches.some((m) => !isNegated(lower, m.index ?? 0))) return "concern";
  if (NEGATIVE_STATEMENT.test(lower)) return "no_concern";
  return "unclear";
}

// ── Emergency reply (sent immediately, in any state) ──

const KIND_GUIDANCE: Record<EmergencyKind, string[]> = {
  gas: [
    "**Leave the unit now** and take everyone (and pets) with you. Leave the door open behind you if you can.",
    "Do NOT flip light switches, unplug anything, use your phone, or light anything until you are outside.",
    `Once you are outside, call the **FortisBC gas emergency line at ${FORTISBC_EMERGENCY_PHONE}** (24 hours). If anyone feels unwell, call **911**.`,
  ],
  carbon_monoxide: [
    "**Leave the unit now** and get everyone (and pets) into fresh air. Do not stay to open windows.",
    "Once you are outside, call **911**, especially if anyone has a headache, dizziness, nausea or feels sleepy.",
    `Then call the **FortisBC gas emergency line at ${FORTISBC_EMERGENCY_PHONE}** — gas appliances are a common cause.`,
  ],
  fire: [
    "If there is fire, smoke or a burning smell you can't explain, **leave the unit now** and close the door behind you.",
    "Once you are outside, call **911**. Do not go back in for belongings.",
  ],
  electrical: [
    "**Stay away** from the outlet, switch, panel or appliance. Do not touch it, unplug it, or reset breakers.",
    "If you see smoke or flames or smell burning, **leave the unit now** and call **911** from outside.",
  ],
  water_electrical: [
    "**Stay away** from the wet light, outlet or wiring. Do not touch switches or the electrical panel, and keep out of standing water near it.",
    "If you see sparks or smoke, or smell burning, **leave the unit now** and call **911** from outside.",
  ],
  sewage: [
    "**Keep everyone out of the affected area** and stop using the toilets, sinks, shower and washer until we say it is safe.",
    "Avoid touching the water — sewage can make you sick. Keep children and pets away.",
  ],
  flooding: [
    "**Keep away** from the water if it is near outlets, appliances or wiring.",
    "Only if you can reach it safely without standing in water: turn off the fixture's water shut-off. Don't take any risks to do this.",
  ],
  no_heat: [
    "Keep warm: close windows and doors, wear layers and use blankets. Do NOT use the oven, stove or a barbecue to heat your home.",
    "If anyone in your home is vulnerable to cold (infants, seniors, health conditions) or it becomes unsafe, go somewhere warm.",
  ],
  structural: [
    "**Leave the affected area now** and keep everyone away from it. If the building itself feels unsafe, leave the unit.",
    "If anyone is hurt or trapped, call **911**.",
  ],
  unconfirmed_safety: [
    "Because I couldn't confirm that things are safe, I'm treating this as urgent.",
    "If anything gets worse, keep away from the area and leave the unit if you feel unsafe.",
  ],
};

/** The leave-now / FortisBC / 911 footer every emergency reply ends with. */
export const EMERGENCY_FOOTER = [
  `- Smell gas or rotten eggs? **Leave now**, then call **FortisBC ${FORTISBC_EMERGENCY_PHONE}** from outside.`,
  "- Fire, smoke, carbon monoxide alarm, or anyone hurt or unwell? **Leave now** and call **911**.",
].join("\n");

/**
 * Build the reply sent the moment an emergency is detected. Troubleshooting
 * stops here: no further steps or questions are asked.
 */
export function buildEmergencyReply(kind: EmergencyKind, managerNotified: boolean): string {
  return [emergencyAdvice(kind), "", emergencyNotice(managerNotified)].join("\n");
}

/** Safety advice for this kind of emergency: the assistant's part of the reply. */
export function emergencyAdvice(kind: EmergencyKind): string {
  return ["**This may be an emergency — your safety comes first.**", "", ...KIND_GUIDANCE[kind].map((line) => `- ${line}`), "", EMERGENCY_FOOTER].join("\n");
}

/** Whether the manager was reached: the app's part (only it sends the alert). */
export function emergencyNotice(managerNotified: boolean): string {
  return [
    managerNotified
      ? "I've alerted your property manager right now and marked this as an emergency. You don't need to do anything else in this chat."
      : "I've marked this as an emergency for your property manager. If you can't reach them and it's urgent, use the emergency numbers above.",
    "",
    "If it's safe, you can reply here with anything else they should know (for example, the best number to reach you).",
  ].join("\n");
}

/** Reply to any further message once a ticket is already in the emergency state. */
export function buildEmergencyFollowUpReply(): string {
  return [
    "Thanks — I've added that to your emergency report for your property manager.",
    "",
    EMERGENCY_FOOTER,
  ].join("\n");
}
