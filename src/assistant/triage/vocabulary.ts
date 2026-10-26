/**
 * Tenant vocabulary → canonical words, applied before classification and
 * extraction. One table, so "rangehood", "range-hood", "hood fan" and
 * "stove fan" all reach the rules as "range hood".
 *
 * Variants are written with spaces; each one also matches its joined and
 * hyphenated forms ("dish washer" ↔ "dishwasher" ↔ "dish-washer").
 */

interface VocabularyEntry {
  canonical: string;
  variants: string[];
  /** Only when the message also matches this (e.g. "exhaust fan" in a kitchen). */
  when?: RegExp;
  unless?: RegExp;
}

const VOCABULARY: VocabularyEntry[] = [
  { canonical: "range hood", variants: ["range hood", "hood fan", "stove fan", "stove hood", "oven hood", "oven fan", "vent hood", "exhaust hood", "cooker hood", "kitchen fan", "kitchen exhaust fan", "kitchen exhaust", "range fan", "hood vent"] },
  { canonical: "range hood", variants: ["exhaust fan", "extractor fan", "extractor"], when: /\b(kitchen|stove|oven|cook|cooking|range|grease|oil)\b/i },
  { canonical: "bathroom fan", variants: ["bathroom fan", "bath fan", "bathroom exhaust fan", "bathroom vent fan", "fan in the bathroom"] },
  { canonical: "bathroom fan", variants: ["exhaust fan", "extractor fan", "vent fan"], when: /\b(bathroom|washroom|ensuite|shower|bath)\b/i },
  { canonical: "dishwasher", variants: ["dish washer"] },
  { canonical: "refrigerator", variants: ["refridgerator", "refrigirator", "refrigerater", "frig"] },
  { canonical: "washing machine", variants: ["washing machine", "clothes washer", "laundry machine", "washer machine"] },
  { canonical: "dryer", variants: ["clothes dryer", "tumble dryer", "drier"] },
  { canonical: "microwave", variants: ["micro wave"] },
  { canonical: "garbage disposal", variants: ["garburator", "garberator", "garborator", "garbage disposer", "garbage disposal", "insinkerator", "in sink erator", "food disposal"] },
  { canonical: "garbage disposal", variants: ["disposal"], unless: /\bgarbage disposal\b/i },
  { canonical: "water heater", variants: ["hot water tank", "hot water heater", "hot water tanks", "hwt"] },
  { canonical: "baseboard heater", variants: ["baseboard heater", "baseboard heaters", "baseboard heat", "wall heater"] },
  { canonical: "thermostat", variants: ["thermo stat", "temperature control"] },
  { canonical: "smoke alarm", variants: ["smoke detector", "smoke detectors", "fire alarm", "smoke alarms"] },
  { canonical: "carbon monoxide alarm", variants: ["carbon monoxide detector", "co detector", "co alarm", "co2 detector"] },
  { canonical: "outlet", variants: ["gfci", "gfi", "gfci outlet", "gfi outlet", "receptacle", "power outlet", "wall plug", "electrical plug", "socket"] },
  { canonical: "outlet", variants: ["plug"], unless: /\b(sink|tub|bath|drain|toilet|stopper|plugged)\b/i },
  { canonical: "faucet", variants: ["tap", "taps", "faucets", "spigot"], unless: /\btap water\b/i },
  { canonical: "toilet", variants: ["loo", "commode", "toliet", "toilette"] },
  { canonical: "clogged", variants: ["plugged up", "plugged"], unless: /\bplugged in\b/i },
];

function variantPattern(variant: string): RegExp {
  // Spaces in a variant also match "", "-" and multiple spaces.
  const body = variant
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s-]*");
  return new RegExp(`\\b${body}\\b`, "gi");
}

const COMPILED = VOCABULARY.flatMap((entry) =>
  // Longest variants first so "kitchen exhaust fan" wins over "exhaust fan".
  [...entry.variants]
    .sort((a, b) => b.length - a.length)
    .map((v) => ({ ...entry, pattern: variantPattern(v), variant: v }))
);

/** Rewrite tenant wording to canonical words ("my rangehood" → "my range hood"). */
export function normalizeVocabulary(text: string): string {
  let out = text;
  for (const { canonical, pattern, when, unless } of COMPILED) {
    if (when && !when.test(out)) continue;
    if (unless && unless.test(out)) continue;
    out = out.replace(pattern, (match) => (match.toLowerCase() === canonical ? match : canonical));
  }
  return out;
}
