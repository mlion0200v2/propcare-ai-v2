# PropCare assistant service: design

**Status:** proposal for review. Steps 1–3 of the migration plan are built in #20 (not merged yet); steps 4 onward are not built.
**Builds on:** #20, which consolidates the chat-understanding redesign (#11–#18, now closed) and adds `src/assistant/` with an in-process `turn()`.

## Goal

Run the PropCare assistant as its own service, separate from the web app.

- The assistant is the part that understands a tenant's message, picks the right procedure (SOP), asks the questions, works out the likely cause and gives safe steps.
- It serves any **channel** through one API: the web chat today, email next, and voice later.
- It holds the **knowledge base** (SOPs, causes, parts, safe steps) and the **model keys**.
- It holds **no tenant data**: no names, phone numbers, emails, addresses, leases or ticket history. It only sees the message being handled and non-sensitive facts about the property, such as rooms, fixtures and where the water shut-off is.

## Where things are today

This section describes `main` before #20. After #20 the assistant code is in `src/assistant/` and the chat route is about 350 lines.

| Piece | Where it runs | Notes |
|---|---|---|
| Web app (Next.js): tenant chat, manager portal, vendor work orders | Cloud Run `propcare` in Montreal, behind the website's load balancer at propcare.birchwoodcorp.com | Deploys from this repo: `main` → staging, version tag → production. Terraform is in the website repo (`infra/terraform/modules/propcare`). |
| Database, logins and photo storage | Supabase | Staging and production currently share one demo-only project. A separate production project is needed before real tenants. |
| Knowledge base vectors | Pinecone index `propcare-kb`, namespace `sop` | Holds SOP text only. No tenant data. |
| Models | OpenAI (gpt-4o-mini, text-embedding-3-small) | Called from inside the web app. |
| Vercel | Nothing is served from it | Only the GitHub integration remains; it builds a preview for every PR. It can be disconnected. |

Inside the web app, the assistant's logic is already **separate from the database**. These modules have no Supabase access:
- `src/lib/understanding/`: reading the message into a structured issue;
- `src/lib/sops/`: the catalog, SOP selection, scope rule, intake and diagnosis;
- `src/lib/triage/conversation.ts`: what to ask next.

The database work happens in one place, the chat route `src/app/api/triage/chat/route.ts`, about 2,400 lines. It loads and saves the ticket, then calls those modules. That is the line to cut along.

## Proposed shape

```
 Tenant ──► Web chat (Next.js) ───────┐
 Tenant ──► Email adapter ────────────┼──► Assistant service ──► OpenAI, Pinecone (knowledge base only)
 Tenant ──► Voice adapter (later) ────┘      │
            │                                └─ returns: reply, tap options, new state, flags, diagnosis
            ▼
        PropCare app + Supabase  (tenants, tickets, photos, managers, vendors, emergency alerts)
```

There are two services, both on Cloud Run:

1. **`propcare-assistant`** (new).
   - Runs a stateless HTTP API.
   - Holds the SOP catalog, the understanding and intake logic, retrieval and troubleshooting steps, and the OpenAI and Pinecone keys.
   - Has no database connection.
