import { Resend } from "resend";
import { logTriageStep, logError, logWarn } from "@/lib/triage/logger";
import { createServiceClient } from "@/lib/supabase/server";

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export async function sendTicketSummaryEmail(params: {
  to: string;
  ticketId: string;
  ticketTitle: string;
  summary: string;
  isEmergency: boolean;
  category: string;
}): Promise<{ success: boolean; error?: string }> {
  const { to, ticketId, ticketTitle, summary, isEmergency, category } = params;

  const prefix = isEmergency ? "[EMERGENCY] " : "";
  const subject = `${prefix}[PropCare-AI] New ticket: ${ticketTitle}`;

  try {
    const { error } = await getResend().emails.send({
      from: "PropCare-AI <noreply@simoneliu.com>",
      to,
      subject,
      text: summary,
    });

    if (error) {
      logError("email_send", error, { ticketId, to, category });
      return { success: false, error: error.message };
    }

    logTriageStep({
      trace_id: ticketId,
      ticket_id: ticketId,
      triage_state: "DONE",
      action: "email_sent",
      latency_ms: 0,
      timestamp: new Date().toISOString(),
      metadata: { to, category, isEmergency },
    });

    return { success: true };
  } catch (err) {
    logError("email_send", err, { ticketId, to, category });
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getManagerEmailForTicket(
  ticketId: string,
  unitId: string | null,
  reportedAddress?: string | null
): Promise<string | null> {
  // Use service client (bypasses RLS) — tenant's scoped client cannot read
  // the manager's profile row, so the unit → property → manager join fails.
  let supabase;
  try {
    supabase = await createServiceClient();
  } catch (err) {
    logError("email_resolve_manager", err, { ticketId, reason: "service_client_init_failed" });
    // Fall through to fallback env var below
    const fallback = process.env.FALLBACK_MANAGER_EMAIL;
    if (fallback) {
      logWarn("email_resolve_manager", "Using fallback manager email (service client unavailable)", { ticketId, fallback });
      return fallback;
    }
    return null;
  }

  // Path 1: unit_id known — direct lookup via units → properties → manager
  if (unitId) {
    try {
      const { data, error } = await supabase
        .from("units")
        .select("properties!inner(manager_id, profiles:manager_id(email))")
        .eq("id", unitId)
        .single();

      if (!error && data) {
        const properties = data.properties as unknown as {
          manager_id: string;
          profiles: { email: string } | null;
        };
        const email = properties?.profiles?.email;
        if (email) return email;
      }

      logWarn("email_resolve_manager", "Could not resolve manager for unit", {
        ticketId,
        unitId,
        error: error?.message,
      });
    } catch (err) {
      logError("email_resolve_manager", err, { ticketId, unitId });
    }
  }

  // Path 2: no unit_id — try address-based lookup via reported_address
  if (!unitId && reportedAddress) {
    try {
      // Extract first line (street address) before any comma or newline
      const streetAddress = reportedAddress.split(/[,\n]/)[0].trim();
      if (streetAddress.length >= 5) {
        const { data } = await supabase
          .from("properties")
          .select("manager_id, profiles:manager_id(email)")
          .ilike("address_line1", `%${streetAddress}%`)
          .limit(1)
          .maybeSingle();

        if (data) {
          const profiles = (data as Record<string, unknown>).profiles as { email: string } | null;
          if (profiles?.email) {
            logTriageStep({
              trace_id: ticketId,
              ticket_id: ticketId,
              triage_state: "DONE",
              action: "email_resolved_by_address",
              latency_ms: 0,
              timestamp: new Date().toISOString(),
              metadata: { reportedAddress: streetAddress },
            });
            return profiles.email;
          }
        }
      }

      logWarn("email_resolve_manager", "Address lookup found no match", {
        ticketId,
        reportedAddress,
      });
    } catch (err) {
      logWarn("email_resolve_manager", "Address lookup failed", {
        ticketId,
        reportedAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Path 3: fallback env var
  const fallback = process.env.FALLBACK_MANAGER_EMAIL;
  if (fallback) {
    logWarn("email_resolve_manager", "Using fallback manager email", { ticketId, fallback });
    return fallback;
  }

  logWarn("email_resolve_manager", "No manager email resolved — skipping PM email", { ticketId });
  return null;
}
