import type { IssueFrame } from "@/lib/understanding/frame";
import type { IntakeState } from "@/lib/sops/intake";

/**
 * Phase 2A Triage Types
 *
 * Defines the state machine contract. The triage state is stored
 * in tickets.triage_state and gathered info in tickets.classification JSONB.
 */

export type TriageStateName = "CONFIRM_PROFILE" | "COLLECT_TENANT_INFO" | "GATHER_INFO" | "AWAITING_MEDIA" | "GUIDED_TROUBLESHOOTING" | "CONFIRM_SUMMARY" | "EMERGENCY" | "DONE";

export interface GatheredInfo {
  category: string | null;
  location_in_unit: string | null;
  started_when: string | null;
  is_emergency: boolean | null;
  current_status: string | null;
  brand_model: string | null;
  subcategory: string | null;
  entry_point: string | null;
  equipment: string | null;
  equipment_candidates?: string[] | null;
  /** Water leak: ask the source deep-dive (set from the first message). */
  leak_details_needed?: boolean;
  /** Where the water is: ceiling / wall / floor / under the sink / around an appliance. */
  leak_where?: string | null;
  /** How much: a few drops / small puddle / spreading. */
  leak_amount?: string | null;
  /** When: all the time / when the shower or toilet or an appliance is used. */
  leak_timing?: string | null;
  /** Water near an outlet, light or anything plugged in: "yes" | "no" | "not sure". */
  leak_electrical?: string | null;
  /** Unit-profile rooms the tenant may mean ("bathroom" → hallway bathroom, ensuite). */
  location_candidates?: string[] | null;
  /** Older tickets (before SOP intake): which fixture was leaking. */
  leak_fixture?: string | null;
  /** Older tickets (before SOP intake): "Where on the fixture?" answer. */
  leak_part?: string | null;
  /** Likely cause from the intake answers: shown on the summary and work order, steers retrieval. */
  leak_likely_source?: { id: string; label: string; sop_query?: string; prevention?: string } | null;
  /** The SOP driving the questions, its answers and the likely cause (src/lib/sops/intake.ts). */
  sop?: IntakeState | null;
}

export interface TriageContext {
  triage_state: TriageStateName;
  description: string;
  gathered: GatheredInfo;
  current_question: string | null;
}

export interface StepResult {
  next_state: TriageStateName;
  reply: string;
  gathered: GatheredInfo;
  current_question: string | null;
  troubleshooting_steps?: TroubleshootingStep[];
}

export interface TroubleshootingStep {
  step: number;
  description: string;
  completed: boolean;
}

/** Result of tenant feedback on a single troubleshooting step */
export type TroubleshootingStepResult =
  | "helped"
  | "partial"
  | "did_not_help"
  | "asking_how"
  | "unable_to_access"
  | "did_not_try"
  | "completed"
  | "unsafe"
  | "unclear";

/** LLM-interpreted result (richer vocabulary than TroubleshootingStepResult) */
export type InterpretedResult =
  | "completed"
  | "helped"
  | "partially_helped"
  | "did_not_help"
  | "asking_how"
  | "unable_to_access"
  | "cannot_assess"
  | "did_not_try"
  | "skip"
  | "unknown";

/** Structured LLM interpretation of a tenant's step feedback */
export interface InterpretedStepResponse {
  result: InterpretedResult;
  confidence: "high" | "medium" | "low";
  extracted_note?: string;
  mentioned_safety_issue?: boolean;
  mentioned_emergency_issue?: boolean;
  should_clarify?: boolean;
  clarification_question?: string;
}

/** Semantic type of a guided troubleshooting step */
export type GuidedStepKind = "action" | "observation" | "terminal" | "media_request";

/** A single guided troubleshooting step with enriched metadata */
export interface GuidedStep {
  index: number;
  description: string;
  citation: string | null;
  step_kind: GuidedStepKind;
  depends_on: number | null;
  stop_if_unsure: boolean;
  escalation_if_failed: boolean;
  request_media_after: boolean;
}

/** Log entry for one step's interaction */
export interface TroubleshootingLogEntry {
  step_index: number;
  presented_at: string;
  responded_at: string | null;
  raw_response: string | null;
  result: TroubleshootingStepResult | null;
  note?: string;
  interpretation_source?: "regex" | "llm";
}

/** Next action after processing feedback */
export type GuidedNextAction =
  | { type: "next_step" }
  | { type: "resolved" }
  | { type: "escalate"; reason: string }
  | { type: "all_steps_done" }
  | { type: "clarify" }
  | { type: "provide_help" };

/** Persisted state for guided troubleshooting (stored in classification JSONB) */
export interface GuidedTroubleshootingState {
  steps: GuidedStep[];
  current_step_index: number;
  log: TroubleshootingLogEntry[];
  outcome: "in_progress" | "resolved" | "escalated" | "all_steps_done";
}

export interface TenantInfo {
  reported_address: string | null;
  reported_unit_number: string | null;
  contact_phone: string | null;
  contact_email: string | null;
}

export interface IssueClassification {
  category: string;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

export interface SafetyDetection {
  detected: boolean;
  method: "auto" | "user_confirmed" | "user_denied" | "user_unclear" | "skipped";
  rationale: string;
}

/** Shape stored in tickets.classification JSONB during triage */
export interface TriageClassification {
  gathered: GatheredInfo;
  current_question: string | null;
  tenant_info?: TenantInfo;
  issue_classification?: IssueClassification;
  safety_detection?: SafetyDetection;
  media_refs?: string[];
  retrieval?: RetrievalLog;
  validation?: ValidationResult;
  guided_troubleshooting?: GuidedTroubleshootingState;
  summary?: string;
  /** Set when the ticket was escalated as an emergency (state EMERGENCY). */
  emergency?: EmergencyRecord;
  /** What we understood (src/lib/understanding): equipment, symptom, substance… */
  issue_frame?: IssueFrame;
}

/** What triggered an emergency escalation and whether the manager was alerted. */
export interface EmergencyRecord {
  kind: string;
  phrase: string;
  detected_at: string;
  /** Triage state the conversation was in when the emergency was detected. */
  previous_state: string;
  manager_notified: boolean;
}

export interface ValidationResult {
  is_valid: boolean;
  low_confidence: boolean;
  missing_citations: boolean;
  missing_safety_guidance: boolean;
  domain_mismatch: boolean;
  reasons: string[];
  highest_score: number;
  average_score: number;
  action_taken: "none" | "fallback_sop" | "prepend_safety" | "fallback_sop_with_disclaimer" | "web_search_fallback";
}

export interface RetrievalLog {
  query_text: string;
  embedding_model: string;
  pinecone_index: string;
  pinecone_namespace: string;
  filters: Record<string, string>;
  top_k: number;
  min_score: number;
  matches: Array<{ id: string; score: number; metadata: Record<string, unknown> }>;
  highest_score: number;
  average_score: number;
  low_confidence: boolean;
  timestamp: string;
  trace_id: string;
}