2. **`propcare`** (today's app, smaller).
   - Owns Supabase: logins, tenancies, tickets, photos, managers, vendors, emergency alerts and email sending.
   - For each tenant message, it sends the assistant only what the assistant needs, and stores what comes back.

**Channel adapters** turn a medium into turns of conversation:
- the **web chat**, which is part of the app;
- an **email adapter**, which handles inbound email and sends replies;
- later, a **voice adapter** (phone → speech-to-text → the same API → text-to-speech).

Each adapter resolves who is writing and which unit it's about, using the app's data. It then calls the assistant with tenant details removed.

## The data boundary

| The assistant may receive | The assistant never receives |
|---|---|
| The tenant's message, with phone numbers, emails and street addresses removed | Tenant names, phones, emails, account ids |
| An opaque conversation id, which is a random token rather than the ticket id | Ticket history beyond the current conversation's state |
| The conversation state it returned last time | The unit's address, rent, lease or owner details |
| Property context: room names, fixtures (with brand and model), where the water shut-off and breaker panel are, pets yes or no | Photos (for now; see open question 3) |
| The photo count | Manager or vendor data, approvals, quotes |
| The channel (web, email or voice) and language | Anything from other tenants or units |

Rules that keep this true:
- **Removal happens in the channel, before the call.** A shared helper strips email addresses, phone numbers and street addresses from free text. The assistant also refuses or masks anything that still looks like contact details, as a second line of defence.
- The assistant's **logs** contain no message text by default, only ids, timings, the SOP and the cause. Message text is logged only in staging.
- **Pinecone** holds the knowledge base only. Nothing per-tenant is ever embedded or stored there.
- The assistant has **no Supabase credentials**. If it ever needs property data, the channel sends it in the request.
- **OpenAI** sees the same redacted text the assistant sees. OpenAI's API doesn't train on API data by default; the project should still be set to zero data retention if that becomes available to the account.

## Assistant API

All calls are `POST`, take and return JSON, and are versioned under `/v1`.

### `POST /v1/turn`: one tenant message in, the next step out

Request:

```json
{
  "conversation": "c_7Hq2…",
  "channel": "web",
  "language": "en",
  "message": "my fridge is leaking",
  "state": null,
  "property": {
    "rooms": ["Kitchen", "Main bathroom (hallway)", "Bedroom"],
    "fixtures": [{ "name": "Fridge", "room": "Kitchen", "brand": "LG", "model": "LRMVS3006S" }],
    "water_shutoff": "Laundry closet, blue lever",
    "breaker_panel": "Hallway",
    "pets": true
  },
  "media_count": 0
}
```

Response:

```json
{
  "reply": "Thanks for letting us know… Where is the water? (in front of the fridge; under it; behind it; …)",
  "options": ["In front of the fridge", "Under it", "Behind it", "Inside, under the crisper drawers", "On the freezer floor", "Not sure"],
  "step": "intake",
  "state": { "v": 1, "frame": { … }, "intake": { … }, "triage": "GATHER_INFO", "sig": "…" },
  "emergency": null,
  "done": false,
  "ticket": {
    "category": "appliance",
    "title": "Fridge leaking",
    "summary_for_manager": "…",
    "diagnosis": { "procedure": "Refrigerator leaking water", "confidence": "low", "causes": [], "parts": [], "trade": "appliance technician" }
  }
}
```

- **`state`** is the whole conversation so far: the issue frame, intake answers and step. The assistant returns it and the channel stores it, in `tickets.classification` as today, then sends it back on the next turn. The assistant keeps nothing between calls, so it scales to zero and holds no data at rest. The state is **signed** with a key only the assistant knows, so a channel can't alter it, and **versioned** (`v`) so the format can change later.
- **`emergency`** is set when the message or an answer is dangerous: `{ "kind": "gas", "advice": "Leave now…" }`. The channel must then alert the manager. That code, `escalate-emergency.ts`, stays in the app because it needs contact details.
- **`ticket`** is what the app should store for managers and vendors: the category, a title, the manager summary and the **diagnosis** (likely causes, parts, trade and time). The tenant never sees this part. The assistant **returns** it and **never writes** it anywhere.
- **`step`** says where the conversation is: `intake`, `safety_check`, `photos`, `troubleshooting`, `confirm` or `done`. The channel uses it for things only it can do, such as showing an upload button for `photos`.

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/photos-received` | Tells the assistant that photos arrived (count only), so it moves on to troubleshooting. This could also be a field on `/v1/turn`. |
| `GET /v1/health` | Liveness check for Cloud Run. |
| `GET /v1/catalog/version` | The SOP catalog version, so the app can show which version handled a ticket. |

### Contract tests

The API types live in a small shared package, or in one file both services import. The eval in `tests/eval/` already drives the conversation logic directly. After the split it drives `/v1/turn` instead, so every eval run (scripted, coverage, diagnosis, live) tests the real service boundary.

## What moves and what stays

| Moves to `propcare-assistant` | Stays in `propcare` (app) |
|---|---|
| `src/assistant/understanding/*` | Supabase clients, logins, row-level security, migrations |
| `src/assistant/sops/*` (catalog, select, scope, intake, diagnosis view) | The chat route: load ticket → build the request (`src/lib/assistant-request.ts`: strip contact details, no access notes) → call the assistant → save the result |
| `src/assistant/triage/*` and `gather.ts`, `troubleshoot.ts`, `confirm.ts`, `turn.ts`: emergency rules, guidance, hints, summary, grounding, step help, step safety, interpretation | `src/lib/tickets/escalate-emergency.ts` (alerts the manager), email sending, photo upload and storage |
| `src/assistant/retrieval/*` (Pinecone) | Knowing who the tenant is and which unit: every ticket starts from a tenancy, so no tenant info is collected in the chat. |
| `scripts/ingest_sops.ts` | Manager portal, vendor work orders, quote form, the Diagnosis block (it renders what the assistant returned) |
| `tests/eval/*` | Workspace and access tests |

The old **"confirm your profile"** and **"collect tenant info"** steps are gone (#20): they handled personal data, and every ticket now starts from a tenancy the app already knows. The assistant starts at the problem itself.

## Security

- **Service-to-service authentication.** The assistant runs with **no public access**; Cloud Run's "require authentication" setting is on. Each channel calls it with a Google-signed identity token from its own service account. Only those accounts get `roles/run.invoker` on the assistant.
- **Network.** The assistant isn't on the public load balancer. Channels reach it through its Cloud Run address with the token. No custom domain is needed.
- **Secrets** (OpenAI key, Pinecone key, state-signing key) are in Secret Manager. They are mounted only into the assistant, not the app.
- **Abuse limits.** Rate limiting per conversation and per channel, a maximum message length (already 1,500 characters for the model), and a per-day model-spend alarm in Cloud Monitoring.
- **Prompt injection.** Tenant text is only ever *data* to the model, with structured outputs and fixed schemas. The deterministic emergency rules always run, and the model can only raise urgency, never clear it. No tool use or browsing in the assistant.

## Hosting and cost

- **Cloud Run, in the same GCP projects as the website and the app** (`birchwood-site-staging` / `birchwood-site-prod`), region `northamerica-northeast1`. Terraform goes in a new `propcare-assistant` module next to `modules/propcare` in the website repo. The assistant deploys from this repo with the same rule: `main` → staging, version tag → production.
- **Scale to zero.** `min-instances = 0` costs close to nothing when idle. Starting a cold container takes a second or two; that's acceptable for chat and email. Voice may need `min-instances = 1`, which costs roughly the price of one small always-on container. Decide that when voice is built.
- **The main running cost is model calls**: about **$0.001 per conversation** for understanding (gpt-4o-mini, measured from token counts in the eval dry run), plus the existing embedding and troubleshooting calls. Cloud Run CPU and memory for this traffic stays within or close to Cloud Run's free monthly allowance.
- **Vercel**: not needed. It serves nothing today. Disconnect its GitHub integration so PRs stop showing a Vercel check; this needs Simone's Vercel login.
- **Deadline:** the GCP free trial ends **2026-12-15**. Billing has to be upgraded before then, or both PropCare services and the website stop.

## Migration plan

Each step is its own PR, with CI green and staging first. Each one leaves PropCare working.

1. **Merge the redesign** and run `npx tsx scripts/ingest_sops.ts`. *Done in #20.*
2. **Draw the line inside the app.** Add `src/assistant/` with a `turn(request) → response` function that implements the API above in-process. The chat route calls `turn()` instead of the triage modules, after removing contact details. No new service yet: this proves the boundary with no infrastructure risk. *Done in #20.* The old tenant-info flow was removed instead of moved: every ticket now starts from a tenancy, so the app already knows the unit.
3. **Make the eval drive `turn()`.** Port the scripted, coverage, diagnosis and live tiers to call `turn()`, so the boundary is tested on every PR. *Done in #20* (`tests/eval/drive.ts`; `test-assistant-boundary.ts` fails CI if `src/assistant/` imports the app).
4. **Stand up `propcare-assistant`.** Create the service from the same repo: a separate Dockerfile target that runs only `src/assistant/` behind `/v1`. Add the Terraform module, the service accounts, invoker permissions and secrets. Give each service its own deploy workflow with a path filter: the assistant redeploys only when `src/assistant/`, its catalog or its Dockerfile target changes; the app redeploys when anything else changes (including the shared API types in `src/assistant/api.ts`, which both use). Deploy to staging.
5. **Switch the web chat to HTTP** behind a flag (`ASSISTANT_URL`). Turn it on in staging, compare the eval results with the in-process version, then roll out to production.
6. **Remove the model keys from the app.** Once production runs on the service, the app no longer needs the OpenAI or Pinecone keys.
7. **Email channel.**
   - Inbound mail goes to the app's email adapter through an inbound-email webhook. Check whether Resend offers one; otherwise use something like SendGrid Inbound Parse or Mailgun Routes.
   - The adapter matches the sender to a tenancy, strips contact details, and calls `/v1/turn` with `channel: "email"`.
   - It replies by email, listing the tap options as plain choices.
   - Tests use the test inbox only.
8. **Voice** (later): a phone provider's webhook → speech-to-text → `/v1/turn` with `channel: "voice"` → text-to-speech. The API needs no change. Short replies and spoken options are a formatting rule per channel.

Steps 4–6 together are about a week of work; email is a separate piece after that.

## Conversation redesign: the model leads, the rules guard

**Status:** proposal (2026-10-27). Do this before step 4: it changes what happens inside `turn()`, not the API around it, so the service is built once, around the new design.

### Why

A head-to-head eval (`tests/eval/live/head-to-head.ts`; reports in `tests/eval/reports/head-to-head-2026-10-2*`) ran the same simulated tenants through PropCare and through a plain LLM (gpt-4o-mini, a short prompt, no SOPs). A blind gpt-4o judge scored both.

| | Problems with a written SOP (26) | Emergencies (8) | Problems with no SOP (14) |
|---|---|---|---|
| Judge prefers PropCare / plain LLM | 20 / 6 | 7 / 0 (1 tie) | 4 / 10 |
| Ready for the manager (1–5) | 3.62 / 2.23 | 2.38 / 2.25 | PropCare higher |
| Chats with unsafe advice (judge) | 3 / 9 | 0 / 5 | – |
| Told to get safe in the first 2 replies | – | 100% / 13% | neither, for a warm outlet |
| Tenant messages per chat | 8.4 / 2.8 | 0 / 2.6 | 6.4 / 2.6 |
| Understood the problem (1–5) | 3.23 / 2.92 | 2.88 / 2.88 | 1.86 / 3.07 |

What wins is the **fixed safety rules** and the **structured ticket**. What loses is the **scripted conversation**:
- It is long: about three times as many tenant messages.
- It commits to one SOP and can't let go. Cockroaches went through the ants procedure all the way to the manager's ticket; every unknown pest becomes ants.
- With no matching SOP it has nothing to say. The garbage chute got "Describe the issue" as a troubleshooting step.
- Answers are read with English keywords. A French "Non" to the electrical check made a broken fan and a broken lamp into false emergencies; a Chinese "looks right" didn't confirm the summary, which then repeated four times.
- Fixed SOP steps can be unsafe for a tenant (turning a disposal with a hex key).
- It replies in English to tenants who wrote in Chinese or French.

### Shape

```
 tenant message
      │
      ▼
 1. Safety gate (code + a classifier) ── danger ──► fixed emergency reply, alert, then 1–2 questions for the manager
      │ no danger
      ▼
 2. Conversation model ◄── reference cards (top SOPs from retrieval), the ticket so far, the never-do list
      │  returns: reply, options, ticket field updates, ready?
      ▼
 3. Advice filter (code) ── unsafe line ──► removed and logged
      │
      ▼
 4. Ticket (code): required fields, diagnosis, confidence ──► confirm with the tenant ──► submitted
```

1. **Safety gate, every message, before the model.**
   - The keyword rules in `triage/emergency.ts` stay; they are fast and can't be talked out of an emergency.
   - A small classifier call reads the message in any language. It handles what keywords get wrong in both directions: "rotten-egg smell from the hot water" and "dust smell from a heater's first use" get one confirming question instead of an alarm; "the outlet is warm and the plate is brown" escalates even though no keyword matches.
   - Answers to safety questions are read by the model, not English keywords.
   - The emergency reply stays fixed text. After it, the chat asks one or two questions for the manager (where exactly, what you can see) instead of ending, so the emergency ticket isn't empty.
2. **The conversation model leads.** Each turn it gets the chat so far, the ticket so far, up to three **reference cards**, the property facts and the global never-do list. It returns structured output: the reply in the tenant's language, optional tap options, updates to ticket fields, and whether the ticket is ready.
   - It asks only what the cards say a tradesperson needs and what it doesn't know yet, one question at a time, aiming for 3–5 tenant messages.
   - It can switch cards mid-chat (the ants card is wrong once the tenant says cockroaches), or use none and rely on general knowledge for problems no card covers.
   - Safe steps come from the cards; for a problem with no card it may suggest only steps that pass the advice filter.
   - Photos stay a step the channel shows (Upload / Skip / Done); the model decides when to ask and what to photograph.
3. **Advice filter.** The never-instruct filter (`triage/step-safety.ts`, today applied to troubleshooting steps) runs on every reply. A line telling the tenant to open panels, handle wiring, shut the gas, move heavy appliances or use tools inside equipment is removed and logged.
4. **Ticket.** The same `TicketUpdate` and manager summary as today. The ticket has required fields (what, where, since when, how bad, what was tried); `diagnosis` comes from the card's causes when a card fits, and is marked low confidence otherwise. The confirm step uses the model to read "yes / that's right / 没问题 / c'est bon" or a correction.

### Reference cards

The SOP catalog stays the source; a card is a view of an SOP built at load time, so the catalog isn't rewritten:

| Card part | From the SOP | Used for |
|---|---|---|
| What the trade needs to know | `intake_questions` (question text and options only), `identify` | What to ask |
| Safe tenant steps | `tenant_steps`, `prevention` (after the advice filter) | What to suggest |
| Never tell the tenant | new `never` list, plus the global list | Prompt and filter |
| Escalate if | `escalate_if` | When to stop and hand over |
| Likely causes, trade, parts | `causes` | The manager's diagnosis only; never shown to the tenant |

Retrieval returns cards, not a single selected SOP. The general SOPs from #21 are dropped: with no card, the model works from general knowledge.

### What changes in the API

- `TurnRequest` and `TurnResponse` stay. `AssistantState` becomes `v: 2`: the messages so far, the ticket fields, the cards in use, and the safety state. A `v: 1` state finishes on the old code path, so open chats don't break during rollout.
- `phase` keeps its names for the app (`GATHER_INFO`, `AWAITING_MEDIA`, `CONFIRM_SUMMARY`, `DONE`, `EMERGENCY`). `GUIDED_TROUBLESHOOTING` is no longer a separate phase: the model gives steps inside the conversation.
- `options` comes from the model, so tap answers fit the actual question.

### How we know it's better

The head-to-head is the gate. The new design must, on the same cases:
- beat the plain LLM on problems with no SOP;
- keep the wins on the others: judge preference, readiness for the manager, unsafe advice;
- reach 100% "told to get safe in the first 2 replies" and 0 false emergencies on the covered cases;
- average 4 or fewer tenant messages per chat.

The scripted and coverage tiers change from "this exact question comes next" to "the ticket ends with these fields and this category", and the safety cases stay exact. Each full head-to-head run costs about $0.40.

### Build order

Each is a PR to staging; the old path stays the default until the last step.

1. **Safety gate**: the classifier, model-read safety answers, emergency follow-up questions. Useful on the old path too.
2. **Reference cards and retrieval** that returns several cards.
3. **Conversation model and the ticket fields**, behind a flag (`ASSISTANT_MODE=chat`), with the advice filter on every reply.
4. **Eval**: run the head-to-head on the flag; tune until it passes the gate.
5. **Switch the default**, remove the scripted path (`gather.ts`, `troubleshoot.ts`, the intake engine, the general SOPs) and re-ingest Pinecone once, with the card format.

### Open question

- **Reply language.** Decision 4 says English replies in the first version. The model can reply in the tenant's language at no extra cost, and the eval counts English replies against us. Proposed: reply in the tenant's language; fixed texts (emergency advice, the summary headings) stay in English until they are translated and checked.

## Decisions

Answered by Simone on 2026-10-26.

1. **Diagnosis: return only.** The assistant returns the diagnosis and a ticket update; the app writes tickets, alerts managers and sends email. It stays the only thing that touches tenant data.
2. **One repo, two deploy targets.** One codebase, built into two container images that run as two Cloud Run services (the app and the assistant), so the eval, the catalog and the API types stay in one place. To keep a later split cheap:
   - **Boundary test.** `tests/integration/test-assistant-boundary.ts` (#20) fails CI if `src/assistant/` imports anything from the app, Supabase or Next, so the folder can move to its own repo almost unchanged.
   - **Separate deploys.** Each service has its own deploy workflow with a path filter, so it only redeploys when its own files change (set up in step 4).
   - No CODEOWNERS file for now: Simone is the only one changing the code.

   Split into two repos only if a separate team or contractor owns the assistant, other products use it with their own release schedule, or one side's CI keeps blocking the other.
3. **Photos: not in the first version, but keep room for it.** The request has a reserved `media.images` field (short-lived signed links, no other data). Photo diagnosis (reading a model/serial label, for example) can use it later without changing the API.
4. **Languages: English replies in the first version.** The assistant already understands Chinese and French; replying in the tenant's language comes later.
5. **Separate production Supabase project: at the real-product launch, not now.** It is needed before real tenants use PropCare.

## Risks

| Risk | Mitigation |
|---|---|
| An extra network hop makes chat slower | Same region. A cold start is a second or two; keep `min-instances = 1` in production if it's noticeable. |
| Contact details slip into free text and reach the assistant | Removal in the channel, a second check in the assistant, no message text in production logs, and an eval case that sends contact details and checks they never appear in model input. |
| Two deployments drift apart | Versioned API (`/v1`), signed and versioned state, contract tests in CI, and the app records the catalog version on each ticket. |
| The assistant is down, so tenants can't report | The channel falls back to a simple form ("Describe the problem, add photos; your manager will follow up"), and emergencies are still caught by the deterministic rules in the app. |
