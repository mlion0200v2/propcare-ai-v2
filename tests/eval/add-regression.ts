/**
 * Add a real tenant message to the eval as a regression case.
 *
 *   npx tsx tests/eval/add-regression.ts "rangehood is leaking gease"
 *   npx tsx tests/eval/add-regression.ts --transcript chat.txt
 *   npx tsx tests/eval/add-regression.ts "..." --expect substance=grease,room=kitchen --emergency no --sop range_hood_grease_drip
 *
 * A transcript is pasted chat text; the first tenant line is used (lines
 * starting "Tenant:", "Me:", "You:" or "User:", else the first line).
 * Expected values start from today's understanding and are overridden by
 * --expect; check the printed line before committing
 * tests/eval/corpus/regressions.jsonl. Regression cases must pass exactly
 * in CI (frame, emergency, no re-asked or irrelevant questions).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rulesFrame } from "../../src/lib/understanding/rules";
import { FRAME_FIELDS } from "../../src/lib/understanding/frame";
import type { CorpusCase } from "./frame-eval";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function firstTenantLine(transcript: string): string {
  const lines = transcript.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tenant = lines.find((l) => /^(tenant|me|you|user)\s*:/i.test(l));
  return (tenant ?? lines[0] ?? "").replace(/^(tenant|me|you|user)\s*:\s*/i, "");
}

const file = arg("--transcript");
const message = file ? firstTenantLine(readFileSync(file, "utf8")) : process.argv[2];
if (!message || message.startsWith("--")) {
  console.error('Usage: npx tsx tests/eval/add-regression.ts "<first message>" [--expect field=value,...] [--emergency yes|no] [--sop issue_key]');
  process.exit(1);
}

const f = rulesFrame(message);
const expected = { equipment: f.equipment, symptom: f.symptom, substance: f.substance, room: f.room };
for (const pair of (arg("--expect") ?? "").split(",").filter(Boolean)) {
  const [k, v] = pair.split("=");
  if (!(FRAME_FIELDS as readonly string[]).includes(k)) throw new Error(`unknown field ${k}`);
  (expected as Record<string, string>)[k] = v;
}
const emergencyArg = arg("--emergency");
const record: CorpusCase = {
  id: `regression-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`,
  message,
  lang: /[㐀-鿿]/.test(message) ? "zh" : /[àâçéèêëîïôûùüÿœ]/i.test(message) ? "fr" : "en",
  style: "real",
  expected,
  emergency: emergencyArg ? emergencyArg === "yes" : f.severity === "emergency",
  sop: arg("--sop"),
  source: "regression",
};
const target = join(__dirname, "corpus", "regressions.jsonl");
appendFileSync(target, JSON.stringify(record) + "\n");
console.log(`Added to ${target}:\n${JSON.stringify(record, null, 2)}`);
console.log("\nToday's understanding was used for unspecified fields — correct them in the file if they're wrong, then run:");
console.log("  npx tsx tests/eval/frame-eval.ts --failures");
