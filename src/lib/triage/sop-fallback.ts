/**
 * Phase 2A — Fallback SOP templates (hardcoded)
 *
 * Returns category-specific troubleshooting steps when Pinecone
 * retrieval is empty or unavailable. Phase 2B will add real RAG.
 */

import type { TroubleshootingStep } from "./types";
import { getCanonicalEquipment } from "./extract-details";

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
  plumbing_leak: [
    "Locate the shut-off valve for the affected fixture and turn it off to stop the water flow.",
    "Place a bucket or towels under the leak to prevent water damage to floors and cabinets.",
    "Check if the leak is coming from a pipe connection, faucet, or fixture base.",
    "Check if the issue is with a single fixture or multiple (this helps narrow the cause).",
    "Take a photo of the leak and any water damage for your property manager.",
  ],
  plumbing_clog: [
    "Try using a plunger — place it over the drain opening and pump firmly 10–15 times.",
    "Do NOT use chemical drain cleaners — they can damage pipes and are harmful if they splash.",
    "Try pouring a pot of hot (not boiling) water slowly down the drain to loosen the blockage.",
    "Check if other drains in your unit are also slow — if so, it may be a main line issue.",
    "Take a photo of the affected drain and note which fixtures are affected.",
  ],
  plumbing_broken_fixture: [
    "Do not force the broken fixture — forcing a stuck handle or knob can cause further damage or a leak.",
    "If the fixture is leaking as a result, locate the shut-off valve underneath and turn it off.",
    "Avoid using the affected fixture until it can be repaired.",
    "Take a photo of the broken part so maintenance can bring the right replacement.",
  ],
  plumbing_running_toilet: [
    "Try jiggling the flush handle — sometimes the flapper chain gets caught and won't seal.",
    "Lift the tank lid and check if the flapper (rubber seal at the bottom) is seated properly.",
    "If the toilet keeps running non-stop, locate the shut-off valve behind the toilet and turn it clockwise to stop the water.",
    "Note how long the toilet has been running and whether it runs constantly or intermittently.",
  ],
  plumbing_no_hot_water: [
    "Check your water heater's thermostat — it should be set between 120°F and 140°F.",
    "Check your electrical panel for a tripped breaker labeled 'water heater' and reset it if needed.",
    "For gas water heaters, check if the pilot light is lit (refer to the instructions on the unit).",
    "Run hot water at another faucet to see if the issue is throughout the unit or just one fixture.",
    "Note how long you've been without hot water and whether it happened suddenly or gradually.",
  ],
  plumbing_water_pressure: [
    "Check that the main shut-off valve and any fixture shut-off valves are fully open.",
    "If the issue is at one faucet, unscrew the aerator (tip of the faucet) and rinse out any debris.",
    "Ask a neighbor if they're experiencing the same issue — it could be a building or city water issue.",
    "Note which fixtures are affected and whether the problem is with hot water, cold water, or both.",
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
  // Equipment-specific appliance SOPs (looked up by equipment name)
  "appliance:range hood": [
    "Check the grease filter — if it's clogged with oil or grease, that's likely causing the drip.",
    "Remove the grease filter(s) and soak them in hot water with dish soap or a degreaser for 10–15 minutes.",
    "Wipe down the inside of the hood with a cloth dampened with degreaser.",
    "Check whether the exhaust duct or vent above the hood is blocked or leaking grease.",
    "Take a photo of the area where oil is dripping so maintenance can assess.",
  ],
  "appliance:refrigerator": [
    "Check that the refrigerator is plugged in and the outlet is working.",
    "Check the temperature settings — they may have been bumped.",
    "Make sure the door seal (gasket) is clean and sealing tightly.",
    "Check for ice buildup in the freezer — if excessive, try defrosting.",
    "Take a photo of any visible issues (ice buildup, leaks, temperature display).",
  ],
  "appliance:dishwasher": [
    "Make sure the dishwasher door is latching properly — it won't run if it's not closed.",
    "Check for kinks in the water supply or drain hose behind the dishwasher.",
    "Clean the filter at the bottom of the dishwasher tub (often a twist-out screen).",
    "Run an empty cycle with dishwasher cleaner or a cup of white vinegar.",
    "Take a photo of any error codes or visible issues.",
  ],
  "appliance:oven": [
    "Make sure the oven is plugged in (electric) or the gas valve is open (gas).",
    "Check if the clock/display shows an error code.",
    "For electric ovens: check that the heating element is not visibly damaged or broken.",
    "For gas stoves: make sure the burner cap is properly centered on the base.",
    "Gently clean around the igniter and burner ports with a dry cloth to remove food debris or grease.",
    "Do NOT attempt to repair gas oven connections yourself — report gas smell immediately.",
    "Take a photo of any visible damage or error codes.",
  ],
  "appliance:microwave": [
    "Check that the microwave is plugged in and the outlet is working.",
    "Try a different outlet to rule out a dead circuit.",
    "Check if the turntable is seated properly.",
    "If sparking, stop use immediately and unplug.",
    "Take a photo of any visible damage or error codes.",
  ],
  "appliance:washer": [
    "Check that the washer is plugged in and the outlet is working.",
    "Make sure both the hot and cold water supply valves are open.",
    "Check for kinks in the water supply hoses.",
    "If leaking, check the door seal (front-loader) or lid switch (top-loader).",
    "Take a photo of any visible leaks or error codes.",
  ],
  "appliance:dryer": [
    "Check that the dryer is plugged in and the outlet is working.",
    "Clean the lint filter — a clogged filter reduces performance and is a fire hazard.",
    "Check that the dryer vent hose is connected and not kinked or blocked.",
    "If the dryer gets very hot or smells like burning, stop and unplug immediately.",
    "Take a photo of any visible issues.",
  ],
  "appliance:garbage disposal": [
    "Make sure the disposal is plugged in or the switch is on.",
    "If it hums but doesn't spin, it's likely jammed — turn it off and unplug before checking.",
    "Use the hex key (Allen wrench) in the bottom of the unit to manually rotate the blades.",
    "Press the reset button on the bottom of the disposal unit.",
    "Do NOT put your hand inside the disposal.",
  ],
  // ── Symptom-specific appliance SOPs ──
  "appliance:refrigerator:noise": [
    "Check if the fridge is level — place a level on top or see if it rocks when nudged. Adjust the front feet until stable.",
    "Pull the fridge out slightly and ensure there's 1–2 inches of clearance from the wall on all sides.",
    "Open the fridge and check for loose shelves, bins, or items that could be vibrating.",
    "Check the base grille (bottom front) — remove it and clear any dust or debris around the drain pan and compressor area.",
    "Listen to whether the sound changes when the compressor kicks on/off — a loud hum from the back is usually compressor-related.",
  ],
  "appliance:refrigerator:leak": [
    "Check if the fridge is level — water can pool and leak from a tilted unit.",
    "Pull the fridge out and inspect the water line connection (if it has an ice maker or water dispenser).",
    "Check the drain pan under the fridge — it may be full or cracked.",
    "Look inside the freezer for excessive ice buildup blocking the defrost drain.",
    "Take a photo of where the water is coming from.",
  ],
  appliance_noise: [
    "Check if the appliance is sitting level on the floor — uneven footing causes vibration.",
    "Ensure the appliance has clearance from walls and cabinets (vibrations transfer to surfaces).",
    "Check for any loose parts, trays, or accessories inside or on top of the appliance.",
    "Listen to whether the noise is constant or only happens at certain times (e.g., during a cycle).",
    "Take a short video of the noise if possible — it helps maintenance diagnose remotely.",
  ],
  // ── Symptom-specific HVAC SOPs ──
  hvac_noise: [
    "Check if the air filter is dirty or clogged — a dirty filter makes the system work harder and louder.",
    "Make sure all vents and registers are open and not blocked by furniture or curtains.",
    "Listen for where the noise is coming from — the indoor unit, outdoor unit, or ductwork.",
    "If the noise is a rattling or buzzing from a vent, the register cover may be loose — tighten the screws.",
    "Turn the system off and on again — if the noise stops temporarily then returns, note when it restarts.",
  ],
  structural: [
    "Take photos of any cracks, damage, or areas of concern.",
    "If there are ceiling cracks with water stains, there may be a leak above — report urgently.",
    "Do not hang heavy items on damaged walls.",
    "If a door or window won't close properly, note whether it's recent (may indicate settling).",
    "For any signs of structural instability (sagging floors, leaning walls), evacuate and report immediately.",
  ],
  structural_window: [
    "Check if the screen is simply popped out of the frame — gently press the edges back into the track or channel.",
    "Inspect the screen's rubber spline (the thin cord holding the screen in the frame) for damage or gaps.",
    "If the screen is torn or the spline is missing, avoid removing it further — note the window size and location for maintenance.",
    "Make sure the window locks and latches still function properly.",
    "Take a photo of the screen and frame so maintenance can bring the correct replacement parts.",
  ],
  structural_fixture: [
    "Do not try to force the fixture back into place — it may cause further damage to the wall or drywall.",
    "If the fixture is dangling or at risk of falling, carefully remove it and set it aside to avoid injury.",
    "Check if the mounting hardware (screws, anchors, brackets) is still intact or if it pulled out of the wall.",
    "Take a photo of the mounting area and the fixture so maintenance can bring the right hardware.",
  ],
  structural_mold: [
    "Improve ventilation in the affected area — open windows or use a fan to circulate air.",
    "Remove any damp or wet items (bags, clothes, shoes) from the area and let them dry completely.",
    "For small patches of surface mold (less than about 3 feet by 3 feet), wipe with a cloth dampened with soapy water — wear gloves if you have them.",
    "Check for a source of moisture — condensation on windows, damp walls, or signs of a leak — and note it for your property manager.",
    "Do NOT use bleach in an enclosed space without ventilation.",
  ],
  pest_control: [
    "Note what type of pest you've seen and where (location, time of day).",
    "Store food in sealed containers and keep counters clean.",
    "Note any visible gaps or openings where pests may be entering — your property manager will arrange sealing.",
    "Do NOT use foggers/bug bombs in apartments — they spread pests to neighbors.",
    "Take photos if possible to help identify the pest.",
  ],
  pest_insects: [
    "Keep counters, sinks, and floors clean — even small crumbs attract insects.",
    "Store all food (including pet food) in sealed containers.",
    "Place bait traps near areas where you've seen activity (corners, under sinks).",
    "Note any visible gaps around pipes, baseboards, or doorframes where insects may be entering — your property manager will arrange sealing.",
    "Take photos of the insects and where you've seen them to help identify the species.",
  ],
  pest_rodents: [
    "Check for droppings, gnaw marks, or nesting material near walls, cabinets, and food storage.",
    "Store all food (including pet food) in sealed hard containers — rodents can chew through bags.",
    "Place snap traps along walls where you've noticed activity (NOT glue traps — they're inhumane and ineffective for larger rodents).",
    "Note any visible holes or gaps larger than a quarter-inch — your property manager will arrange professional sealing.",
    "Take photos of any droppings, damage, or entry points you find.",
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
  landscaping_water_pooling: [
    "Check if the puddle is near a sprinkler head, hose bib, or irrigation line — a broken head or connection can cause pooling.",
    "Look for any muddy or unusually soft/squishy patches in the soil nearby — this can indicate a slow underground leak.",
    "Note whether the puddle grows or shrinks throughout the day — if it grows without rain, water is likely coming from a pipe or irrigation source.",
    "Check if a downspout or gutter is directing water to that spot — it may just need an extender or splash block.",
    "Take a photo showing the puddle and surrounding area, and note approximately how large it is.",
  ],
  landscaping_tree_hazard: [
    "Do NOT attempt to cut or remove the branch yourself — especially near power lines or structures.",
    "If the tree or branch is blocking a path, doorway, or parking area, avoid the area until it's addressed.",
    "Note whether the tree appears diseased (unusual leaf loss, fungus, or leaning).",
    "Take a photo of the hazard from a safe distance so maintenance can assess priority.",
  ],
  landscaping_irrigation: [
    "Check if a specific sprinkler head is broken, tilted, or spraying in the wrong direction.",
    "Note which zone or area of the yard is affected (front, back, side, specific bed).",
    "If there's flooding from the irrigation, look for the zone shut-off valve and turn it off if accessible.",
    "Note the time of day the irrigation runs and whether the issue happens every cycle.",
    "Take a photo of the affected sprinkler head or flooded area.",
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
  "If you smell gas, leave the unit immediately and contact the FortisBC gas emergency line.",
  "If there's flooding, turn off the main water valve if it is safe to do so.",
  "If there's a fire or smoke, evacuate and call 911.",
  "Do NOT re-enter the unit until cleared by emergency services or your property manager.",
];

// ── Public API ──

const INSECT_SPECIES = ["ants", "cockroaches", "bedbugs", "termites"];
const RODENT_SPECIES = ["rats", "mice"];

export function getFallbackSOP(
  category: string,
  isEmergency: boolean,
  subcategory?: string | null,
  equipment?: string | null,
  symptom?: string | null
): SOPResult {
  let lookupKey = category;
  if (category === "pest_control" && subcategory) {
    if (INSECT_SPECIES.includes(subcategory)) {
      lookupKey = "pest_insects";
    } else if (RODENT_SPECIES.includes(subcategory)) {
      lookupKey = "pest_rodents";
    }
  }
  // Mold-specific SOP: structural + mold/mildew/fungus/musty subcategory
  const MOLD_TERMS = ["mold", "mildew", "fungus", "musty"];
  if (category === "structural" && subcategory && MOLD_TERMS.includes(subcategory)) {
    lookupKey = "structural_mold";
  }
  // Window-specific SOP: structural + window subcategory
  if (category === "structural" && subcategory === "window") {
    lookupKey = "structural_window";
  }
  // Fixture-specific SOP: structural + fixture subcategory
  if (category === "structural" && subcategory === "fixture") {
    lookupKey = "structural_fixture";
  }
  // Plumbing-specific SOP: plumbing + problem type subcategory
  const PLUMBING_SUBTYPES = ["leak", "clog", "broken_fixture", "running_toilet", "no_hot_water", "water_pressure"];
  if (category === "plumbing" && subcategory && PLUMBING_SUBTYPES.includes(subcategory)) {
    lookupKey = `plumbing_${subcategory}`;
  }
  // Landscaping-specific SOP: landscaping + problem type subcategory
  const LANDSCAPING_SUBTYPES = ["water_pooling", "tree_hazard", "irrigation"];
  if (category === "landscaping" && subcategory && LANDSCAPING_SUBTYPES.includes(subcategory)) {
    lookupKey = `landscaping_${subcategory}`;
  }
  // Equipment-specific SOP: e.g. "appliance:range hood"
  // Resolve aliases so "stove" → "oven" → "appliance:oven"
  if (equipment) {
    const canonical = getCanonicalEquipment(equipment);
    const equipmentKey = `${category}:${canonical}`;
    if (SOP_STEPS[equipmentKey]) {
      lookupKey = equipmentKey;
    }
  }
  // Symptom-specific SOP: highest priority
  // Priority: category:equipment:symptom > category_symptom > category:equipment > category
  if (symptom && equipment) {
    const canonical = getCanonicalEquipment(equipment);
    const symptomKey = `${category}:${canonical}:${symptom}`;
    if (SOP_STEPS[symptomKey]) {
      lookupKey = symptomKey;
    }
  }
  if (symptom && !lookupKey.includes(":") && lookupKey === category) {
    // No equipment-specific key was found, try category_symptom
    const categorySymptomKey = `${category}_${symptom}`;
    if (SOP_STEPS[categorySymptomKey]) {
      lookupKey = categorySymptomKey;
    }
  }
  const categorySteps = SOP_STEPS[lookupKey] ?? SOP_STEPS.general;
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
