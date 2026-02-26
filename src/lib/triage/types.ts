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
}
