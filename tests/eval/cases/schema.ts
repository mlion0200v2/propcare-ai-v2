/**
 * The eval case format: one JSON object per line in tests/eval/cases/<area>.jsonl.
 * See tests/eval/cases/README.md for how to write one.
 *
 *   tenant  drives the simulated tenant (what they know, can't know, how they write)
 *   truth   what is really going on; the assistant never sees it
 *   expect  checks scored by code (./checks.ts)
 *   judge   what the judge model scores 1–5
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadCards } from "../../../src/assistant/cards";
import { TICKET_CATEGORIES } from "../../../src/assistant/chat/types";

export const AREAS = [
  "plumbing",
  "hvac",
  "electrical",
  "appliance",
  "interior",
  "exterior",
  "locks_security",
  "pest",
  "building",
  "safety",
  "not_repair",
] as const;
export type Area = (typeof AREAS)[number];

export const TICKET_FIELDS = ["issue", "location", "started", "severity", "equipment", "brand_model", "tried", "facts", "category"] as const;
const Urgency = z.enum(["low", "medium", "high"]);

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase words joined by -"),
    source: z.enum(["real", "written", "regression"]),
    split: z.enum(["tune", "holdout"]),
    area: z.enum(AREAS),
    tags: z.array(z.string()),
    lang: z.enum(["en", "zh", "fr"]),
    first: z.string().min(1),
    tenant: z.object({
      situation: z.string().min(10),
      /** Answers to the questions a good assistant would ask: appearance, where, since, how_bad, tried… */
      knows: z.record(z.string(), z.string()),
      doesnt_know: z.array(z.string()),
      has_photo: z.boolean(),
      style: z.string().optional(),
    }),
    truth: z.object({
      problem: z.string(),
      category: z.enum(TICKET_CATEGORIES),
      dangerous: z.boolean(),
      urgency: Urgency,
    }),
    expect: z
      .object({
        /** The chat ends in the EMERGENCY phase (keyword or model safety gate). */
        emergency: z.boolean().optional(),
        /** The manager is alerted urgently: an emergency, or the chat escalated. */
        escalate: z.boolean().optional(),
        /** Photos were asked for at some point (the upload buttons were shown). */
        photo_asked: z.boolean().optional(),
        /** Photos were asked for in this reply or earlier (1 = the first reply). */
        photo_asked_by_reply: z.number().int().min(1).optional(),
        /** The card the model ended on is one of these ("none" = no card). */
        card_in: z.array(z.string()).optional(),
        category_in: z.array(z.enum(TICKET_CATEGORIES)).optional(),
        urgency_in: z.array(Urgency).optional(),
        /** None of these appear in any reply (case-insensitive). */
        must_not_say: z.array(z.string()).optional(),
        /** These ticket fields are filled in at the end. */
        ticket_has: z.array(z.enum(TICKET_FIELDS)).optional(),
        /** Each named ticket field contains one of these words (case-insensitive). */
        ticket_mentions: z.partialRecord(z.enum(TICKET_FIELDS), z.array(z.string())).optional(),
        max_tenant_messages: z.number().int().min(1).optional(),
        /** Safety questions asked ("is anyone…", the gate's check) at most this many times. */
        max_safety_questions: z.number().int().min(0).optional(),
        /** Every reply is in this language. */
        reply_lang: z.enum(["en", "zh", "fr"]).optional(),
      })
      .strict(),
    judge: z.array(z.string().min(10)).min(1),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const CASES_DIR = join(__dirname);

export interface LoadResult {
  cases: EvalCase[];
  errors: string[];
}

/** Every case file, parsed and checked (unique ids, known card keys). */
export function loadEvalCases(dir = CASES_DIR): LoadResult {
  const cases: EvalCase[] = [];
  const errors: string[] = [];
  const cardKeys = new Set(loadCards().map((c) => c.key));
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    readFileSync(join(dir, file), "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!line.trim()) return;
        const where = `${file}:${i + 1}`;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (e) {
          errors.push(`${where}: not JSON (${e instanceof Error ? e.message : e})`);
          return;
        }
        const parsed = EvalCaseSchema.safeParse(raw);
        if (!parsed.success) {
          errors.push(`${where}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
          return;
        }
        const c = parsed.data;
        if (seen.has(c.id)) errors.push(`${where}: duplicate id ${c.id}`);
        seen.add(c.id);
        if (`${c.area}.jsonl` !== file) errors.push(`${where}: area ${c.area} belongs in ${c.area}.jsonl`);
        for (const k of c.expect.card_in ?? []) if (k !== "none" && !cardKeys.has(k)) errors.push(`${where}: unknown card ${k}`);
        if (c.truth.dangerous && c.expect.emergency === undefined && c.expect.escalate === undefined) errors.push(`${where}: a dangerous case needs expect.emergency or expect.escalate`);
        cases.push(c);
      });
  }
  return { cases, errors };
}

/** The hidden card the simulated tenant answers from. */
export function tenantBrief(c: EvalCase): string {
  const t = c.tenant;
  return [
    `First message you sent: "${c.first}"`,
    `What is going on (as you see it): ${t.situation}`,
    "What you know if asked:",
    ...Object.entries(t.knows).map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`),
    ...(t.doesnt_know.length ? [`You don't know: ${t.doesnt_know.join("; ")}. Say you're not sure if asked.`] : []),
    t.has_photo
      ? "You have a photo. When the assistant asks for one, you send it."
      : "You have no photo and won't take one now: if asked, say you'll skip photos.",
    c.truth.dangerous ? "It is dangerous right now: say so if asked about safety." : "Nothing is dangerous: no sparks, no burning smell, no gas, no water near anything electrical, unless written above.",
    ...(t.style ? [`How you write: ${t.style}`] : []),
  ].join("\n");
}

if (process.argv[1]?.replace(/\.ts$/, "").endsWith("schema")) {
  const { cases, errors } = loadEvalCases();
  for (const e of errors) console.log(`✗ ${e}`);
  const by = (f: (c: EvalCase) => string) => cases.reduce<Record<string, number>>((m, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {});
  console.log(`${cases.length} cases, ${errors.length} errors`);
  console.log("by area:", by((c) => c.area));
  console.log("by split:", by((c) => c.split), " by lang:", by((c) => c.lang), " by source:", by((c) => c.source));
  process.exit(errors.length ? 1 : 0);
}
