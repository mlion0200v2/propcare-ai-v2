/**
 * Phase 2A — Deterministic Triage State Machine
 *
 * Pure function: (context, userMessage) → StepResult
 * No LLM calls. Drives a "missing info checklist" one question per turn.
 *
 * Required fields (in order):
 *   1. location_in_unit — free text
 *   2. started_when   — free text
 *
 * Category is auto-classified before step() is called.
 * Safety (is_emergency) is detected after all fields are gathered.
 *
 * Once all fields gathered → transitions to DONE with fallback SOP.
 */

import type {
  TriageContext,
  StepResult,
  GatheredInfo,
  TenantInfo,
  TriageStateName,
} from "./types";
import { getFallbackSOP } from "./sop-fallback";
import {
  tenantInfoPhoneSchema,
  tenantInfoEmailSchema,
} from "../utils/validation";

// ── Category options (matches DB enum) ──

const CATEGORY_OPTIONS = [
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "structural",
  "pest_control",
  "locksmith",
  "roofing",
  "painting",
  "flooring",
  "landscaping",
  "general",
  "other",
] as const;

// ── Conversational question templates ──

export const QUESTIONS: Record<string, string> = {
  location_in_unit:
    "Where in your unit is the issue? (e.g., kitchen, bathroom, bedroom)",
  started_when:
    "When did this start? (e.g., today, yesterday, a few days ago)",
};

const FIELD_ORDER = [
  "location_in_unit",
  "started_when",
] as const;

// ── Emergency keywords (auto-detect in any message) ──

const EMERGENCY_KEYWORDS = [
  "gas leak",
  "gas smell",
  "smell gas",
  "fire",
  "smoke",
  "carbon monoxide",
  "exposed wire",
  "sparking",
  "sewage",
  "collapse",
  "ceiling fell",
  // NOTE: "mold", "flooding", "flooded", "no heat", "no hot water" removed —
  // these are category+severity dependent, not automatic emergencies.
];

// ── Tenant info collection (no-unit flow) ──

const TENANT_INFO_FIELD_ORDER = [
  "reported_address",
  "reported_unit_number",
  "contact_phone",
  "contact_email",
] as const;

export const TENANT_INFO_QUESTIONS: Record<string, string> = {
  reported_address:
    "What is your property address? (e.g., 123 Main St, Anytown, CA 90210)",
  reported_unit_number:
    "What is your unit or apartment number? If not applicable, reply \"none\". (e.g., Apt 4B, Unit 7)",
  contact_phone:
    "What is a good phone number to reach you? (e.g., 555-123-4567)",
  contact_email:
    "What is your email address?",
};

// ── Public API ──

/**
 * Advance the triage state machine by one turn.
 * Pure function — no side effects, no DB or LLM calls.
 *
 * Category should be pre-set in gathered before calling step().
 * Safety detection is handled separately after all fields are gathered.
 */
export function step(context: TriageContext, userMessage: string): StepResult {
  const { current_question } = context;
  const updated: GatheredInfo = { ...context.gathered };

  // 1. Process the user's answer to the current question
  if (current_question) {
    processAnswer(current_question, userMessage, updated);
  }

  // 2. Auto-detect emergency keywords in every message
  if (hasEmergencyKeywords(userMessage)) {
    updated.is_emergency = true;
  }

  // 3. Find next missing field
  const nextField = getNextMissingField(updated);

  if (nextField) {
    return {
      next_state: "GATHER_INFO",
      reply: QUESTIONS[nextField],
      gathered: updated,
      current_question: nextField,
    };
  }

  // 4. All base fields gathered → DONE
  const category = updated.category ?? "general";
  const isEmergency = updated.is_emergency ?? false;
  const sop = getFallbackSOP(category, isEmergency, updated.subcategory);

  return {
    next_state: "DONE",
    reply: formatCompletionReply(isEmergency, sop.display),
    gathered: updated,
    current_question: null,
    troubleshooting_steps: sop.steps,
  };
}

/**
 * Build the bot's first reply after the tenant's initial description.
 * Uses acknowledgement + the next question to ask.
 */
export function buildInitialReply(
  acknowledgement: string,
  nextQuestionText: string
): string {
  return [acknowledgement, "", nextQuestionText].join("\n");
}

/**
 * Build the initial reply with a clarifying category question.
 * Used when classification confidence is low.
 */
