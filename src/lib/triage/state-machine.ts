/**
 * Phase 2A — Deterministic Triage State Machine
 *
 * Pure function: (context, userMessage) → StepResult
 * No LLM calls. Drives a "missing info checklist" one question per turn.
 *
 * Required fields (in order):
 *   1. category       — pick from list
 *   2. location_in_unit — free text
 *   3. started_when   — free text
 *   4. is_emergency   — yes/no (also auto-detected via keyword scan)
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

// ── Question templates ──

const QUESTIONS: Record<string, string> = {
  category: [
    "What type of issue is this? Reply with a number:",
    ...CATEGORY_OPTIONS.map(
      (c, i) =>
        `  ${i + 1}. ${c.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase())}`
    ),
  ].join("\n"),
  location_in_unit:
    "Where in your unit is the issue? (e.g., kitchen, bathroom, bedroom, living room)",
  started_when:
    "When did this start? (e.g., today, yesterday, a few days ago)",
  is_emergency:
    "Are there any safety concerns? (e.g., gas smell, flooding, exposed wires, no heat in winter)\n\nReply **YES** or **NO**.",
};

const FIELD_ORDER = [
  "category",
  "location_in_unit",
  "started_when",
  "is_emergency",
] as const;

// ── Emergency keywords (auto-detect in any message) ──

const EMERGENCY_KEYWORDS = [
  "gas leak",
  "gas smell",
  "smell gas",
  "flooding",
  "flooded",
  "fire",
  "smoke",
  "carbon monoxide",
  "exposed wire",
  "sparking",
  "no heat",
  "no hot water",
  "sewage",
  "collapse",
  "ceiling fell",
  "mold",
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
  const nextField = getNextMissing(updated);

  if (nextField) {
    return {
      next_state: "GATHER_INFO",
      reply: QUESTIONS[nextField],
      gathered: updated,
      current_question: nextField,
    };
  }

  // 4. All fields gathered → DONE
  const category = updated.category ?? "general";
  const isEmergency = updated.is_emergency ?? false;
  const sop = getFallbackSOP(category, isEmergency);

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
 */
export function buildInitialReply(): string {
  return [
    "Thanks for reporting this issue. I'll help you get it resolved.",
    "",
    "Let me gather a few details first.",
    "",
    QUESTIONS.category,
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
  };
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
  return [
    "I have your info on file:",
    `  Address: ${tenantInfo.reported_address}`,
    `  Unit: ${tenantInfo.reported_unit_number}`,
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
  const gathered = buildInitialGathered();
  return {
    next_state: "GATHER_INFO",
    reply: [
      "Great, thanks for providing your details!",
      "",
      "Now let's get your issue sorted out.",
      "",
      QUESTIONS.category,
    ].join("\n"),
    tenant_info: updated,
    current_question: "category",
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

function getNextMissing(gathered: GatheredInfo): string | null {
  for (const field of FIELD_ORDER) {
    if (gathered[field] === null || gathered[field] === undefined) {
      return field;
    }
  }
  return null;
}

function hasEmergencyKeywords(text: string): boolean {
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
      "**If you are in immediate danger, call 911.**",
      "",
      "Your ticket has been escalated to your property manager for urgent review.",
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
