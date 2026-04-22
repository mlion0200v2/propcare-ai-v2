/**
 * Phase 2B — Manager-facing ticket summary.
 *
 * Template-based (no LLM call) — deterministic output.
 * Stored in tickets.classification.summary as a string.
 */

import type {
  GatheredInfo,
  TenantInfo,
  TroubleshootingStep,
  GuidedTroubleshootingState,
  TroubleshootingStepResult,
} from "./types";

export interface SummaryInput {
  ticketId: string;
  traceId: string;
  description: string;
  gathered: GatheredInfo;
  tenantInfo?: TenantInfo | null;
  steps: TroubleshootingStep[];
  mediaCount: number;
  timestamp: string;
  /** Guided troubleshooting state with per-step log (optional — omit for non-guided) */
  guidedState?: GuidedTroubleshootingState | null;
}

// Human-readable result labels for the PM summary
const RESULT_LABELS: Record<TroubleshootingStepResult, string> = {
  helped: "Helped — issue resolved",
  partial: "Partially helped",
  did_not_help: "Did not help",
  asking_how: "Asked for help",
  unable_to_access: "Unable to access / assess",
  did_not_try: "Skipped",
  completed: "Completed",
  unsafe: "Safety concern reported",
  unclear: "Response unclear",
};

/**
 * Generate a deterministic manager summary from ticket data.
 *
 * Includes: issue details, subcategory, entry point, guided troubleshooting
 * log with tenant responses and extracted notes, and PM recommendations.
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
    guidedState,
  } = input;

  const category = gathered.category ?? "general";
  const categoryDisplay = category.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  const address = tenantInfo?.reported_address ?? "N/A";
  const unit = tenantInfo?.reported_unit_number ?? "N/A";
  const isEmergency = gathered.is_emergency ?? false;
  const priority = isEmergency ? "emergency" : "medium";

  const parts: string[] = [];

  // ── Header ──
  parts.push(`MAINTENANCE REQUEST — ${categoryDisplay} — ${address} ${unit}`);
  parts.push("");

  // ── Issue Details ──
  parts.push(`Issue: ${description}`);
  parts.push(`Category: ${categoryDisplay}`);
  if (gathered.subcategory) {
    parts.push(`Subcategory: ${gathered.subcategory}`);
  }
  parts.push(`Location: ${gathered.location_in_unit ?? "N/A"}, ${address} ${unit}`);
  parts.push(`Reported: ${gathered.started_when ?? "N/A"}`);
  parts.push(`Current Status: ${gathered.current_status ?? "N/A"}`);
  if (gathered.brand_model) {
    parts.push(`Equipment: ${gathered.brand_model}`);
  }
  parts.push(`Emergency: ${isEmergency ? "Yes" : "No"}`);
  parts.push(`Priority: ${priority}`);

  // ── Key Findings ──
  if (gathered.entry_point) {
    parts.push("");
    parts.push("Key Findings:");
    parts.push(`  Entry point: ${gathered.entry_point}`);
  }

  // ── Guided Troubleshooting Log ──
  if (guidedState && guidedState.log.length > 0) {
    parts.push("");
    parts.push("Troubleshooting Steps (Tenant Interaction):");

    for (const entry of guidedState.log) {
      const step = guidedState.steps[entry.step_index];
      if (!step) continue;

      const resultLabel = entry.result
        ? RESULT_LABELS[entry.result] ?? entry.result
        : "No response";

      parts.push(`  ${step.index + 1}. ${step.description}`);
      parts.push(`     Result: ${resultLabel}`);

      if (entry.note) {
        parts.push(`     Tenant note: ${entry.note}`);
      }
      if (entry.raw_response && entry.raw_response.length > 0) {
        // Include raw response for PM context (truncated)
        const displayResponse = entry.raw_response.length > 120
          ? entry.raw_response.slice(0, 120) + "..."
          : entry.raw_response;
        parts.push(`     Tenant said: "${displayResponse}"`);
      }
    }

    // List steps not attempted
    const attemptedIndices = new Set(guidedState.log.map((e) => e.step_index));
    const skippedSteps = guidedState.steps.filter(
      (s) => s.step_kind !== "terminal" && s.step_kind !== "media_request" && !attemptedIndices.has(s.index)
    );
    if (skippedSteps.length > 0) {
      parts.push("");
      parts.push("Steps Not Attempted:");
      for (const s of skippedSteps) {
        parts.push(`  ${s.index + 1}. ${s.description}`);
      }
    }

    // Terminal guidance (management notes)
    const terminalSteps = guidedState.steps.filter((s) => s.step_kind === "terminal");
    if (terminalSteps.length > 0) {
      parts.push("");
      parts.push("Management Notes (Not Shown to Tenant as Interactive Steps):");
      for (const s of terminalSteps) {
        parts.push(`  - ${s.description}`);
      }
    }

    parts.push("");
    parts.push(`Outcome: ${guidedState.outcome}`);
  } else {
    // Non-guided: just list steps
    parts.push("");
    parts.push("Troubleshooting Steps Provided to Tenant:");
    if (steps.length > 0) {
      for (const s of steps) {
        parts.push(`  ${s.step}. ${s.description}`);
      }
    } else {
      parts.push("  None provided");
    }
  }

  // ── Media ──
  parts.push("");
  parts.push(`Media: ${mediaCount > 0 ? `${mediaCount} file(s) uploaded` : "None uploaded yet"}`);

  // ── Recommendations ──
  parts.push("");
  parts.push("Recommended Next Steps:");
  const recommendations = buildRecommendations(gathered, guidedState);
  for (const r of recommendations) {
    parts.push(`  - ${r}`);
  }

  // ── Footer ──
  parts.push("");
  parts.push(`Submitted: ${timestamp}`);
  parts.push(`Ticket: ${ticketId}`);
  parts.push(`Trace: ${traceId}`);

  return parts.join("\n");
}

/**
 * Generate a short, friendly tenant-facing summary for confirmation.
 *
 * Different from `generateTicketSummary()` which is manager-facing.
 * This shows the tenant what was gathered so they can confirm or correct.
 */
