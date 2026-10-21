/**
 * SOP schema v2: an SOP declares what it applies to (taxonomy values),
 * the intake questions it needs, how answers map to a likely cause, and
 * what the tenant can safely do. Source of truth: catalog.json (also
 * uploaded to Pinecone by scripts/ingest_sops.ts).
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
});

export const IntakeQuestionSchema = z.object({
  id: z.string(),
  /** Frame slot (equipment, substance, room, onset, status…) or an SOP-specific one (part, timing…). */
  slot: z.string(),
  question: z.string(),
  options: z.array(IntakeOptionSchema),
  /** Ask only when these slots have these values. */
  only_if: SlotCondition.optional(),
});

export const CauseSchema = z.object({
  id: z.string(),
  label: z.string(),
  sop_query: z.string(),
  prevention: z.string(),
  /** A more specific SOP for this cause (used for guidance and retrieval). */
  refine_to: z.string().optional(),
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
  /** First rule whose conditions all hold wins; an empty `when` always holds. */
  likely_causes: z.array(z.object({ when: SlotCondition, cause: CauseSchema })),
  /** Tie-break between SOPs that match equally well. */
  priority: z.number(),
  keywords: z.array(z.string()),
  /** Words that tell this SOP from its siblings ("relief valve" vs a tank leak). */
  strong_keywords: z.array(z.string()),
  prevention: z.array(z.string()),
  tenant_steps: z.array(z.string()),
  escalate_if: z.array(z.string()),
  photos: z.array(z.string()),
});

export const CatalogSchema = z.object({ version: z.literal(2), sops: z.array(SopSchema) }).passthrough();

export type Sop = z.infer<typeof SopSchema>;
export type IntakeQuestion = z.infer<typeof IntakeQuestionSchema>;
export type IntakeOption = z.infer<typeof IntakeOptionSchema>;
export type Cause = z.infer<typeof CauseSchema>;
