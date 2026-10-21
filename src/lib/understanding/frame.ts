/**
 * IssueFrame: what the tenant has told us, in controlled values.
 * Produced by the model (strict zod schema) and by the rules fast path,
 * merged so the model can add understanding but never lower urgency.
 */
import { z } from "zod";
import {
  EQUIPMENT, SYMPTOMS, SUBSTANCES, ROOMS, ONSETS, STATUSES, SEVERITIES,
  type Equipment, type Symptom, type Substance, type Room, type Onset, type Status, type Severity,
} from "./taxonomy";

export const FRAME_FIELDS = ["equipment", "symptom", "substance", "room", "onset", "status"] as const;
export type FrameField = (typeof FRAME_FIELDS)[number];

const confidence = z.number().min(0).max(1);

export const IssueFrameSchema = z.object({
  equipment: z.enum(EQUIPMENT),
  symptom: z.enum(SYMPTOMS),
  substance: z.enum(SUBSTANCES),
  room: z.enum(ROOMS),
  onset: z.enum(ONSETS),
  status: z.enum(STATUSES),
  severity: z.enum(SEVERITIES),
  /** Short facts in the tenant's words, translated to English ("plunger helped a bit"). */
  facts: z.array(z.string().max(160)).max(8),
  confidence: z.object({
    equipment: confidence,
    symptom: confidence,
    substance: confidence,
    room: confidence,
    onset: confidence,
    status: confidence,
  }),
  /** Fields the tenant hasn't told us yet. */
  unknowns: z.array(z.enum(FRAME_FIELDS)),
});

export type IssueFrame = z.infer<typeof IssueFrameSchema>;

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, emergency: 3 };

export function emptyFrame(): IssueFrame {
  return {
    equipment: "unknown",
    symptom: "unknown",
    substance: "unknown",
    room: "unknown",
    onset: "unknown",
    status: "unknown",
    severity: "medium",
    facts: [],
    confidence: { equipment: 0, symptom: 0, substance: 0, room: 0, onset: 0, status: 0 },
    unknowns: [...FRAME_FIELDS],
  };
}

function isKnown(field: FrameField, value: string): boolean {
  return value !== "unknown";
}

export function withUnknowns(frame: IssueFrame): IssueFrame {
  return { ...frame, unknowns: FRAME_FIELDS.filter((f) => !isKnown(f, frame[f])) };
}

/** Model values win where the model is confident; rules fill the rest. Urgency only goes up. */
export function mergeFrames(rules: IssueFrame, model: IssueFrame | null, minModelConfidence = 0.6): IssueFrame {
  if (!model) return withUnknowns(rules);
  const out: IssueFrame = { ...rules, confidence: { ...rules.confidence }, facts: [...rules.facts] };
  for (const f of FRAME_FIELDS) {
    const m = model[f];
    const mc = model.confidence[f];
    const useModel = m !== "unknown" && (mc >= minModelConfidence || rules[f] === "unknown") && mc >= rules.confidence[f] - 0.15;
    if (useModel) {
      (out as Record<FrameField, string>)[f] = m;
      out.confidence[f] = mc;
    }
  }
  out.severity = SEVERITY_RANK[model.severity] > SEVERITY_RANK[rules.severity] ? model.severity : rules.severity;
  out.facts = [...new Set([...rules.facts, ...model.facts])].slice(0, 8);
  return withUnknowns(out);
}

/**
 * Add what a later reply says. Filled slots are kept unless the reply is
 * more confident (a correction); urgency only goes up.
 */
export function updateFrame(current: IssueFrame, reply: IssueFrame): IssueFrame {
  const out: IssueFrame = { ...current, confidence: { ...current.confidence }, facts: [...current.facts] };
  for (const f of FRAME_FIELDS) {
    if (reply[f] === "unknown") continue;
    if (current[f] === "unknown" || reply.confidence[f] > current.confidence[f] + 0.2) {
      (out as Record<FrameField, string>)[f] = reply[f];
      out.confidence[f] = reply.confidence[f];
    }
  }
  if (SEVERITY_RANK[reply.severity] > SEVERITY_RANK[current.severity]) out.severity = reply.severity;
  out.facts = [...new Set([...current.facts, ...reply.facts])].slice(0, 8);
  return withUnknowns(out);
}

export type { Equipment, Symptom, Substance, Room, Onset, Status, Severity };
