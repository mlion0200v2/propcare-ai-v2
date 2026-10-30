/**
 * The assistant boundary (docs/assistant-service.md): src/assistant imports
 * nothing from the app, the database or the framework, so it can move to
 * its own service unchanged; and what the app sends it carries no tenant
 * data (no access notes, contact details or address). No network.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";
import { photoStepAction, propertyContext, redactContactDetails, stateFromTicket } from "../../src/lib/assistant-request";

const ROOT = join(__dirname, "..", "..");
const ASSISTANT = join(ROOT, "src", "assistant");

/** Packages the assistant may use; everything else (supabase, next, resend, server-only, ...) belongs to the app. */
const ALLOWED_PACKAGES = ["zod", "openai", "@pinecone-database/pinecone"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function importsOf(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/(?:from|import|require\()\s*["']([^"']+)["']/g)) specs.push(m[1]);
  return specs;
}

/** Why this import crosses the boundary, or null if it doesn't. */
function violation(file: string, spec: string): string | null {
  if (spec.startsWith("node:")) return null;
  if (spec.startsWith("@/")) return spec.startsWith("@/assistant/") || spec === "@/assistant" ? null : "imports the app";
  if (spec.startsWith(".")) {
    const target = resolve(join(file, ".."), spec);
    return relative(ASSISTANT, target).startsWith("..") ? "reaches outside src/assistant" : null;
  }
  return ALLOWED_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`)) ? null : "uses an app-only package";
}

export function testAssistantBoundary(): TestResult {
  printSection("Assistant boundary (no app imports, no tenant data)");
  const { pass, fail, result } = createRunner();
  const check = (ok: boolean, label: string, detail?: unknown) => (ok ? pass(label) : fail(label, detail));

  const files = sourceFiles(ASSISTANT);
  const crossings = files.flatMap((file) =>
    importsOf(readFileSync(file, "utf8")).flatMap((spec) => {
      const why = violation(file, spec);
      return why ? [`${relative(ROOT, file)}: "${spec}" ${why}`] : [];
    })
  );
  check(files.length > 20, `scanned ${files.length} assistant files`);
  check(crossings.length === 0, "src/assistant imports nothing from the app, Supabase or Next", crossings);

  // The app sends the unit's non-sensitive details only.
  const context = propertyContext({
    rooms: ["Kitchen"],
    fixtures: [{ name: "Fridge", room: "Kitchen", brand: "LG", model: "LRMVS3006S" }],
    water_shutoff: "Under the kitchen sink",
    access_notes: "Door code 4412, key in the lockbox",
  });
  check(!JSON.stringify(context).includes("4412") && !("access_notes" in context), "property context leaves out access notes (door codes)", context);
  check(context.fixtures[0]?.model === "LRMVS3006S" && context.water_shutoff === "Under the kitchen sink", "property context keeps fixtures and shut-offs");

  // Contact details a tenant types are taken out before the assistant sees them.
  const cases: [string, string][] = [
    ["email me at jane.doe+1@example.com", "jane.doe"],
    ["call 604-555-1234 or (778) 555 9876", "555"],
    ["I'm at 4500 West 10th Avenue, unit 3", "4500"],
    ["postal code V6R 2H3", "V6R"],
  ];
  for (const [text, secret] of cases) {
    const redacted = redactContactDetails(text);
    check(!redacted.includes(secret), `redacts: "${text}"`, redacted);
  }
  const kept = "my sink has leaked for 2 days, about 3 cups of water";
  check(redactContactDetails(kept) === kept, "leaves ordinary details alone (numbers, amounts)", redactContactDetails(kept));

  // Tickets from before the boundary are lifted into the assistant's state.
  const legacy = stateFromTicket({
    description: "sink leaking, call me at 604-555-1234",
    triage_state: "GATHER_INFO",
    classification: { gathered: { category: "plumbing" }, current_question: "location_in_unit" },
  });
  check(legacy?.v === 1 && legacy.phase === "GATHER_INFO" && !legacy.description.includes("555"), "old tickets: state lifted with phase, description redacted", legacy);
  check(stateFromTicket({ description: "x", triage_state: "GATHER_INFO", classification: null }) === null, "no stored state → null (the route answers 409)");

  // While the photo buttons show: only the buttons (or a bare "skip") are photo actions.
  const act = (mediaAction: string | undefined, message: string, media: number) => photoStepAction(mediaAction, message, media).action;
  check(act("skip", "", 0) === "skip_photos" && act("done", "", 2) === "photos_added", "photo step: the Skip and Done buttons");
  check(act(undefined, "skip", 0) === "skip_photos" && act(undefined, "no thanks", 0) === "skip_photos" && act(undefined, "跳过", 0) === "skip_photos", "photo step: a bare 'skip' typed is a skip");
  check(act(undefined, "no, it's on the carpet by the closet", 0) === undefined, "photo step: a typed answer starting with 'no' is a message, not a skip");
  check(act(undefined, "it's small and hairy", 0) === undefined, "photo step: a typed answer is a message, not 'photos added'");
  check(act(undefined, "that's the one by the closet", 1) === "photos_added", "photo step: words after an upload count the photo as added");

  return result;
}

const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-assistant-boundary");
if (isMain) runStandalone(testAssistantBoundary);
