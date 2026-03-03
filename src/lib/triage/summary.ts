/**
 * Phase 2B — Manager-facing ticket summary.
 *
 * Template-based (no LLM call) — deterministic output.
 * Stored in tickets.classification.summary as a string.
 */

import type { GatheredInfo, TenantInfo, TroubleshootingStep } from "./types";

export interface SummaryInput {
  ticketId: string;
  traceId: string;
  description: string;
  gathered: GatheredInfo;
  tenantInfo?: TenantInfo | null;
  steps: TroubleshootingStep[];
  mediaCount: number;
  timestamp: string;
}

/**
 * Generate a deterministic manager summary from ticket data.
 */
export function generateTicketSummary(input: SummaryInput): string {
  const {
    ticketId,
    traceId,
    description,
    gathered,
    tenantInfo,
    steps,
    mediaCount,
    timestamp,
  } = input;

  const category = gathered.category ?? "general";
  const categoryDisplay = category.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  const address = tenantInfo?.reported_address ?? "N/A";
  const unit = tenantInfo?.reported_unit_number ?? "N/A";
  const isEmergency = gathered.is_emergency ?? false;
  const priority = isEmergency ? "emergency" : "medium";

  const stepsDisplay = steps.length > 0
    ? steps.map((s) => `${s.step}. ${s.description}`).join("\n")
    : "None provided";

  const mediaDisplay = mediaCount > 0
    ? `${mediaCount} file(s) uploaded`
    : "None uploaded yet";

  return [
    `MAINTENANCE REQUEST — ${categoryDisplay} — ${address} ${unit}`,
    "",
    `Issue: ${description}`,
    `Category: ${categoryDisplay}`,
    `Location: ${gathered.location_in_unit ?? "N/A"}, ${address} ${unit}`,
    `Reported: ${gathered.started_when ?? "N/A"}`,
    `Current Status: ${gathered.current_status ?? "N/A"}`,
    `Equipment: ${gathered.brand_model ?? "N/A"}`,
    `Emergency: ${isEmergency ? "Yes" : "No"}`,
    `Priority: ${priority}`,
    "",
    "Troubleshooting Steps Provided to Tenant:",
    stepsDisplay,
    "",
    `Media: ${mediaDisplay}`,
    "",
    `Submitted: ${timestamp}`,
    `Ticket: ${ticketId}`,
    `Trace: ${traceId}`,
  ].join("\n");
}
