/**
 * Test: reference cards (pure — no network)
 * Run:  npx tsx tests/integration/test-cards.ts
 *
 * Covers:
 *   - one card per written, selectable SOP; general SOPs are not cards
 *   - no card offers a step the never-instruct filter rejects
 *   - finding cards: several, best first; ties all come; none when nothing fits
 *   - knowledge-base similarity raises a card, it never adds one that fails the filter
 *   - the card text the model reads keeps parts out and marks causes as ticket-only
 */
import { cardByKey, cardText, findCards, GLOBAL_NEVER, loadCards } from "../../src/assistant/cards";
import { loadCatalog } from "../../src/assistant/sops/catalog";
import { isGeneralSop } from "../../src/assistant/sops/general";
import { findUnsafeInstruction } from "../../src/assistant/triage/step-safety";
import { understand } from "../../src/assistant/understanding";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

async function cardsFor(message: string, vectorScores?: Record<string, number>) {
  const { frame } = await understand(message, null);
  return findCards(frame, message, { vectorScores }).map((c) => c.card.key);
}

export async function testCards(): Promise<TestResult> {
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  printSection("Reference cards — built from the catalog");
  {
    const cards = loadCards();
    const written = loadCatalog().filter((s) => s.selectable && !isGeneralSop(s));
    check(cards.length === written.length && cards.length > 50, `one card per written SOP (${cards.length})`, { cards: cards.length, written: written.length });
    check(!cards.some((c) => c.key.endsWith("_general")), "general SOPs are not cards");
    const unsafe = cards.flatMap((c) => c.safe_steps.filter((s) => findUnsafeInstruction(s)).map((s) => `${c.key}: ${s}`));
    check(unsafe.length === 0, "no card offers a step the never-instruct filter rejects", unsafe.slice(0, 5));
    check(!cards.some((c) => c.safe_steps.some((s) => /hex key|allen (key|wrench)/i.test(s))), "no card tells a tenant to use a hex key");
    check(GLOBAL_NEVER.length >= 8 && GLOBAL_NEVER.some((n) => /gas/i.test(n)) && GLOBAL_NEVER.some((n) => /breaker/i.test(n)), "a global never-do list covers gas and breakers");
  }

  printSection("Reference cards — finding them");
  {
    const leak = await cardsFor("my kitchen sink is leaking under the cabinet");
    check(leak[0] === "under_sink_leak", "a clear problem: its card first", leak);
    const chute = await cardsFor("the garbage chute is blocked");
    check(chute[0] === "garbage_room", "the garbage chute has its card", chute);
    const pests = await cardsFor("cockroches in the kitchen");
    check(pests.includes("cockroaches") && pests.includes("ants"), "tied pest cards all come, so the model can tell ants from cockroaches", pests);
    check(pests.length <= 5, "…but no more than five", pests.length);
    const larvae = await cardsFor("I disposed of the larvae last time before taking pictures hence no reply. Here's the newly found. Upstairs master.");
    check(larvae.length === 0, "nothing fits: no card (the model works without one)", larvae);
    const toilet = await cardsFor("马桶堵了");
    check(toilet[0] === "toilet_clog", "Chinese: the toilet clog card", toilet);
  }

  printSection("Reference cards — knowledge-base similarity");
  {
    const without = await cardsFor("cockroches in the kitchen");
    const withVector = await cardsFor("cockroches in the kitchen", { cockroaches: 0.8, ants: 0.4 });
    check(withVector[0] === "cockroaches", "similarity puts the closest card first", { without, withVector });
    const filtered = await cardsFor("my kitchen sink is leaking under the cabinet", { cockroaches: 1 });
    check(!filtered.includes("cockroaches"), "similarity can't add a card whose filter doesn't fit", filtered);
  }

  printSection("Reference cards — what the model reads");
  {
    const card = cardByKey("under_sink_leak")!;
    const text = cardText(card);
    const parts = card.causes.flatMap((c) => c.parts);
    check(parts.length > 0 && !parts.some((p) => text.includes(p)), "parts are never in the card text", parts.filter((p) => text.includes(p)));
    check(/for the ticket only/i.test(text) && card.causes.every((c) => text.includes(c.id)), "causes are listed by id, marked ticket-only");
    check(card.ask.length > 0 && text.includes(card.ask[0].question), "the card lists what the tradesperson needs to know");
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-cards");
if (isMain) runStandalone(testCards);
