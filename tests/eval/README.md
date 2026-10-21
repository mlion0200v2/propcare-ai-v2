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
