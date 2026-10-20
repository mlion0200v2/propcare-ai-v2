# Setting up PropCare

Two ways to run it:

- **[Run locally](#run-locally)** with Docker Desktop and the Supabase CLI. No hosted project, all emails captured locally. Start here.
- **[A brand-new hosted Supabase project](#a-brand-new-hosted-supabase-project)** for staging or production.

Either way the database comes from one migration,
`supabase/migrations/20261020000000_baseline.sql`: tables, row-level security,
functions and the private `ticket-media` storage bucket with its policies.
How access works is described in [docs/workspaces.md](docs/workspaces.md).

## Environment variables

Put these in `.env.local` (local) or in the hosting provider's settings.

| Variable | Needed | What it is |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase API URL (`http://127.0.0.1:54321` locally) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon (publishable) key |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service-role key. Server only; never expose it |
| `NEXT_PUBLIC_APP_URL` | yes | Public base URL of the app (`http://localhost:3000` locally). Used in emails, tenant links and QR posters |
| `INTAKE_CODE_SECRET` | production | 32+ random characters; signs tenants' one-time codes. Required when `NODE_ENV=production` |
| `OPENAI_API_KEY` | yes | Triage chat (classification help, troubleshooting steps, embeddings) |
| `PINECONE_API_KEY` | yes | SOP knowledge base |
| `PINECONE_INDEX` | yes | Index name, e.g. `propcare-kb` (dimension 1536, cosine) |
| `PINECONE_NAMESPACE` | no | Default `sop` |
| `RESEND_API_KEY` | for real email | Without it (or with `EMAIL_DRY_RUN=1`) the app logs emails instead of sending them |
| `EMAIL_FROM` | for real email | e.g. `PropCare <noreply@propcare.example.com>`; the domain must be verified in Resend |
| `EMAIL_DRY_RUN` | no | `1` = never send email from the app |
| `FALLBACK_MANAGER_EMAIL` | no | Last-resort recipient for ticket alerts when a workspace has no team email |
| `APP_TIME_ZONE` | no | Time zone for vendor booking times; default `America/Vancouver` |
| `RETRIEVAL_MIN_SCORE`, `RETRIEVAL_TOP_K`, `RETRIEVAL_MAX_CHARS`, `VALIDATION_*` | no | Retrieval tuning |

`openssl rand -base64 48` makes a good `INTAKE_CODE_SECRET`.

## Run locally

Requirements: Node.js 20+, **Docker Desktop** (on Windows with the **WSL 2**
backend: Settings → General → "Use the WSL 2 based engine"), and the
Supabase CLI, which is a dev dependency (`npx supabase …`).

```bash
npm install
npx supabase start
```

The first start downloads the Supabase containers (a few minutes). When it
finishes it prints the local API URL and keys. Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<"anon key" / publishable key printed by supabase start>
SUPABASE_SERVICE_ROLE_KEY=<"service_role key" / secret key printed by supabase start>
NEXT_PUBLIC_APP_URL=http://localhost:3000
EMAIL_DRY_RUN=1

# Still real services: the triage chat calls OpenAI and Pinecone.
OPENAI_API_KEY=sk-...
PINECONE_API_KEY=...
PINECONE_INDEX=propcare-kb
```

`npx supabase status` prints the URL and keys again at any time. Then:

```bash
npm run dev
```

and open http://localhost:3000.

**What you get** (`supabase start` applies the migration and `supabase/seed.sql`):

- A demo company workspace with three users, password `propcare-demo-1234`:
  `admin@example.test` (admin), `manager@example.test` (manager),
  `owner@example.test` (owner who sees one of the two homes).
- `tenant@example.test`, a tenant with an account (sign in with an email link).
- Two homes, three units, one request with comments in each visibility.
- Tenant links that work straight away:
  http://localhost:3000/r/demo-link-arbutus-unit-101 (also `…-unit-102`
  and `demo-link-oak-street-house`).

**Local tools**

- Supabase Studio (tables, auth users, storage): http://127.0.0.1:54323
- Mailpit, which captures every email Supabase Auth sends (sign-up
  confirmations, tenant sign-in links): http://127.0.0.1:54324
- Emails the app sends itself (invitations, tenant one-time codes, replies)
  are printed in the `npm run dev` console while `EMAIL_DRY_RUN=1` or
  `RESEND_API_KEY` is unset.

**Everyday commands**

```bash
npx supabase db reset   # rebuild the database from the migration + seed (wipes local data)
npx supabase status     # URLs and keys
npx supabase stop       # stop the containers (data is kept until the next reset)
```

Local settings (site URL, redirect URLs, email confirmation, anonymous
sign-ins, the storage bucket) live in `supabase/config.toml`.

**Tests don't need Docker.** `npx tsx tests/run.ts` runs the pure suite,
including the row-level-security tests, against an in-process Postgres
(PGlite) that applies the same migration and seed.

## A brand-new hosted Supabase project

Never point a local `.env.local` at production while developing.

1. **Create the project** (Canada region), then link the CLI and push the schema:
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push        # applies supabase/migrations (not seed.sql)
   ```
   Or paste `supabase/migrations/20261020000000_baseline.sql` into the SQL
   editor. Do **not** run `supabase/seed.sql` on a hosted project; it creates
   demo users with a published password.
2. **Authentication → URL Configuration**
   - Site URL: the app's public URL (same as `NEXT_PUBLIC_APP_URL`).
   - Redirect URLs: `<app URL>/auth/confirm` (add the staging URL too if
     staging shares the project).
3. **Authentication → Sign In / Providers**
   - Email: enabled, **Confirm email on** (a workspace is created only after
     the landlord confirms), secure email change on.
   - **Anonymous sign-ins on.** Tenants on a unit link get a guest session;
     row-level security gives it nothing until a one-time code is confirmed.
   - Attack protection: turn on CAPTCHA (hCaptcha or Turnstile) and keep the
     default rate limits.
4. **Authentication → Emails → SMTP settings: custom SMTP** (the built-in
   sender is for testing only and heavily rate-limited). With Resend: host
   `smtp.resend.com`, port `465`, user `resend`, password = a Resend API key,
   sender = an address on the verified domain.
5. **Authentication → Emails → Templates**: brand "Confirm signup", "Magic
   link" and "Change email address" (PropCare by Birchwood). Keep the link as
   `{{ .ConfirmationURL }}`; it lands on `/auth/confirm`.
6. **Resend**: verify the sending domain (SPF/DKIM DNS records) and set
   `EMAIL_FROM` and `RESEND_API_KEY` in the app's environment.
7. **App environment**: set every "yes" and "production" variable from the
   table above on the hosting provider, with the new project's URL and keys
   (Settings → API).
8. **Storage**: nothing to do. The migration creates the private
   `ticket-media` bucket and its policies; check it under Storage.
9. **First workspace**: sign up at `<app URL>/signup`, confirm the email, add
   homes and units, invite the team.

## Seed the SOP knowledge base (Pinecone)

The triage chat retrieves maintenance SOPs from Pinecone. Once per Pinecone
index (shared by local and hosted; it is not part of `supabase db reset`):

1. Create a serverless index named like `PINECONE_INDEX`, **dimension 1536,
   metric cosine** (matches OpenAI `text-embedding-3-small`).
2. With `OPENAI_API_KEY`, `PINECONE_API_KEY` and `PINECONE_INDEX` in
   `.env.local`:
   ```bash
   npx tsx scripts/ingest_sop_to_pinecone.ts scripts/propcare_sop_seed_50.jsonl
   ```
   This embeds and upserts 50 SOP snippets into the `sop` namespace
   (`PINECONE_NAMESPACE`). Re-running overwrites the same IDs.
3. Check retrieval: `npx tsx scripts/test_retrieval.ts "kitchen faucet leak"`.
4. To change the SOPs, edit `scripts/sop_seed_source.yaml`, run
   `npx tsx scripts/generate_sop_jsonl.ts` (writes `scripts/sop_seed.jsonl`),
   then ingest that file the same way.

If Pinecone is unreachable the chat falls back to built-in SOPs
(`src/lib/triage/sop-fallback.ts`).