export function buildInitialReplyWithClarification(
  acknowledgement: string,
  clarifyingQuestion: string
): string {
  return [
    acknowledgement,
    "",
    clarifyingQuestion,
  ].join("\n");
}

/**
 * Create an empty gathered-info object.
 */
export function buildInitialGathered(): GatheredInfo {
  return {
    category: null,
    location_in_unit: null,
    started_when: null,
    is_emergency: null,
    current_status: null,
    brand_model: null,
    subcategory: null,
    entry_point: null,
    equipment: null,
  };
}

// ── Tenant info validation ──

const INVALID_UNIT_PATTERN = /^(non|n|x|test|null|undefined)\s*$/i;
const VALID_NO_UNIT_MARKERS = ["none", "n/a", "not applicable", "na"];

/**
 * Validate tenant info fields. Returns list of invalid field names.
 *
 * Rules:
 * - Unit number: reject clearly invalid values; accept "none"/"n/a" as valid no-unit markers
 * - Address: reject if length < 5
 */
export function validateTenantInfo(tenantInfo: TenantInfo): string[] {
  const invalid: string[] = [];

  const unit = tenantInfo.reported_unit_number;
  if (unit !== null) {
    const trimmed = unit.trim();
    const isNoUnit = VALID_NO_UNIT_MARKERS.includes(trimmed.toLowerCase());
    if (!isNoUnit && (trimmed.length < 1 || INVALID_UNIT_PATTERN.test(trimmed))) {
      invalid.push("reported_unit_number");
    }
  }

  const address = tenantInfo.reported_address;
  if (address !== null && address.trim().length < 5) {
    invalid.push("reported_address");
  }

  return invalid;
}

// ── Tenant info (no-unit) flow ──

/**
 * Create an empty tenant-info object.
 */
export function buildInitialTenantInfo(): TenantInfo {
  return {
    reported_address: null,
    reported_unit_number: null,
    contact_phone: null,
    contact_email: null,
  };
}

/**
 * Build the first bot reply when the tenant has no assigned unit.
 */
export function buildTenantInfoInitialReply(): string {
  return [
    "Thanks for reporting this issue. It looks like we don't have your address on file yet.",
    "",
    "I'll need to collect a few details before we get started.",
    "",
    TENANT_INFO_QUESTIONS.reported_address,
  ].join("\n");
}

/**
 * Build the confirmation reply when a returning tenant has profile info on file.
 */
export function buildConfirmProfileReply(tenantInfo: TenantInfo): string {
  const invalidFields = validateTenantInfo(tenantInfo);
  const displayUnit = invalidFields.includes("reported_unit_number")
    ? "Not on file"
    : tenantInfo.reported_unit_number;
  const displayAddress = invalidFields.includes("reported_address")
    ? "Not on file"
    : tenantInfo.reported_address;

  return [
    "I have your info on file:",
    `  Address: ${displayAddress}`,
    `  Unit: ${displayUnit}`,
    `  Phone: ${tenantInfo.contact_phone}`,
    `  Email: ${tenantInfo.contact_email}`,
    "",
    "Is this still correct?",
  ].join("\n");
}

export interface TenantInfoStepResult {
  next_state: TriageStateName;
  reply: string;
  tenant_info: TenantInfo;
  current_question: string | null;
  /** When all tenant info is collected, also return initial gathered info */
  gathered?: GatheredInfo;
}

/**
 * Advance the tenant-info collection by one turn.
 * Once all fields are collected, transitions to GATHER_INFO.
 *
 * When transitioning to GATHER_INFO, the reply now asks the first
 * conversational question (location) instead of a category menu.
 * Category should be set by the caller using classify-issue.
 */
