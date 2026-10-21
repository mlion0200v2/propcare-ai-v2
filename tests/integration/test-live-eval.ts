/**
 * Live eval plumbing, without network: simulated chats with stub models,
 * the judge contract, the cost cap, and the report. The real tier runs
 * with LIVE_EVAL=1 (tests/eval/live/run-live.ts).
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { loadCorpus, TUNED_FILES } from "../eval/frame-eval";
import { Budget, BudgetExceeded } from "../eval/live/llm";
import { simulateConversation, judge } from "../eval/live/simulate";
import { stubCall, stubUnderstander } from "../eval/live/run-live";

export async function testLiveEval(): Promise<TestResult> {
  printSection("Live eval tier (dry run: stub models, no network)");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  const budget = new Budget(1);
  const call = stubCall(budget);
  const cases = loadCorpus(TUNED_FILES).filter((c) => c.source === "transcript");
  check(cases.length === 3, "Simone's three transcripts are in the corpus");
  for (const c of cases) {
    const t = await simulateConversation(c, call, stubUnderstander(budget));
    const v = await judge(t, c, call);
    check(t.turns.length >= 2 && t.turns.some((x) => x.tenant) && v.overall >= 1, `simulated chat runs end to end: "${c.message}"`, t.turns.map((x) => x.question));
  }
  check(budget.byPurpose.tenant?.calls > 0 && budget.byPurpose.judge?.calls === 3 && budget.spent > 0, "every model call is costed by purpose", budget.byPurpose);

  const tiny = new Budget(0.0001);
  tiny.add("judge", "gpt-4o-mini", 10_000, 1_000);
  let stopped = false;
  try {
    tiny.check();
  } catch (e) {
    stopped = e instanceof BudgetExceeded;
  }
  check(stopped, "the cost cap stops the run");
  return result;
}
