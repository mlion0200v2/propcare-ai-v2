/**
 * What the tenant is told between "describe it" and "try this": limit the
 * damage first, then a shot list for photos/video. Pure (tested).
 */
import type { GatheredInfo } from "./types";
import type { UnitProfile } from "@/lib/units/profile";
import { LEAK_SOURCES, type SourceId } from "./fixtures";

export const MAX_VIDEO_SECONDS = 60;
export const MAX_UPLOAD_MB = 25;

/** Damage-prevention steps for leaks, before any troubleshooting. Empty when not a leak. */
export function buildPreventionSteps(gathered: GatheredInfo, profile: UnitProfile): string[] {
  if (!gathered.leak_details_needed) return [];
  const spreading = /spread|lot|pour|flood|everywhere|puddle/i.test(gathered.leak_amount ?? "");
  const steps: string[] = [];
  const source = gathered.leak_likely_source?.id ? LEAK_SOURCES[gathered.leak_likely_source.id as SourceId] : undefined;
  if (source && !spreading) {
    // e.g. drain/trap: "Don't run the tap or the dishwasher; put a bowl under the trap."
    steps.push(source.prevention);
  } else if (spreading) {
    steps.push(
      profile.water_shutoff
        ? `Turn off the main water: ${profile.water_shutoff}.`
        : "If water keeps spreading, turn off the main water shut-off (often near the water heater, laundry, or where the water line enters the home)."
    );
    if (source) steps.push(source.prevention);
  } else if (/toilet/i.test(`${gathered.leak_where ?? ""} ${gathered.leak_timing ?? ""}`)) {
    steps.push("Turn off the toilet's shut-off valve (behind the toilet, near the floor): turn it clockwise.");
  } else if (/sink/i.test(gathered.leak_where ?? "")) {
    steps.push("Close the shut-off valves under the sink: turn them clockwise.");
  } else if (profile.water_shutoff) {
    steps.push(`If it gets worse, the main water shut-off is here: ${profile.water_shutoff}.`);
  }
  steps.push("Put a bucket or bowl under drips and towels on the floor.");
  steps.push("Move electronics, rugs, papers and furniture away from the water.");
  if (/ceiling/i.test(gathered.leak_where ?? "")) {
    steps.push("If the ceiling is bulging or sagging, stay out from under it.");
  }
  steps.push("Don't touch switches, outlets or appliances that are wet.");
  return steps;
}

/** Guided shot list for the media step, by issue type. */
export function buildShotList(gathered: GatheredInfo): string[] {
  const shots = ["A wide shot of the area, so we can see where it is."];
  const where = `${gathered.leak_where ?? ""} ${gathered.location_in_unit ?? ""}`.toLowerCase();
  if (gathered.leak_details_needed) {
    shots.push("A close-up of where the water comes from.");
    if (/sink|kitchen|bath/.test(where)) shots.push("Under the sink, with the cabinet doors open.");
    if (/toilet/.test(where)) shots.push("Behind and around the base of the toilet.");
    if (/ceiling/.test(where)) shots.push("The ceiling stain or drip, and anything directly above if you can see it.");
  } else {
    shots.push("A close-up of the problem.");
  }
  if (gathered.category === "appliance" || gathered.category === "hvac") {
    shots.push("The model/serial label (inside the door, on the back, or on the side).");
  }
  if (gathered.category === "pest_control") shots.push("Any droppings, damage, or entry points you've found.");
  return shots;
}

export function buildMediaPrompt(gathered: GatheredInfo, profile: UnitProfile): string {
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
    `A short video (up to ${MAX_VIDEO_SECONDS} seconds) works too, for drips or noises. Or skip this step.`
  );
  return parts.join("\n");
}
