import "server-only";

/**
 * Server-side emergency escalation: mark the ticket as an emergency and alert
 * the property manager immediately — not at final submit.
 *
 * Priority/status/safety fields are written with the service role: the
 * tenant's RLS update policy rejects status = 'escalated' (its USING clause
 * doubles as WITH CHECK), and the caller has already verified the ticket
 * belongs to the signed-in tenant.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { sendTicketSummaryEmail, getManagerEmailForTicket } from "@/lib/email/send-ticket-email";
import { logError, logTriageStep } from "./logger";
import { FORTISBC_EMERGENCY_PHONE, type EmergencyMatch } from "./emergency";
import type { TriageClassification } from "./types";
import type { Json } from "@/lib/supabase/database-generated";

export interface EscalationResult {
  /** Ticket now has priority=emergency, status=escalated, triage_state=EMERGENCY. */
  escalated: boolean;
  managerNotified: boolean;
}

const KIND_LABELS: Record<string, string> = {
  gas: "Possible gas leak",
  carbon_monoxide: "Carbon monoxide alarm / exposure",
  fire: "Fire, smoke or burning smell",
  electrical: "Electrical hazard (sparks / shock / exposed wiring)",
  water_electrical: "Water in or near electrical fixtures",
  sewage: "Sewage backup / overflow",
  flooding: "Active flooding / burst pipe",
  no_heat: "No heat in cold weather",
  structural: "Structural collapse risk",
  unconfirmed_safety: "Tenant could not confirm it is safe",
};

export function buildEmergencyManagerEmail(params: {
  ticketId: string;
  description: string;
  latestMessage: string;
  emergency: EmergencyMatch;
  contact: { name?: string | null; email?: string | null; phone?: string | null; address?: string | null; unit?: string | null };
}): string {
  const { ticketId, description, latestMessage, emergency, contact } = params;
  return [
    `EMERGENCY — ${KIND_LABELS[emergency.kind] ?? emergency.kind}`,
    "",
    "PropCare-AI detected a possible emergency and stopped troubleshooting.",
    "The tenant was told to leave if unsafe and given the FortisBC",
    `(${FORTISBC_EMERGENCY_PHONE}) and 911 numbers. Please contact them now.`,
    "",
    `Trigger: "${emergency.phrase}"`,
    `Original report: ${description}`,
    latestMessage && latestMessage !== description ? `Latest message: ${latestMessage}` : null,
    "",
    "Tenant contact:",
    `  Name:    ${contact.name ?? "—"}`,
    `  Phone:   ${contact.phone ?? "—"}`,
    `  Email:   ${contact.email ?? "—"}`,
    `  Address: ${contact.address ?? "—"}${contact.unit ? `, unit ${contact.unit}` : ""}`,
    "",
    `Ticket: ${ticketId}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export async function escalateEmergency(params: {
  ticketId: string;
  tenantId: string;
  unitId: string | null;
  description: string;
  latestMessage: string;
  emergency: EmergencyMatch;
  classification: TriageClassification;
}): Promise<EscalationResult> {
  const { ticketId, tenantId, unitId, description, latestMessage, emergency, classification } = params;
  let escalated = false;
  let managerNotified = false;

  let service: ReturnType<typeof createServiceClient> | null = null;
  try {
    service = createServiceClient();
  } catch (err) {
    logError("emergency_service_client", err, { ticketId });
  }

  if (service) {
    const { error } = await service
      .from("tickets")
      .update({
        triage_state: "EMERGENCY",
        classification: classification as unknown as Json,
        priority: "emergency",
        status: "escalated",
        safety_assessment: {
          flagged: true,
          reason: "emergency_detected",
          kind: emergency.kind,
          phrase: emergency.phrase,
          detected_at: classification.emergency?.detected_at ?? new Date().toISOString(),
        } as unknown as Json,
      })
      .eq("id", ticketId)
      .eq("tenant_id", tenantId);
    if (error) {
      logError("emergency_ticket_update", error, { ticketId });
    } else {
      escalated = true;
    }
  }

  // Alert the manager now. Contact details: what the tenant gave in this
  // ticket, falling back to their profile.
  try {
    const profile = service
      ? (
          await service
            .from("profiles")
            .select("full_name, email, phone, default_property_address, default_unit_number")
            .eq("id", tenantId)
            .maybeSingle()
        ).data
      : null;
    const tenantInfo = classification.tenant_info;
    const to = await getManagerEmailForTicket(ticketId, unitId, tenantInfo?.reported_address ?? profile?.default_property_address);
    if (to) {
      const result = await sendTicketSummaryEmail({
        to,
        ticketId,
        ticketTitle: description.slice(0, 80),
        summary: buildEmergencyManagerEmail({
          ticketId,
          description,
          latestMessage,
          emergency,
          contact: {
            name: profile?.full_name,
            email: tenantInfo?.contact_email ?? profile?.email,
            phone: tenantInfo?.contact_phone ?? profile?.phone,
            address: tenantInfo?.reported_address ?? profile?.default_property_address,
            unit: tenantInfo?.reported_unit_number ?? profile?.default_unit_number,
          },
        }),
        isEmergency: true,
        category: classification.gathered?.category ?? "general",
      });
      managerNotified = result.success;
      if (!result.success) logError("emergency_email_failed", result.error, { ticketId });
    }
  } catch (err) {
    logError("emergency_notify", err, { ticketId });
  }

  // Record that the manager was alerted (shown on the ticket, used in audits).
  if (managerNotified && service && classification.emergency) {
    const { error } = await service
      .from("tickets")
      .update({
        classification: {
          ...classification,
          emergency: { ...classification.emergency, manager_notified: true },
        } as unknown as Json,
      })
      .eq("id", ticketId)
      .eq("tenant_id", tenantId);
    if (error) logError("emergency_notified_flag", error, { ticketId });
  }

  logTriageStep({
    trace_id: ticketId,
    ticket_id: ticketId,
    triage_state: "EMERGENCY",
    action: "emergency_escalated",
    latency_ms: 0,
    timestamp: new Date().toISOString(),
    metadata: { kind: emergency.kind, escalated, manager_notified: managerNotified },
  });

  return { escalated, managerNotified };
}

/**
 * Set fields tenants are not allowed to write (priority, status,
 * safety_assessment) on a ticket the caller has already verified the tenant
 * owns. Returns false (and logs) on failure.
 */
export async function setPrivilegedTicketFields(
  ticketId: string,
  tenantId: string,
  fields: {
    priority?: "low" | "medium" | "high" | "emergency";
    status?: "open" | "in_progress" | "awaiting_tenant" | "escalated" | "resolved" | "closed";
    safety_assessment?: Json | null;
  }
): Promise<boolean> {
  try {
    const { error } = await createServiceClient()
      .from("tickets")
      .update(fields)
      .eq("id", ticketId)
      .eq("tenant_id", tenantId);
    if (error) {
      logError("ticket_privileged_update", error, { ticketId });
      return false;
    }
    return true;
  } catch (err) {
    logError("ticket_privileged_update", err, { ticketId });
    return false;
  }
}
