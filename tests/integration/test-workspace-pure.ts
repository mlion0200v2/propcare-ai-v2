/**
 * Test: workspace helpers (pure, no network)
 * Run:  npx tsx tests/integration/test-workspace-pure.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import { dollarsToCents, generateToken, hashToken } from "../../src/lib/workspace/tokens";
import { safeNextPath } from "../../src/lib/app-url";
import { buildInvitationEmail } from "../../src/lib/email/templates";
import { inviteSchema } from "../../src/lib/utils/validation";
import { codeMatches, generateCode, hashCode, maskDestination, parseContact } from "../../src/lib/intake/codes";
import { createRateLimiter } from "../../src/lib/rate-limit";
import { utcToZonedLocal, zonedLocalToUtc } from "../../src/lib/utils/time";
import { buildTenantReplyEmail } from "../../src/lib/email/templates";
import { ticketCommentSchema } from "../../src/lib/utils/validation";

const SRC = join(__dirname, "..", "..", "src");

export function testWorkspacePure(): TestResult {
  printSection("Workspace helpers (pure)");
  const { pass, fail, result } = createRunner();
  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));

  // Tokens
  const t1 = generateToken();
  const t2 = generateToken();
  check(t1 !== t2 && /^[A-Za-z0-9_-]{32}$/.test(t1), "invite tokens are 192-bit, URL-safe and unique", t1);
  check(
    hashToken("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "hashToken is sha256 hex (matches SQL sha256(convert_to(token,'UTF8')))"
  );

  // Money
  check(dollarsToCents("300") === 30000, "dollarsToCents: 300 → 30000");
  check(dollarsToCents("$1,250.5") === 125050, "dollarsToCents: $1,250.5 → 125050");
  check(dollarsToCents("-5") === null && dollarsToCents("abc") === null && dollarsToCents("1.234") === null, "dollarsToCents rejects bad input");

  // Redirect targets
  check(safeNextPath("/invite/abc") === "/invite/abc", "safeNextPath keeps same-site paths");
  check(
    safeNextPath("//evil.example") === null && safeNextPath("https://evil.example") === null && safeNextPath("/\\evil") === null,
    "safeNextPath rejects off-site redirects"
  );

  // Invitations
  check(!inviteSchema.safeParse({ email: "a@b.co", role: "admin", property_ids: [] }).success, "invite schema refuses the admin role");
  check(inviteSchema.safeParse({ email: " A@B.CO ", role: "owner", property_ids: [] }).data?.email === "a@b.co", "invite emails are normalised to lower case");
  const mail = buildInvitationEmail({
    workspaceName: "Birchwood",
    inviterName: "Simone",
    role: "owner",
    link: "https://app.test/invite/xyz",
    expiresInDays: 14,
  });
  check(mail.text.includes("https://app.test/invite/xyz") && mail.subject.includes("Birchwood"), "invitation email has the link and workspace");

  // No role from user_metadata anywhere in the app
  const files = ["middleware.ts", "app/page.tsx", "lib/actions/auth.ts", "lib/workspace/server.ts", "app/(manager)/layout.tsx"];
  const offenders = files.filter((f) => /user_metadata\??\.role/.test(readFileSync(join(SRC, f), "utf8")));
  check(offenders.length === 0, "no access decision reads user_metadata.role", offenders);
  const tenantsSrc = readFileSync(join(SRC, "app", "(manager)", "tenants", "page.tsx"), "utf8");
  check(!/createServiceClient/.test(tenantsSrc) && /requireTeam\(\)/.test(tenantsSrc), "/tenants uses the user's session and a team check");
  for (const page of ["homes/page.tsx", "homes/[id]/page.tsx", "team/page.tsx", "settings/page.tsx", "dashboard/page.tsx", "tickets/[id]/page.tsx", "units/[id]/page.tsx"]) {
    const src = readFileSync(join(SRC, "app", "(manager)", page), "utf8");
    check(/require(Team|Admin|Membership)\(\)/.test(src), `server-side membership check on (manager)/${page}`);
  }

  // Tenant link: contacts and one-time codes
  check(JSON.stringify(parseContact(" Jamie@Example.com ")) === JSON.stringify({ channel: "email", destination: "jamie@example.com" }), "contact: email is normalised");
  check(parseContact("604-555-0142")?.destination === "+16045550142" && parseContact("604-555-0142")?.channel === "sms", "contact: NA phone → E.164 sms");
  check(parseContact("+44 20 7946 0958")?.destination === "+442079460958", "contact: international phone kept");
  check(parseContact("hello") === null && parseContact("123") === null && parseContact("a@b") === null, "contact: junk rejected");
  check(maskDestination("email", "jamie@example.com") === "j••••@example.com" && maskDestination("sms", "+16045550142") === "•••-•••-0142", "contacts are masked on screen");
  const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
  check([...codes].every((c) => /^\d{6}$/.test(c)) && codes.size > 190, "codes are 6 random digits");
  const h = hashCode("123456", "unit-a", "jamie@example.com");
  check(codeMatches("123456", "unit-a", "jamie@example.com", h), "code matches its unit and destination");
  check(
    !codeMatches("123457", "unit-a", "jamie@example.com", h) &&
      !codeMatches("123456", "unit-b", "jamie@example.com", h) &&
      !codeMatches("123456", "unit-a", "eve@example.com", h) &&
      !codeMatches("12345", "unit-a", "jamie@example.com", h),
    "code is bound to unit + destination and must be exact"
  );
  check(!h.includes("123456") && h.length === 64, "only an HMAC of the code is stored");

  // Rate limits on the tenant link: a destination gets at most 3 codes per 10 minutes
  {
    let now = 0;
    const perDestination = createRateLimiter([{ limit: 3, windowMs: 10 * 60_000 }, { limit: 10, windowMs: 86_400_000 }], () => now);
    const firstThree = [1, 2, 3].map(() => perDestination.check("jamie@example.com").allowed);
    const fourth = perDestination.check("jamie@example.com").allowed;
    now = 11 * 60_000;
    check(firstThree.every(Boolean) && !fourth && perDestination.check("jamie@example.com").allowed, "code sends are throttled per destination");
  }
  const intakeSrc = readFileSync(join(SRC, "lib", "actions", "intake.ts"), "utf8");
  check(
    ["intakeCodeIpLimiter", "intakeCodeLinkLimiter", "intakeCodeDestinationLimiter", "intakeVerifyLimiter", "magicLinkLimiter"].every((l) => intakeSrc.includes(`${l}.check(`)),
    "intake actions apply IP, link, destination, verify and magic-link rate limits"
  );
  check(/MAX_CODE_ATTEMPTS/.test(intakeSrc) && /\.is\("consumed_at", null\)/.test(intakeSrc), "codes have an attempt cap and are single-use");
  const linkPage = readFileSync(join(SRC, "app", "r", "[token]", "page.tsx"), "utf8");
  check(/intakeLinkLimiter\.check\(/.test(linkPage) && /findUnitByToken/.test(linkPage), "opening a tenant link is rate-limited and only resolves active links");

  // Ticket collaboration
  check(zonedLocalToUtc("2026-10-21T09:00", "America/Vancouver")?.toISOString() === "2026-10-21T16:00:00.000Z", "vendor time: Vancouver summer time → UTC");
  // (BC is on permanent daylight time from late 2026 in current tz data, so DST is checked with Toronto.)
  check(
    zonedLocalToUtc("2026-07-01T09:00", "America/Toronto")?.toISOString() === "2026-07-01T13:00:00.000Z" &&
      zonedLocalToUtc("2026-12-01T09:00", "America/Toronto")?.toISOString() === "2026-12-01T14:00:00.000Z",
    "vendor time follows daylight-saving changes"
  );
  check(utcToZonedLocal("2026-10-21T16:00:00.000Z", "America/Vancouver") === "2026-10-21T09:00", "vendor time round-trips for the form");
  check(zonedLocalToUtc("tomorrow", "America/Vancouver") === null, "vendor time rejects junk");
  check(!ticketCommentSchema.safeParse({ ticket_id: "00000000-0000-4000-8000-000000000000", visibility: "public", body: "x" }).success, "comment visibility is one of team / team_owner / tenant");
  check(!ticketCommentSchema.safeParse({ ticket_id: "00000000-0000-4000-8000-000000000000", visibility: "team", body: "   " }).success, "empty comments are rejected");
  const reply = buildTenantReplyEmail({ workspaceName: "Birchwood", authorName: "Simone", ticketTitle: "Sink", body: "Plumber Tuesday 9-11", link: null });
  check(reply.text.includes("Plumber Tuesday 9-11") && !reply.text.includes("See your request"), "tenant reply email carries the message; no link for guests");
  const ticketActions = readFileSync(join(SRC, "lib", "actions", "tickets.ts"), "utf8");
  check(/visibility === "tenant"[\s\S]*emailTenant/.test(ticketActions) && /deliver\(/.test(ticketActions), "only 'to tenant' comments are emailed, through deliver() (dry-run and demo aware)");
  check(/commentLimiter\.check\(/.test(ticketActions), "comments are rate-limited");
  check(/from\("ticket_comments"\)\s*\.insert/.test(ticketActions) && /await createClient\(\)/.test(ticketActions), "comments are written with the user's session (RLS decides visibility rights)");

  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-workspace-pure");
if (isMain) runStandalone(() => testWorkspacePure());
