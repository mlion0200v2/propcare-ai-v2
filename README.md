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

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project
- A [Pinecone](https://www.pinecone.io) index (dimension: 1536, metric: cosine)
- An [OpenAI](https://platform.openai.com) API key
- A [Resend](https://resend.com) API key (for email notifications)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env.local` file in the project root:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# OpenAI (embeddings + grounding)
OPENAI_API_KEY=sk-...

# Pinecone (vector search)
PINECONE_API_KEY=your-pinecone-key
PINECONE_ENVIRONMENT=us-east-1
PINECONE_INDEX=propcare-kb
PINECONE_NAMESPACE=sop

# Retrieval tuning (optional)
RETRIEVAL_MIN_SCORE=0.40

# Email notifications
RESEND_API_KEY=re_...
FALLBACK_MANAGER_EMAIL=manager@example.com

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3. Set up the database

Run the Supabase migrations in order:

```bash
# Via Supabase CLI
supabase db push

# Or apply migrations manually in the Supabase SQL Editor:
#   supabase/migrations/001_initial_schema.sql
#   supabase/migrations/002_nullable_unit_id.sql
#   supabase/migrations/003_profiles_defaults.sql
#   supabase/migrations/004_storage_policies.sql
```

### 4. Seed the knowledge base

Ingest SOP documents into Pinecone:

```bash
npx tsx scripts/ingest_sop_to_pinecone.ts
```

This reads `scripts/propcare_sop_seed_50.jsonl` and upserts 50 SOP snippets covering plumbing, electrical, HVAC, appliance, pest control, and more.

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

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

Key tables with Row-Level Security:

| Table | Purpose |
|-------|---------|
| `profiles` | Users (tenant or manager role) |
| `properties` | Buildings owned by managers |
| `units` | Individual units within properties |
| `tickets` | Maintenance issues with JSONB classification |
| `messages` | Chat history (sender, body, is_bot_reply) |
| `ticket_media` | Uploaded photos and videos |
| `vendors` | Contractor list per manager |

The `tickets.classification` JSONB column stores the full triage state: gathered fields, issue classification, safety detection, media refs, retrieval results, validation, guided troubleshooting log, and PM summary.

## Testing

```bash
# Pure tests (no external services)
npx tsx tests/run.ts

# Include Supabase integration tests
RUN_INTEGRATION=1 npx tsx tests/run.ts

# Full suite (Supabase + Pinecone + OpenAI)
RUN_INTEGRATION=1 RUN_EXTERNAL=1 npx tsx tests/run.ts
```

Test suites cover: state machine logic, classification, safety detection, retrieval pipeline, grounding validation, guided troubleshooting feedback, edge cases (pest, plumbing), RLS policies, and end-to-end flows.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npx tsx scripts/ingest_sop_to_pinecone.ts` | Ingest SOPs into Pinecone |
| `npx tsx scripts/generate_sop_jsonl.ts` | Generate JSONL from YAML source |

## License

Private - All rights reserved.
