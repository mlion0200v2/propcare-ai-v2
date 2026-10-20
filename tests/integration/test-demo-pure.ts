/**
 * Test: try mode and dispatch helpers (pure, no network)
 * Run:  npx tsx tests/integration/test-demo-pure.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import { demoDestination, ticketIdFromPath, vendorTokenFromPath, demoChatTurnLimit } from "../../src/lib/demo/config";
import { buildVendorWorkOrderMessage, whatsappLink } from "../../src/lib/messages";
import { isReservedAddress } from "../../src/lib/email/reserved";

const SRC = join(__dirname, "..", "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

export function testDemoPure(): TestResult {
  printSection("Try mode and dispatch (pure)");
  const { pass, fail, result } = createRunner();
  const check = (cond: boolean, msg: string, detail?: unknown) => (cond ? pass(msg) : fail(msg, detail));

  // Role switcher keeps the same ticket in view
  const id = "00000000-0000-4000-8000-000000000001";
  const t = { id, ownerCanSee: true, tenantCanSee: true, vendorToken: "a".repeat(64) };
  check(demoDestination("manager", t) === `/tickets/${id}`, "switch to Manager: same ticket");
  check(demoDestination("owner", t) === `/tickets/${id}`, "switch to Owner: same ticket when it's their home");
  check(demoDestination("owner", { ...t, ownerCanSee: false }) === "/dashboard", "Owner never lands on a ticket they can't see");
  check(demoDestination("tenant", t) === `/my-requests/${id}`, "switch to Tenant: their view of the ticket");
  check(demoDestination("tenant", { ...t, tenantCanSee: false }) === "/my-requests", "Tenant never lands on someone else's ticket");
  check(demoDestination("vendor", t) === `/v/${"a".repeat(64)}`, "switch to Vendor: the work order link");
  check(ticketIdFromPath(`/tickets/${id}`) === id && ticketIdFromPath(`/my-requests/${id}`) === id && ticketIdFromPath("/dashboard") === null, "ticket id read from the current page");
  check(vendorTokenFromPath(`/v/${"b".repeat(64)}`) === "b".repeat(64) && vendorTokenFromPath("/v/../x") === null, "vendor token read from the current page");
  check(demoChatTurnLimit() === 40, "40 chat turns per sandbox by default");

  // Messages and share links
  const m = buildVendorWorkOrderMessage({ workspaceName: "Demo Rentals", vendorName: "Westside Plumbing", title: "Kitchen sink, slow drain", address: "3076 Arbutus Street, Unit 304", link: "https://app.test/v/abc" });
  check(m.text.includes("https://app.test/v/abc") && m.text.includes("Unit 304") && !/rent|owner/i.test(m.text), "vendor message: link and address, no rent or owner");
  const wa = whatsappLink("Hi & welcome", "604-555-0199");
  check(wa === "https://wa.me/16045550199?text=Hi%20%26%20welcome", "WhatsApp link: number normalised, text encoded", wa);
  check(whatsappLink("x").startsWith("https://wa.me/?text="), "WhatsApp link without a number lets the manager pick a contact");

  // Nothing leaves a demo
  check(isReservedAddress("demo-abc-admin@example.com") && isReservedAddress("x@y.test") && !isReservedAddress("simone@birchwoodcorp.com"), "reserved example domains are recognised");
  const mailer = read("lib", "email", "mailer.ts");
  check(/isReservedAddress\(/.test(mailer), "the mailer never sends to example domains");
  const ticketMail = read("lib", "email", "send-ticket-email.ts");
  check(!/new Resend|getResend/.test(ticketMail) && /deliver\(/.test(ticketMail), "ticket alerts go through deliver() (no direct Resend client)");
  for (const f of [["lib", "actions", "tickets.ts"], ["lib", "actions", "workspace.ts"]]) {
    const src = read(...f);
    check(!/sendEmail\(/.test(src) && /deliver\(/.test(src), `${f.join("/")} sends only through deliver()`);
  }
  const delivery = read("lib", "delivery.ts");
  check(/isDemoWorkspace\(workspaceId\)[\s\S]*from\("outbox"\)\.insert/.test(delivery), "deliver() puts demo messages in the outbox instead of sending");
  const intake = read("lib", "actions", "intake.ts");
  check(/isDemoWorkspace\(unit\.workspace_id\)[\s\S]*demoPreview/.test(intake), "demo homes show the one-time code instead of emailing it");

  // Guardrails
  const actions = read("lib", "actions", "demo.ts");
  check(/isDemoMode\(\)/.test(actions) && /demoCreateLimiter\.check\(/.test(actions), "sandbox creation needs DEMO_MODE=1 and is rate-limited per IP");
  const chat = read("app", "api", "triage", "chat", "route.ts");
  check(/demo_take_chat_turn/.test(chat) && /!isEmergencyMessage/.test(chat), "chat turns are capped per sandbox; emergencies never are");
  const cleanup = read("app", "api", "demo", "cleanup", "route.ts");
  check(/CRON_SECRET/.test(cleanup) && /timingSafeEqual/.test(cleanup), "cleanup route needs the cron secret");
  const tryPage = read("app", "try", "page.tsx");
  check(/isDemoMode\(\)\) notFound\(\)/.test(tryPage), "/try is a 404 unless DEMO_MODE=1");
  const vendorPage = read("app", "v", "[token]", "page.tsx");
  check(
    !/from\("(owner_property_access|memberships|approvals|profiles)"\)/.test(vendorPage) && /include_tenant_phone &&/.test(vendorPage),
    "vendor page reads no owner, member or approval data; tenant phone only if allowed"
  );

  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-demo-pure");
if (isMain) runStandalone(() => testDemoPure());