export function stepTenantInfo(
  tenantInfo: TenantInfo,
  currentQuestion: string | null,
  userMessage: string
): TenantInfoStepResult {
  const updated: TenantInfo = { ...tenantInfo };
  const trimmed = userMessage.trim();

  // 1. Process the answer to the current question
  if (currentQuestion) {
    const error = processTenantInfoAnswer(currentQuestion, trimmed, updated);
    if (error) {
      // Validation failed — re-ask same question with error
      return {
        next_state: "COLLECT_TENANT_INFO",
        reply: `${error}\n\n${TENANT_INFO_QUESTIONS[currentQuestion]}`,
        tenant_info: updated,
        current_question: currentQuestion,
      };
    }
  }

  // 2. Find next missing field
  const nextField = getNextMissingTenantInfo(updated);

  if (nextField) {
    return {
      next_state: "COLLECT_TENANT_INFO",
      reply: TENANT_INFO_QUESTIONS[nextField],
      tenant_info: updated,
      current_question: nextField,
    };
  }

  // 3. All tenant info collected → transition to GATHER_INFO
  //    Ask the first gather question; the caller may override if location was pre-extracted
  const gathered = buildInitialGathered();
  const firstField = getNextMissingField(gathered) ?? "location_in_unit";
  return {
    next_state: "GATHER_INFO",
    reply: [
      "Great, thanks for providing your details!",
      "",
      "Now let's get your issue sorted out.",
      "",
      QUESTIONS[firstField],
    ].join("\n"),
    tenant_info: updated,
    current_question: firstField,
    gathered,
  };
}

/**
 * Process a tenant info answer. Returns an error string if validation fails, null on success.
 */
function processTenantInfoAnswer(
  field: string,
  value: string,
  tenantInfo: TenantInfo
): string | null {
  switch (field) {
    case "reported_address":
      tenantInfo.reported_address = value;
      return null;
    case "reported_unit_number":
      tenantInfo.reported_unit_number = value;
      return null;
    case "contact_phone": {
      const result = tenantInfoPhoneSchema.safeParse(value);
      if (!result.success) {
        return result.error.issues[0].message;
      }
      tenantInfo.contact_phone = value;
      return null;
    }
    case "contact_email": {
      const result = tenantInfoEmailSchema.safeParse(value);
      if (!result.success) {
        return result.error.issues[0].message;
      }
      tenantInfo.contact_email = value;
      return null;
    }
    default:
      return null;
  }
}

export function getNextMissingTenantInfo(info: TenantInfo): string | null {
  for (const field of TENANT_INFO_FIELD_ORDER) {
    if (info[field] === null || info[field] === undefined) {
      return field;
    }
  }
  return null;
}

// ── Internals ──

function processAnswer(
  field: string,
  message: string,
  gathered: GatheredInfo
): void {
  const trimmed = message.trim();

  switch (field) {
    case "category": {
      // Legacy support: still process if category is the current question
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= CATEGORY_OPTIONS.length) {
        gathered.category = CATEGORY_OPTIONS[num - 1];
      } else {
        const lower = trimmed.toLowerCase();
        const match = CATEGORY_OPTIONS.find(
          (c) => c === lower || c.replace("_", " ") === lower
        );
        gathered.category = match ?? "general";
      }
      break;
    }
    case "location_in_unit":
      gathered.location_in_unit = trimmed;
      break;
    case "started_when":
      gathered.started_when = trimmed;
      break;
    case "is_emergency": {
      const lower = trimmed.toLowerCase();
      gathered.is_emergency = ["yes", "y", "true", "1"].includes(lower);
      break;
    }
  }
}

export function getNextMissingField(gathered: GatheredInfo): string | null {
  for (const field of FIELD_ORDER) {
    if (gathered[field] === null || gathered[field] === undefined) {
      return field;
    }
  }
  return null;
}

export function hasEmergencyKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.some((k) => lower.includes(k));
}

function formatCompletionReply(
  isEmergency: boolean,
  troubleshootingDisplay: string
): string {
  if (isEmergency) {
    return [
      "**SAFETY ALERT**: Your issue has been flagged as a potential emergency.",
      "",
      "**IMMEDIATE ACTIONS:**",
      "1. If you smell gas, leave the unit immediately and contact the FortisBC gas emergency line.",
      "2. If there's flooding, turn off the main water valve if it is safe to do so.",
      "3. If there's a fire or smoke, evacuate and call 911.",
      "4. Do NOT re-enter the unit until cleared by emergency services or your property manager.",
      "",
      "Your ticket has been escalated to your property manager for urgent review. The property manager should contact you within 2 hours.",
      "",
      "---",
      "",
      troubleshootingDisplay,
    ].join("\n");
  }

  return [
    "Thank you for providing all the details. Here are some initial troubleshooting steps while your property manager reviews your ticket:",
    "",
    troubleshootingDisplay,
    "",
    "Your ticket has been submitted. Your property manager will follow up.",
  ].join("\n");
}

export { CATEGORY_OPTIONS };
