/**
 * Phase 2A — Fallback SOP templates (hardcoded)
 *
 * Returns category-specific troubleshooting steps when Pinecone
 * retrieval is empty or unavailable. Phase 2B will add real RAG.
 */

import type { TroubleshootingStep } from "./types";

interface SOPResult {
  steps: TroubleshootingStep[];
  display: string;
}

// ── Step data per category ──

const SOP_STEPS: Record<string, string[]> = {
  plumbing: [
    "If there's a leak, locate the shut-off valve for the affected fixture and turn it off.",
    "Place a bucket or towels under the leak to prevent water damage.",
    "Check if the issue is with a single fixture or multiple (this helps narrow the cause).",
    "Do NOT use chemical drain cleaners — they can damage pipes.",
    "Take a photo of the issue if possible.",
  ],
  electrical: [
    "Do NOT touch exposed wires or attempt electrical repairs yourself.",
    "If an outlet isn't working, check if the breaker has tripped in your breaker panel.",
    "If a breaker keeps tripping, unplug all devices from that circuit.",
    "If you smell burning or see sparks, turn off the breaker and contact management immediately.",
    "Use flashlights (not candles) if power is out.",
  ],
  hvac: [
    "Check your thermostat settings and replace batteries if applicable.",
    "Make sure air vents are open and not blocked by furniture.",
    "Check and replace the air filter if it looks dirty.",
    "If the system is making unusual noises, turn it off and report to management.",
    "If you have no heat in freezing temperatures, this is urgent — contact management immediately.",
  ],
  appliance: [
    "Check that the appliance is plugged in and the outlet is working.",
    "Check for tripped breakers in your electrical panel.",
    "For refrigerators: check temperature settings and ensure the door seal is intact.",
    "For dishwashers/washers: check for kinks in hoses or clogged filters.",
    "Do NOT attempt to repair gas appliances yourself.",
  ],
  structural: [
    "Take photos of any cracks, damage, or areas of concern.",
    "If there are ceiling cracks with water stains, there may be a leak above — report urgently.",
    "Do not hang heavy items on damaged walls.",
    "If a door or window won't close properly, note whether it's recent (may indicate settling).",
    "For any signs of structural instability (sagging floors, leaning walls), evacuate and report immediately.",
  ],
  pest_control: [
    "Note what type of pest you've seen and where (location, time of day).",
    "Store food in sealed containers and keep counters clean.",
    "Seal any visible gaps around pipes, doors, or windows with temporary caulk.",
    "Do NOT use foggers/bug bombs in apartments — they spread pests to neighbors.",
    "Take photos if possible to help identify the pest.",
  ],
  locksmith: [
    "If locked out, contact your property management before calling a locksmith.",
    "Do NOT attempt to force open locks — this can cause expensive damage.",
    "If a lock is broken or a key is stuck, try lubricant (WD-40) gently.",
    "If you feel your unit security is compromised, report immediately.",
  ],
  roofing: [
    "Place buckets under any active drips and move belongings away from the area.",
    "Take photos of water stains, drips, or visible roof damage.",
    "Do NOT go on the roof yourself.",
    "If water is near electrical fixtures, turn off the breaker for that area.",
  ],
  painting: [
    "Note areas with peeling, bubbling, or staining paint.",
    "If paint is peeling in large chips (older building), do NOT sand it — it may contain lead.",
    "Take photos of the affected areas.",
    "For minor wall marks, try a damp cloth with mild soap before requesting a repaint.",
  ],
  flooring: [
    "Take photos of any damaged, loose, or warped flooring.",
    "If flooring is wet or buckled, check for a leak source underneath.",
    "Avoid placing heavy furniture on damaged areas to prevent further damage.",
    "If carpet is torn, tape the edge down to prevent a tripping hazard.",
  ],
  landscaping: [
    "Note the specific area and what needs attention.",
    "If a tree or branch poses a safety risk, report as urgent.",
    "Take photos of the issue.",
  ],
  general: [
    "Describe the issue in as much detail as possible.",
    "Take photos if applicable.",
    "Note when the issue started and any changes you've observed.",
    "If you're unsure of the category, your property manager will review and assign it.",
  ],
  other: [
    "Describe the issue in as much detail as possible.",
    "Take photos if applicable.",
    "Your property manager will review and determine the best course of action.",
  ],
};

const EMERGENCY_PREFIX_STEPS: string[] = [
  "If you smell gas, leave the unit immediately and call 911.",
  "If there's flooding, turn off the water main if you can safely reach it.",
  "If there's a fire or smoke, evacuate and call 911.",
  "Do NOT re-enter the unit until cleared by emergency services.",
];

// ── Public API ──

export function getFallbackSOP(
  category: string,
  isEmergency: boolean
): SOPResult {
  const categorySteps = SOP_STEPS[category] ?? SOP_STEPS.general;
  const allDescriptions = isEmergency
    ? [...EMERGENCY_PREFIX_STEPS, "---", ...categorySteps]
    : categorySteps;

  const steps: TroubleshootingStep[] = allDescriptions
    .filter((d) => d !== "---")
    .map((description, i) => ({
      step: i + 1,
      description,
      completed: false,
    }));

  const display = isEmergency
    ? [
        "**IMMEDIATE ACTIONS:**",
        ...EMERGENCY_PREFIX_STEPS.map((s, i) => `${i + 1}. ${s}`),
        "",
        "---",
        "",
        "**Troubleshooting Steps:**",
        ...categorySteps.map(
          (s, i) => `${EMERGENCY_PREFIX_STEPS.length + i + 1}. ${s}`
        ),
      ].join("\n")
    : [
        "**Troubleshooting Steps:**",
        ...categorySteps.map((s, i) => `${i + 1}. ${s}`),
      ].join("\n");

  return { steps, display };
}
