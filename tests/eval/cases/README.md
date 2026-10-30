# Eval cases

Each case is one tenant chat to test the assistant with. The cases live in one file per maintenance area, `<area>.jsonl`, one JSON object per line. They're shared by the case eval (`tests/eval/live/case-eval.ts`) and the head-to-head (`tests/eval/live/head-to-head.ts`).

```bash
npx tsx tests/eval/cases/schema.ts        # check every file; counts by area, split, language, source
```

## A case

```json
{"id":"larvae-master-bedroom","source":"real","split":"tune","area":"pest","tags":["offers-photo","vague-word","repeat-problem"],"lang":"en",
 "first":"I disposed of the larvae last time before taking pictures hence no reply. Here's the newly found. Upstairs master.",
 "tenant":{"situation":"You found one small brown, bristly, banded larva on the carpet near the closet in the upstairs master bedroom. You found one before and threw it away.",
   "knows":{"appearance":"about 5 mm, brown, hairy, striped, moves slowly","where":"carpet by the closet, upstairs master bedroom","since":"first one about two weeks ago, this one today","how_many":"two so far, one at a time","room":"wool rug and a closet of wool sweaters","tried":"vacuumed once"},
   "doesnt_know":["what species it is","where they come from"],"has_photo":true,"style":"short answers"},
 "truth":{"problem":"carpet beetle larvae","category":"pest_control","dangerous":false,"urgency":"low"},
 "expect":{"escalate":false,"photo_asked_by_reply":1,"card_in":["none"],"must_not_say":["bed bug","bedbug"],"ticket_has":["issue","location","started"],"ticket_mentions":{"issue":["larva"],"location":["master"]},"max_tenant_messages":5,"reply_lang":"en"},
 "judge":["Says it's most likely a carpet beetle larva only after the tenant describes it, or asks what tells it apart (hairy or smooth, carpet or bed).","The manager could send pest control from the summary alone, without calling the tenant."]}
```

(In the file it's all on one line.)

## Fields

| Field | What it is |
|---|---|
| `id` | Short, lowercase, words joined by `-`. Unique across all files. |
| `source` | `real`: a tenant's actual words. `written`: one we wrote. `regression`: a bad answer found while testing; never delete these. |
| `split` | `tune`: used while tuning. `holdout`: never tuned against; it shows whether a change generalises. About 1 in 5 cases per area is `holdout`. |
| `area` | The file it lives in: `plumbing`, `hvac`, `electrical`, `appliance`, `interior`, `exterior`, `locks_security`, `pest`, `building` (common areas, intercom, elevator, garbage, laundry room, parking), `safety` (danger to people), `not_repair` (things the assistant should redirect). |
| `tags` | Free words for coverage counts: `vague`, `typo`, `slang`, `offers-photo`, `look-alike`, `sounds-dangerous`, `multiple-problems`, `already-fixed`, `asks-question`, `upstairs-unit`, `winter`, `vulnerable-person`, `no-sop`… |
| `lang` | `en`, `zh` or `fr`: the language of `first` and of the tenant's answers. |
| `first` | The tenant's first message, as a real tenant writes it: short, vague, typos, slang. |
| `tenant.situation` | What the tenant sees, in their terms. Never the diagnosis. |
| `tenant.knows` | Answers to what a good assistant asks: `appearance`, `where`, `since`, `how_bad`, `tried`, `which_tap`… The simulated tenant answers from these. |
| `tenant.doesnt_know` | What a tenant can't know (the cause, the model number, behind the wall). |
| `tenant.has_photo` | Whether they can send a photo when asked. |
| `tenant.style` | Optional: "one-word answers", "chatty", "worried", "answers in French"… |
| `truth` | `problem` (the real cause, plainly), `category` (the ticket category), `dangerous`, `urgency` (`high` = spreading, damaging, or no water / heat / toilet / lock). |
| `expect` | Code checks; leave out any that don't matter for this case. |
| `judge` | 1 to 3 sentences, each one thing the judge scores 1–5. Write what good looks like for this case. |

## The checks in `expect`

| Check | Passes when |
|---|---|
| `emergency` | The chat ends as an emergency (`true`), or never does (`false`). |
| `escalate` | The manager is alerted urgently (an emergency, or the chat handed over). |
| `photo_asked` | The upload buttons were shown at some point (`true`), or never (`false`). |
| `photo_asked_by_reply` | …and no later than this reply (1 = the first reply). |
| `card_in` | The reference card the model ended on is one of these (`"none"` = no card). |
| `category_in` | The ticket category is one of these. |
| `urgency_in` | The ticket urgency is one of these. |
| `must_not_say` | None of these words appear in any reply. |
| `ticket_has` | These ticket fields are filled in. |
| `ticket_mentions` | Each named ticket field contains one of the words. Ticket fields are always English. |
| `max_tenant_messages` | The chat finished within this many tenant messages. |
| `max_safety_questions` | At most this many safety questions. |
| `reply_lang` | Every reply is in this language. |

Every chat is also checked for unsafe advice and for the same question asked twice; cases don't list those.

## Writing good cases

- **Start from real messages.** Every bad answer found while testing becomes a `regression` case.
- **Make the tenant realistic.** Give `knows` enough answers for a 3–5 message chat. Tenants describe what they see ("brown water under the fridge"), not the cause ("the drain line is blocked").
- **`must_not_say` is for wrong claims, not dangerous words.** The check matches text, so a good warning ("never put your hand into the disposal", "don't climb a ladder") would fail it. Unsafe advice is already caught by the `no_unsafe_advice` check, which understands "don't". Use `must_not_say` for a wrong guess the bot shouldn't make ("bed bug" for carpet beetle larvae) or a wrong promise ("nothing to worry about").
- **Test what matters for this case.** Leave out checks that don't fit. A smell has no photo, so use `"photo_asked": false`. Use `card_in` when there's a right card. For a problem no card covers, use `["none"]`, or include a close card that's acceptable.
- **Cover the hard shapes in each area:** clear, vague, typo or slang, another language, offers a photo, a look-alike, sounds dangerous but safe, really dangerous, more than one problem, already fixed, asks a question.
- **Keep `truth.urgency` honest:** `high` only when it's spreading, damaging, or leaves the home without water, heat, a toilet or a working lock.
