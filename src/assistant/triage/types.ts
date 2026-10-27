import type { IssueFrame } from "@/assistant/understanding/frame";
import type { IntakeState } from "@/assistant/sops/intake";

/**
 * The assistant's conversation types. The whole conversation state
 * (TriageClassification, extended in ../api.ts) is returned to the caller,
 * which stores it (tickets.classification) and sends it back next turn.
 */

/** Where a conversation is. Also the ticket's triage_state column. */
export type TriageStateName = "GATHER_INFO" | "AWAITING_MEDIA" | "GUIDED_TROUBLESHOOTING" | "CONFIRM_SUMMARY" | "EMERGENCY" | "DONE";

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
  /** Unit-profile rooms the tenant may mean ("bathroom" → hallway bathroom, ensuite). */
  location_candidates?: string[] | null;
  /** The SOP driving the questions, its answers and the diagnosis (../sops/intake.ts). */
  sop?: IntakeState | null;
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
  issue_classification?: IssueClassification;
  safety_detection?: SafetyDetection;
  media_refs?: string[];
  retrieval?: RetrievalLog;
  validation?: ValidationResult;
  guided_troubleshooting?: GuidedTroubleshootingState;
  /** Manager-facing summary, stored by the app when the report is submitted. */
  summary?: string;
  /** Set when the ticket was escalated as an emergency (state EMERGENCY). */
  emergency?: EmergencyRecord;
  /** What we understood (../understanding): equipment, symptom, substance… */
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
  /** How many of the follow-up questions for the manager the tenant has answered. */
  answered?: number;
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
