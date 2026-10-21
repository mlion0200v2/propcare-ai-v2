/**
 * The "Diagnosis" block for the manager's ticket and the vendor's work
 * order: likely causes and how sure we are, the evidence from the
 * tenant's answers and photos, the model/serial if captured, the parts a
 * tech should bring, the trade and an estimated visit length. Pure.
 *
 * Never shown to the tenant: they only see the plain questions.
 */
import type { GatheredInfo } from "@/lib/triage/types";
import { sopByKey } from "./catalog";

export interface DiagnosisView {
  procedure: string;
  confidence: "high" | "medium" | "low";
  /** Most likely first (at most 2). */
  causes: { label: string; evidence: string[] }[];
  /** Answers given and photo count. */
  evidence: string[];
  modelSerial: string | null;
  /** Parts for the leading cause(s), deduplicated. */
  parts: string[];
  trade: string;
  /** "45–90 min", or null when the SOP gives none. */
  visit: string | null;
  /** What to photograph or read so parts can be matched. */
  identify: string[];
  /** Report for the manager only (no troubleshooting). */
  managerOnly: boolean;
}

const CONFIDENCE_TEXT = { high: "High", medium: "Medium", low: "Low (few answers)" } as const;

export function buildDiagnosisView(gathered: GatheredInfo | null | undefined, mediaCount = 0): DiagnosisView | null {
  const state = gathered?.sop;
  const sop = state ? sopByKey(state.issue_key) : null;
  if (!state || !sop) return null;
  const diag = state.diagnosis;
  // A clear winner: bring its parts. Otherwise the top two.
  const leading = diag ? (diag.confidence === "high" ? diag.ranked.slice(0, 1) : diag.ranked.slice(0, 2)) : [];
  const answers = sop.intake_questions
    .filter((q) => state.answers[q.slot] && state.answers[q.slot].value !== "not_sure" && q.slot !== "room")
    .map((q) => `${q.question.replace(/\s*\(.*\)\s*$/, "").replace(/\?$/, "")}: ${state.answers[q.slot].label}`);
  const brand = state.answers.brand_model?.label ?? gathered?.brand_model ?? null;
  const minutes = leading.map((c) => c.visit_minutes).filter(([, hi]) => hi > 0);
  return {
    procedure: sop.title,
    confidence: diag?.confidence ?? "low",
    causes: leading.map((c) => ({ label: c.label, evidence: c.evidence })),
    evidence: [...answers, ...(mediaCount > 0 ? [`${mediaCount} photo${mediaCount === 1 ? "" : "s"}/video${mediaCount === 1 ? "" : "s"} from the tenant`] : [])],
    modelSerial: brand && !/^(unknown|not asked)$/i.test(brand) ? brand : null,
    parts: [...new Set(leading.flatMap((c) => c.candidate_parts))],
    trade: leading[0]?.trade ?? "",
    visit: minutes.length ? `${Math.min(...minutes.map((m) => m[0]))}–${Math.max(...minutes.map((m) => m[1]))} min` : null,
    identify: sop.identify,
    managerOnly: sop.route_to_manager,
  };
}

/** Plain-text block for the summary and the default work-order scope. */
export function diagnosisText(v: DiagnosisView): string {
  if (v.managerOnly) return `DIAGNOSIS\nFor the manager (${v.procedure}); no trade visit suggested.`;
  const lines = ["DIAGNOSIS", `Procedure: ${v.procedure}`, `Confidence: ${CONFIDENCE_TEXT[v.confidence]}`];
  if (v.causes.length) lines.push(`Likely cause: ${v.causes.map((c) => c.label).join("; or ")}`);
  if (v.evidence.length) lines.push(`Evidence: ${v.evidence.join("; ")}`);
  if (v.modelSerial) lines.push(`Model/serial: ${v.modelSerial}`);
  if (v.trade) lines.push(`Trade: ${v.trade}${v.visit ? ` (about ${v.visit})` : ""}`);
  if (v.parts.length) lines.push(`Bring: ${v.parts.join(", ")}`);
  if (v.identify.length) lines.push(`Ask for / check: ${v.identify.join("; ")}`);
  return lines.join("\n");
}

/** Pre-filled "what it covers" for the vendor's quote. */
export function quoteNoteFromDiagnosis(v: DiagnosisView | null): string {
  if (!v || v.managerOnly || v.parts.length === 0) return "";
  return `Diagnose and repair: ${v.causes[0]?.label ?? v.procedure}. Parts if needed: ${v.parts.join(", ")}`.slice(0, 2000);
}
