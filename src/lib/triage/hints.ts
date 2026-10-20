/**
 * Tap-answers and damage-prevention notes for the tenant chat, from the
 * question being asked and the unit's profile. Pure (tested). Free text
 * always works too; these only save typing and mistakes.
 */
import { fixtureLabel, type UnitProfile } from "@/lib/units/profile";

export interface ChatHints {
  quickReplies: string[];
  /** Short, practical notes shown above the input, e.g. where the water shut-off is. */
  notes: string[];
}

const DEFAULT_ROOMS = ["Kitchen", "Bathroom", "Bedroom", "Living room", "Laundry"];

const WATER_WORDS = /\b(leak|leaking|drip|dripping|water|flood|flooding|overflow|burst|pipe|toilet|sink|shower|tub|faucet|tap)\b/i;
const ELECTRICAL_WORDS = /\b(outlet|breaker|power|spark|sparking|light|switch|electric|electrical)\b/i;

export function buildChatHints(params: {
  currentQuestion: string | null;
  triageState: string | null;
  category: string | null;
  description: string;
  profile: UnitProfile;
}): ChatHints {
  const { currentQuestion, triageState, category, description, profile } = params;
  const quickReplies: string[] = [];
  const notes: string[] = [];

  if (triageState === "DONE") return { quickReplies, notes };

  switch (currentQuestion) {
    case "location_in_unit":
      quickReplies.push(...(profile.rooms.length > 0 ? profile.rooms : DEFAULT_ROOMS));
      break;
    case "started_when":
      quickReplies.push("Just now", "Today", "Yesterday", "A few days ago", "Over a week ago");
      break;
    case "current_status":
      quickReplies.push("Still happening", "Comes and goes", "Getting worse", "It stopped");
      break;
    case "leak_where":
      quickReplies.push("Ceiling", "Wall", "Floor", "Under the sink", "Around an appliance", "Around the toilet");
      break;
    case "leak_amount":
      quickReplies.push("A few drops", "A small puddle", "It's spreading");
      break;
    case "leak_timing":
      quickReplies.push(
        "All the time",
        "When the shower or bath is used",
        "When the toilet is flushed",
        "When an appliance runs",
        "Not sure"
      );
      break;
    case "leak_electrical":
      quickReplies.push("No", "Yes", "Not sure");
      break;
    case "brand_model": {
      const relevant = profile.fixtures.filter((f) => f.brand || f.model);
      quickReplies.push(...relevant.slice(0, 6).map(fixtureLabel), "Unknown");
      break;
    }
  }

  const water = category === "plumbing" || WATER_WORDS.test(description);
  const electrical = category === "electrical" || ELECTRICAL_WORDS.test(description);
  if (water && profile.water_shutoff) {
    notes.push(`If water is spreading, your main water shut-off is here: ${profile.water_shutoff}.`);
  }
  if ((electrical || (water && /\b(light|outlet|ceiling)\b/i.test(description))) && profile.breaker_panel) {
    notes.push(`Breaker panel: ${profile.breaker_panel}. Only touch it if your hands and the floor are dry.`);
  }

  return { quickReplies: [...new Set(quickReplies)].slice(0, 10), notes };
}
