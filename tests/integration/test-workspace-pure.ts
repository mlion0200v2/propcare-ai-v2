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
  for (const page of ["homes/page.tsx", "homes/[id]/page.tsx", "team/page.tsx", "settings/page.tsx", "dashboard/page.tsx", "tickets/[id]/page.tsx"]) {
    const src = readFileSync(join(SRC, "app", "(manager)", page), "utf8");
    check(/require(Team|Admin|Membership)\(\)/.test(src), `server-side membership check on (manager)/${page}`);
  }

  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-workspace-pure");
if (isMain) runStandalone(() => testWorkspacePure());
