/**
 * What the tenant is told between "describe it" and "try this": limit the
 * damage first, then a shot list for photos/video. Pure (tested).
 */
import type { GatheredInfo } from "./types";
import type { PropertyContext } from "../property";
import { MEDIA_LIMITS } from "../api";
import { sopByKey } from "../sops/catalog";

/** Water escaping (from what the intake understood). */
function isWaterLeak(gathered: GatheredInfo): boolean {
  const slots = gathered.sop?.slots;
  return !!slots && slots.symptom === "leaking" && (slots.substance === "water" || slots.substance === "unknown");
}

/** Where it is, in words: the fixture/surface and the room. */
function whereText(gathered: GatheredInfo): string {
  return `${gathered.sop?.slots.equipment ?? ""} ${gathered.equipment ?? ""} ${gathered.location_in_unit ?? ""}`.toLowerCase();
}

/** Damage-prevention steps before any troubleshooting. Empty when there's nothing to limit. */
export function buildPreventionSteps(gathered: GatheredInfo, profile: PropertyContext): string[] {
  const sop = gathered.sop ? sopByKey(gathered.sop.issue_key) : null;
  const causePrevention = gathered.sop?.cause?.prevention || undefined;
  if (!isWaterLeak(gathered)) {
    // Not water: the SOP's own first step to limit damage (e.g. no cooking under a grease drip).
    const first = causePrevention ?? sop?.prevention[0];
    return first ? [first] : [];
  }
  const amount = gathered.sop?.answers.amount?.value ?? "";
  const spreading = /spread|lot|pour|flood|everywhere|puddle/i.test(amount);
  const where = whereText(gathered);
  const steps: string[] = [];
  if (causePrevention && !spreading) {
    // e.g. drain/trap: "Don't run the tap or the dishwasher; put a bowl under the trap."
    steps.push(causePrevention);
  } else if (spreading) {
    steps.push(
      profile.water_shutoff
        ? `Turn off the main water: ${profile.water_shutoff}.`
        : "If water keeps spreading, turn off the main water shut-off (often near the water heater, laundry, or where the water line enters the home)."
    );
    if (causePrevention) steps.push(causePrevention);
  } else if (/toilet/.test(where)) {
    steps.push("Turn off the toilet's shut-off valve (behind the toilet, near the floor): turn it clockwise.");
  } else if (/sink/.test(where)) {
    steps.push("Close the shut-off valves under the sink: turn them clockwise.");
  } else if (profile.water_shutoff) {
    steps.push(`If it gets worse, the main water shut-off is here: ${profile.water_shutoff}.`);
  }
  steps.push("Put a bucket or bowl under drips and towels on the floor.");
  steps.push("Move electronics, rugs, papers and furniture away from the water.");
  if (/ceiling/.test(where)) {
    steps.push("If the ceiling is bulging or sagging, stay out from under it.");
  }
  steps.push("Don't touch switches, outlets or appliances that are wet.");
  return steps;
}

/** Guided shot list for the media step: the SOP's own list when there is one. */
export function buildShotList(gathered: GatheredInfo): string[] {
  const shots = ["A wide shot of the area, so we can see where it is."];
  const sop = gathered.sop ? sopByKey(gathered.sop.issue_key) : null;
  if (sop && sop.photos.length > 0) {
    shots.push(...sop.photos.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)));
  } else if (isWaterLeak(gathered)) {
    const where = whereText(gathered);
    shots.push("A close-up of where the water comes from.");
    if (/sink|kitchen|bath/.test(where)) shots.push("Under the sink, with the cabinet doors open.");
    if (/toilet/.test(where)) shots.push("Behind and around the base of the toilet.");
    if (/ceiling/.test(where)) shots.push("The ceiling stain or drip, and anything directly above if you can see it.");
  } else {
    shots.push("A close-up of the problem.");
  }
  if ((gathered.category === "appliance" || gathered.category === "hvac") && !shots.some((s) => /model|sticker|label/i.test(s))) {
    shots.push("The model/serial label (inside the door, on the back, or on the side).");
  }
  if (gathered.category === "pest_control" && !sop) shots.push("Any droppings, damage, or entry points you've found.");
  return shots;
}

export function buildMediaPrompt(gathered: GatheredInfo, profile: PropertyContext): string {
  const prevention = buildPreventionSteps(gathered, profile);
  const shots = buildShotList(gathered);
  const parts: string[] = [];
  if (prevention.length > 0) {
    parts.push("**First, let's limit the damage:**", ...prevention.map((s, i) => `${i + 1}. ${s}`), "");
  }
  parts.push(
    "**Photos help your landlord send the right person.** If you can, take:",
    ...shots.map((s) => `- ${s}`),
    "",
    `A short video (up to ${MEDIA_LIMITS.maxVideoSeconds} seconds) works too, for drips or noises. Or skip this step.`
  );
  return parts.join("\n");
}

/**
 * Reports that go straight to the manager (neighbour noise): no troubleshooting
 * steps, just what happens next. Null for everything else.
 */
export function managerOnlyReply(gathered: GatheredInfo): string | null {
  const sop = gathered.sop ? sopByKey(gathered.sop.issue_key) : null;
  if (!sop?.route_to_manager) return null;
  return [
    "Thanks, I've passed this to your property manager. There's nothing you need to try yourself.",
    ...sop.escalate_if.map((e) => `${e}.`),
  ].join("\n");
}
