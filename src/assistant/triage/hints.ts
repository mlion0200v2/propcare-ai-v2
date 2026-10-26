/**
 * Tap-answers and damage-prevention notes for the tenant chat, from the
 * question being asked and the unit's profile. Pure (tested). Free text
 * always works too; these only save typing and mistakes.
 */
import { fixtureLabel, type PropertyContext } from "../property";
import { sopByKey } from "../sops/catalog";
import { optionsFor } from "../sops/intake";
import type { GatheredInfo } from "./types";

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
  profile: PropertyContext;
  /** Rooms the tenant may mean (e.g. two bathrooms): offered instead of all rooms. */
  locationCandidates?: string[] | null;
  /** Conversation so far: an SOP question's options depend on what's known (no disposal for a bathroom sink). */
  gathered?: GatheredInfo | null;
}): ChatHints {
  const { currentQuestion, triageState, category, description, profile, locationCandidates, gathered } = params;
  const quickReplies: string[] = [];
  const notes: string[] = [];

  if (triageState === "DONE") return { quickReplies, notes };

  if (currentQuestion?.startsWith("intake:") && gathered?.sop) {
    const sop = sopByKey(gathered.sop.issue_key);
    const question = sop?.intake_questions.find((q) => `intake:${q.id}` === currentQuestion);
    if (question) {
      quickReplies.push(...optionsFor(question, gathered.sop).map((o) => o.label));
      if (question.slot === "brand_model") {
        const relevant = profile.fixtures.filter((f) => f.brand || f.model);
        quickReplies.unshift(...relevant.slice(0, 6).map(fixtureLabel));
      }
    }
  }

  switch (currentQuestion) {
    case "location_in_unit":
      quickReplies.push(
        ...(locationCandidates?.length ? locationCandidates : profile.rooms.length > 0 ? profile.rooms : DEFAULT_ROOMS)
      );
      break;
    case "started_when":
      quickReplies.push("Just now", "Today", "Yesterday", "A few days ago", "Over a week ago");
      break;
    case "current_status":
      quickReplies.push("Still happening", "Comes and goes", "Getting worse", "It stopped");
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

  return { quickReplies: [...new Set(quickReplies)].slice(0, 12), notes };
}
