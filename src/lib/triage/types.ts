/**
 * Phase 2A Triage Types
 *
 * Defines the state machine contract. The triage state is stored
 * in tickets.triage_state and gathered info in tickets.classification JSONB.
 */

export type TriageStateName = "CONFIRM_PROFILE" | "COLLECT_TENANT_INFO" | "GATHER_INFO" | "DONE";

export interface GatheredInfo {
  category: string | null;
  location_in_unit: string | null;
  started_when: string | null;
  is_emergency: boolean | null;
  current_status: string | null;
  brand_model: string | null;
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

export interface TenantInfo {
  reported_address: string | null;
  reported_unit_number: string | null;
  contact_phone: string | null;
  contact_email: string | null;
}

/** Shape stored in tickets.classification JSONB during triage */
export interface TriageClassification {
  gathered: GatheredInfo;
  current_question: string | null;
  tenant_info?: TenantInfo;
  retrieval?: RetrievalLog;
  validation?: ValidationResult;
  summary?: string;
}

export interface ValidationResult {
  is_valid: boolean;
  low_confidence: boolean;
  missing_citations: boolean;
  missing_safety_guidance: boolean;
  reasons: string[];
  highest_score: number;
  average_score: number;
  action_taken: "none" | "fallback_sop" | "prepend_safety" | "fallback_sop_with_disclaimer";
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