export function generateTenantSummary(input: {
  description: string;
  gathered: GatheredInfo;
  mediaCount: number;
  guidedOutcome?: string | null;
}): string {
  const { description, gathered, mediaCount, guidedOutcome } = input;

  const category = gathered.category ?? "general";
  const categoryDisplay = category.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  const isEmergency = gathered.is_emergency ?? false;

  const lines: string[] = [];
  lines.push("**Here's a summary of what you reported:**");
  lines.push("");

  // Issue description — truncate at word boundary for readability
  let truncDesc = description;
  if (description.length > 200) {
    const cut = description.lastIndexOf(" ", 200);
    truncDesc = description.slice(0, cut > 100 ? cut : 200) + "...";
  }
  lines.push(`- **Issue:** ${truncDesc}`);
  lines.push(`- **Category:** ${categoryDisplay}`);

  if (gathered.location_in_unit) {
    lines.push(`- **Location:** ${gathered.location_in_unit}`);
  }
  if (gathered.started_when) {
    lines.push(`- **When it started:** ${gathered.started_when}`);
  }
  if (gathered.current_status) {
    lines.push(`- **Status:** ${gathered.current_status}`);
  }
  if (gathered.equipment) {
    lines.push(`- **Equipment:** ${gathered.equipment}`);
  }
  if (gathered.brand_model) {
    lines.push(`- **Brand/Model:** ${gathered.brand_model}`);
  }
  lines.push(`- **Emergency:** ${isEmergency ? "Yes" : "No"}`);

  if (mediaCount > 0) {
    lines.push(`- **Photos/Videos:** ${mediaCount} uploaded`);
  }

  if (guidedOutcome) {
    const outcomeDisplay = guidedOutcome === "resolved"
      ? "Resolved during troubleshooting"
      : guidedOutcome === "escalated"
      ? "Escalated to property manager"
      : "Troubleshooting steps completed";
    lines.push(`- **Troubleshooting:** ${outcomeDisplay}`);
  }

  lines.push("");
  lines.push("Does this look right? You can confirm or let me know if anything needs correcting.");

  return lines.join("\n");
}

/**
 * Build PM recommendations based on gathered info and guided outcome.
 */
function buildRecommendations(
  gathered: GatheredInfo,
  guidedState?: GuidedTroubleshootingState | null
): string[] {
  const recs: string[] = [];

  // Entry point → sealing needed
  if (gathered.entry_point) {
    recs.push(`Seal or repair entry point: ${gathered.entry_point}`);
  }

  // Pest → professional service
  if (gathered.category === "pest_control") {
    if (gathered.subcategory === "bedbugs") {
      recs.push("Schedule licensed pest control — bed bugs require professional treatment");
    } else if (gathered.subcategory && ["rats", "mice"].includes(gathered.subcategory)) {
      recs.push("Schedule professional pest control for rodent issue");
    } else {
      recs.push("Evaluate whether professional pest control is needed");
    }
  }

  // Emergency
  if (gathered.is_emergency) {
    recs.push("Urgent: respond within 2 hours");
  }

  // Guided outcome
  if (guidedState) {
    if (guidedState.outcome === "escalated") {
      recs.push("Tenant issue escalated — requires direct PM attention");
    } else if (guidedState.outcome === "resolved") {
      recs.push("Tenant reports issue resolved — verify and close");
    } else if (guidedState.outcome === "all_steps_done") {
      recs.push("All troubleshooting steps exhausted — schedule maintenance visit");
    }
  }

  if (recs.length === 0) {
    recs.push("Review and assign to appropriate trade");
  }

  return recs;
}
