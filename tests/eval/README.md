# Chat evals

All of these run without network access. The deterministic tier runs in CI through `tests/run.ts`.

| File | What it measures |
|---|---|
| `conversation-eval.ts` + `conversation-scenarios.ts` | Scripted multi-turn chats with hand-written expectations (51 scenarios, including Simone's transcripts). |
| `frame-eval.ts` + `corpus/*.jsonl` | Labelled first messages. For each one: frame accuracy per field (equipment, symptom, substance, room), category accuracy, emergency recall and precision, and a scripted chat with neutral answers scored for **re-asks** (room or category already said) and **irrelevant questions** (water questions when the leak isn't water). |

## Corpus

- `corpus/first-messages.jsonl`: 365 messages. Every taxonomy item crossed with its usual symptoms and substances, plus typos, slang, terse and rambling messages, 58 in Chinese and 32 in French. The first three are Simone's real transcripts. The rules were tuned against this file.
- `corpus/heldout.jsonl`: 59 messages written after the rules were tuned. **Never tune the rules against these.** They measure how well the rules generalise.
- `corpus/regressions.jsonl`: real messages added with the helper below. These must pass exactly in CI.

Each line is one labelled message:
`{id, message, lang, style, expected: {equipment, symptom, substance, room}, emergency, sop, source}`.
`room` is the room the message states or implies (a toilet is in a bathroom); it is `unknown` otherwise. `sop` is the SOP `issue_key` that should be selected.

## Commands

```bash
npx tsx tests/eval/frame-eval.ts              # summary: corpus and held out
npx tsx tests/eval/frame-eval.ts --failures   # every miss
npx tsx tests/eval/frame-eval.ts --json       # machine-readable
```

To measure a baseline, check out an older commit in a worktree, copy `tests/eval/` into it and run the same command. The frame metrics show "n/a" where the understanding layer doesn't exist yet.

## Add a regression case from a real chat

```bash
npx tsx tests/eval/add-regression.ts "rangehood is leaking gease" --expect substance=grease --emergency no
npx tsx tests/eval/add-regression.ts --transcript pasted-chat.txt
```

The helper appends the message to `corpus/regressions.jsonl`. Fields you don't pass with `--expect` start from today's understanding, so check the printed line before committing. CI then requires the case to pass exactly: frame, emergency, and no re-asked or irrelevant questions.

The CI floors are in `FLOORS` in `frame-eval.ts`. Raise them as the rules improve; never lower one to get a build to pass.

## Diagnosis and coverage

```bash
npx tsx tests/eval/diagnosis-eval.ts --failures   # every SOP × cause as a hidden scenario card
npx tsx tests/eval/coverage.ts --write            # area × SOPs × eval cases × pass rate → reports/coverage.md
```

- **Diagnosis cards.** There is one card for each cause of each SOP. The card fixes the true cause, and a scripted tenant answers each question the way that cause would look:
  - an option that rules the cause in;
  - otherwise a neutral answer, or "not sure".

  The chat runs end to end from a real corpus first message for that SOP. If that message contradicts the card, a neutral message is used instead. A card passes when the ticket lists the true cause first or second, with its trade and parts.
- **Coverage matrix.** It covers every area on Simone's list: plumbing, appliances, electrical, heating and air, safety, doors/windows/locks, building, pests, outdoor and common areas, and noise. For each area it shows the SOPs, the labelled cases, how many pass, and the diagnosis cards.

  A case passes when an emergency is escalated at once. Otherwise it must pick the right SOP, with no question that is re-asked, irrelevant or out of scope.

CI (`testCoverage`) requires every SOP to have eval cases and every area to pass its floor, with the true cause in the top 2 on ≥ 95% of cards.

## Live tier (real model calls, opt-in)

```bash
LIVE_EVAL=1 npx tsx tests/eval/live/run-live.ts                 # every message through the model + 40 simulated chats
LIVE_EVAL=1 npx tsx tests/eval/live/run-live.ts --sample all    # every message as a simulated chat
npx tsx tests/eval/live/run-live.ts --dry-run                   # rehearsal: stub models, no network, estimated cost
```

The live tier only calls OpenAI, using `OPENAI_API_KEY`. It never touches Supabase, Pinecone or email. It does three things:

1. **Model frames.** Every corpus and held-out message goes through the understanding layer with the model on. Field accuracy, SOP selection and emergency recall and precision are scored against the labels.
2. **Simulated chats.** The model plays the tenant from a hidden card built from the labels, and answers whatever the real conversation module asks. Simone's transcripts and the regression cases are always included; the rest is a seeded sample.
3. **Judge.** A model scores each chat against a rubric: understood, relevance, efficiency, safety, **tradesperson-ready** and overall. For tradesperson-ready, the judge also sees the manager-facing diagnosis, and asks whether a tradesperson would have what they need before the visit. It lists irrelevant and re-asked questions verbatim.
4. **Diagnosis cards** (`--diagnosis N|all`, default 20). The model plays a tenant whose hidden card fixes the true cause and lists what they would notice. The check is whether the ticket lists that cause first or second, with the right trade. Results are reported per area.

**Cost cap:** `--max-usd` or `LIVE_EVAL_MAX_USD`, default $2. The run stops and still writes its report when the cap is reached. Prices are in `live/llm.ts`; override them with `LIVE_EVAL_PRICE_IN` and `LIVE_EVAL_PRICE_OUT`.

**Report:** `reports/live-YYYY-MM-DD.md` (plus `.json`). It contains:
- a baseline-vs-after table (main and #11 come from `reports/baselines.json`);
- the model's frame accuracy;
- judge scores;
- the lowest-scored chats, each with the `add-regression` command to turn it into a regression case;
- the cost by purpose.

**Estimated cost** (gpt-4o-mini, from the dry run in `reports/live-2026-10-21-dry-run.md`):
- One understanding call: about $0.00026.
- A production conversation: about $0.001 (one call per tenant message).
- A full live run (every message as a chat, plus all 220 diagnosis cards): about $1.18.
- The default run (all messages through the model, 40 chats, 20 diagnosis cards): about $0.23.

**Nightly:** `.github/workflows/eval-live.yml` runs nightly only when the repository variable `LIVE_EVAL` is `1` and the `OPENAI_API_KEY` secret is set. It can also be started by hand (Actions → Live eval → Run workflow). The report is uploaded as a build artifact.

CI runs the live pipeline with stub models (`tests/integration/test-live-eval.ts`), so the plumbing can't silently break.
