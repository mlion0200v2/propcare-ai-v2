/**
 * SOP schema v2: an SOP declares what it applies to (taxonomy values),
 * the intake questions it needs (written as the tradesperson would ask,
 * answerable by a tenant without taking anything apart), the causes a
 * tech would consider with the parts and trade for each, how each answer
 * rules causes in or out, what to photograph or read to match parts, and
 * what the tenant can safely do. Source of truth: catalog.json (also
 * uploaded to Pinecone by scripts/ingest_sops.ts).
 *
 * Tenants only ever see the questions, options and safe steps; causes,
 * parts, trades and times are for the manager and the vendor.
 */
import { z } from "zod";
import { EQUIPMENT, SYMPTOMS, SUBSTANCES } from "@/lib/understanding/taxonomy";

export const SlotCondition = z.record(z.string(), z.array(z.string()));

export const IntakeOptionSchema = z.object({
  label: z.string(),
  /** Slot value stored when chosen. Frame slots use taxonomy values. */
  value: z.string(),
  /** Free-text answers (and first messages) that mean this option (JS regex, case-insensitive). */
  match: z.string().optional(),
  /** Show the option only when these slots have these values. */
  only_if: SlotCondition.optional(),
  /** Choosing it escalates now (e.g. water near electrics). */
  emergency: z.string().optional(),
  /** Causes this answer points to, or makes unlikely (cause ids). */
  rules_in: z.array(z.string()).optional(),
  rules_out: z.array(z.string()).optional(),
});

export const IntakeQuestionSchema = z.object({
  id: z.string(),
  /** Frame slot (equipment, substance, room, onset, status…) or an SOP-specific one (part, timing…). */
  slot: z.string(),
  question: z.string(),
  options: z.array(IntakeOptionSchema),
  /** Ask only when these slots have these values. */
  only_if: SlotCondition.optional(),
  /**
   * Fill from the first message ("leaks under the sink when I drain it")? Only for descriptive
   * questions; a ceiling leak "in the bathroom" says nothing about what's above.
   */
  prefill: z.boolean(),
});

export const CauseSchema = z.object({
  id: z.string(),
  label: z.string(),
  sop_query: z.string(),
  /** First damage-limiting step for the tenant when this is the likely cause ("" when none). */
  prevention: z.string(),
  /** A more specific SOP for this cause (used for guidance and retrieval). */
  refine_to: z.string().optional(),
  /** What a tech would bring (manager/vendor only). */
  candidate_parts: z.array(z.string()),
  trade: z.string(),
  /** Estimated visit length, minutes [low, high]. */
  visit_minutes: z.tuple([z.number(), z.number()]),
  /** How common it is before any answers (0–3). */
  prior: z.number(),
});

export const SopSchema = z.object({
  id: z.string(),
  issue_key: z.string(),
  title: z.string(),
  category: z.string(),
  severity: z.enum(["low", "medium", "high", "emergency"]),
  tenant_safe: z.literal(true),
  version: z.string(),
  /** Reference SOPs (shut-off basics…) are retrieved but never selected for intake. */
  selectable: z.boolean(),
  applies_to: z.object({
    equipment: z.array(z.enum(EQUIPMENT)),
    symptoms: z.array(z.enum(SYMPTOMS)),
    substances: z.array(z.enum(SUBSTANCES)),
  }),
  intake_questions: z.array(IntakeQuestionSchema),
  /** Causes a tech would consider; answers' rules_in/rules_out rank them. */
  causes: z.array(CauseSchema),
  /** The questions that tell causes apart (they carry rules_in/rules_out). */
  diagnostic_questions: z.array(z.string()),
  /** What to photograph or read so the tech can match parts (labels, sizes, types). */
  identify: z.array(z.string()),
  /** No troubleshooting: pass it to the manager (neighbour noise). */
  route_to_manager: z.boolean(),
  /** Tie-break between SOPs that match equally well. */
  priority: z.number(),
  keywords: z.array(z.string()),
  /** Words that tell this SOP from its siblings ("relief valve" vs a tank leak). */
  strong_keywords: z.array(z.string()),
  prevention: z.array(z.string()),
  tenant_steps: z.array(z.string()),
  escalate_if: z.array(z.string()),
  photos: z.array(z.string()),
  /** Ask the generic "sparks, burning smell, warmth?" check after intake (not for alarms, or when electrics were asked). */
  ask_safety_check: z.boolean(),
});

export const CatalogSchema = z.object({ version: z.literal(2), sops: z.array(SopSchema) }).passthrough();

export type Sop = z.infer<typeof SopSchema>;
export type IntakeQuestion = z.infer<typeof IntakeQuestionSchema>;
export type IntakeOption = z.infer<typeof IntakeOptionSchema>;
export type Cause = z.infer<typeof CauseSchema>;
