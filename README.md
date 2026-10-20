# PropCare-AI v2

AI-powered property maintenance triage system for multi-unit residential properties. Tenants report issues through a conversational chat interface; the system automatically classifies problems, detects safety concerns, retrieves relevant SOPs, generates troubleshooting steps, and prepares structured handoffs for property managers.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict) |
| Database | Supabase (PostgreSQL + RLS) |
| Vector DB | Pinecone v7 |
| LLM | OpenAI gpt-4o-mini |
| Embeddings | OpenAI text-embedding-3-small |
| Auth | Supabase Auth (password-based, JWT) |
| Email | Resend |
| Styling | Tailwind CSS 4 |
| Validation | Zod |

## Architecture

The triage pipeline is built around a **deterministic state machine** that drives a one-question-per-turn conversation. LLM calls are used only where keyword rules are insufficient.

```
Tenant message
  │
  ├─ 1. Acknowledge ─────────── friendly first response
  ├─ 2. Auto-classify ───────── keyword rules (no LLM)
  ├─ 3. Detect safety ───────── auto-detect + targeted questions
  ├─ 4. Gather fields ───────── location, timing, status, brand/model
  ├─ 5. Retrieve SOPs ───────── Pinecone vector search
  ├─ 6. Ground steps ─────────── gpt-4o-mini + SOP citations
  ├─ 7. Validate ─────────────── post-grounding quality gate
  ├─ 8. Guided troubleshoot ──── step-by-step with feedback
  └─ 9. Summarize ────────────── PM-facing handoff
```

### Triage States

`CONFIRM_PROFILE` → `COLLECT_TENANT_INFO` → `GATHER_INFO` → `AWAITING_MEDIA` → `GUIDED_TROUBLESHOOTING` → `DONE`

### Key Design Decisions

- **Deterministic first**: Classification and safety detection use keyword rules before any LLM call
- **Pure functions**: State machine, classification, and safety detection have no side effects
- **Citation grounding**: Generated steps include `[SOP-N]` citations matched to retrieval results
- **Hybrid feedback**: Regex fast-path for clear tenant responses, LLM fallback for ambiguous ones
- **Audit trail**: Retrieval scores, validation results, and interpretation sources are persisted in JSONB

## Project Structure

```
src/
├── app/
│   ├── api/triage/
│   │   ├── chat/route.ts          # POST/GET triage chat (state machine)
│   │   └── media/route.ts         # POST media upload
│   ├── (auth)/                    # Login / signup pages
│   ├── (tenant)/submit/           # Triage chat UI
│   └── (manager)/dashboard/       # Ticket dashboard + detail views
│
├── components/
│   ├── triage/chat.tsx            # Client-side chat component
│   └── ui/                        # Card, Button, Input
│
├── lib/
│   ├── triage/
│   │   ├── state-machine.ts       # Deterministic state machine
│   │   ├── classify-issue.ts      # Keyword-based classification
│   │   ├── detect-safety.ts       # Emergency detection
│   │   ├── acknowledgement.ts     # First response generation
│   │   ├── gather-issue.ts        # Extended field gathering
│   │   ├── grounding.ts           # SOP → guided steps (gpt-4o-mini)
│   │   ├── validate.ts            # Post-grounding quality gate
│   │   ├── step-feedback.ts       # Regex feedback classification
│   │   ├── interpret-step-response.ts  # LLM feedback interpretation
│   │   ├── summary.ts             # PM handoff summary
│   │   ├── sop-fallback.ts        # Hardcoded fallback SOPs
│   │   └── types.ts               # Triage type definitions
│   │
│   ├── retrieval/
│   │   ├── pinecone.ts            # Pinecone query orchestration
│   │   └── embedding.ts           # OpenAI embedding generation
│   │
│   └── supabase/
│       ├── client.ts              # Browser client
│       └── server.ts              # Server client + service role
│
├── middleware.ts                   # Auth routing middleware
│
supabase/migrations/               # PostgreSQL migrations (RLS enabled)
scripts/                           # SOP ingestion tooling
tests/                             # Integration + unit tests
```

## Getting Started

See **[SETUP.md](SETUP.md)**: run everything locally with Docker and the
Supabase CLI (`npx supabase start`, demo data included), set up a brand-new
hosted Supabase project, environment variables, and seeding the Pinecone SOP
knowledge base.

## API Endpoints

### `POST /api/triage/chat`

Create a new ticket or advance an existing triage conversation.

**Request body:**
```json
{
  "message": "My kitchen sink is leaking",
  "ticket_id": "uuid (optional, omit for new ticket)",
  "confirm_profile": "boolean (optional)",
  "media_action": "'skip' | 'done' (optional)"
}
```

**Response:**
```json
{
  "ticket_id": "uuid",
  "reply": "I'm sorry to hear about the leak...",
  "triage_state": "GATHER_INFO",
  "is_complete": false
}
```

### `GET /api/triage/chat`

Resume an in-progress triage session.

### `POST /api/triage/media`

Upload a photo or video to an existing ticket.

- **Allowed types**: JPEG, PNG, WebP, HEIC, MP4, MOV, WebM
- **Max size**: 25 MB
- **Limits**: 5 photos + 1 video per ticket

## Issue Categories

plumbing, electrical, hvac, appliance, structural, pest_control, locksmith, roofing, painting, flooring, landscaping, general, other

## Database Schema

One baseline migration (`supabase/migrations/20261020000000_baseline.sql`),
row-level security on every table, keyed by workspace membership:

| Table | Purpose |
|-------|---------|
| `workspaces`, `memberships`, `invitations` | A landlord's or management company's workspace; members with a role (admin, manager, owner) |
| `properties`, `units`, `owner_property_access` | Homes and units (each unit has a tenant link); which homes an owner sees |
| `tenancies`, `tenancy_verifications`, `intake_codes` | Tenants of a unit, devices that confirmed a one-time code, the codes (hashed) |
| `tickets`, `messages`, `ticket_media` | Requests, the triage chat, photos/videos |
| `ticket_comments`, `approvals` | Team / team-and-owner / to-tenant comments; owner approval of quotes |
| `profiles`, `vendors` | Names and contact details; contractors per workspace |

The `tickets.classification` JSONB column stores the full triage state: gathered fields, issue classification, safety detection, media refs, retrieval results, validation, guided troubleshooting log, and PM summary. Access rules: [docs/workspaces.md](docs/workspaces.md).

## Testing

```bash
# Pure tests (no external services)
npx tsx tests/run.ts

# Include checks against a running Supabase (e.g. local `npx supabase start`)
RUN_INTEGRATION=1 npx tsx tests/run.ts

# Full suite (Supabase + Pinecone + OpenAI)
RUN_INTEGRATION=1 RUN_EXTERNAL=1 npx tsx tests/run.ts
```

Test suites cover: state machine logic, classification, safety detection, retrieval pipeline, grounding validation, guided troubleshooting feedback, edge cases (pest, plumbing), and row-level security (`tests/integration/test-workspace-rls.ts`, run against the real migration and seed in an in-process Postgres, no Docker needed).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npx tsx scripts/ingest_sop_to_pinecone.ts scripts/propcare_sop_seed_50.jsonl` | Ingest SOPs into Pinecone |
| `npx tsx scripts/generate_sop_jsonl.ts` | Generate JSONL from YAML source |

## License

Private - All rights reserved.
