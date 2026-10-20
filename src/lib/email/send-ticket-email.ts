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
  to: string | string[];
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

/**
 * Team (admin + manager) emails of the workspace that owns the ticket.
 *
 * Uses the service client because the tenant's session cannot read other
 * users' profiles. Recipients are looked up strictly through the ticket's
 * workspace: there is no cross-workspace address matching (a tenant typing
 * someone else's street address must never email that landlord).
 */
export async function getManagerEmailForTicket(
  ticketId: string,
  _unitId?: string | null,
  _reportedAddress?: string | null
): Promise<string[] | null> {
  let supabase;
  try {
    supabase = createServiceClient();
  } catch (err) {
    logError("email_resolve_manager", err, { ticketId, reason: "service_client_init_failed" });
    return fallbackManagerEmail(ticketId);
  }

  try {
    const { data: ticket, error } = await supabase
      .from("tickets")
      .select("workspace_id")
      .eq("id", ticketId)
      .maybeSingle();

    if (!error && ticket?.workspace_id) {
      const emails = await getWorkspaceTeamEmails(ticket.workspace_id);
      if (emails.length > 0) return emails;
    }

    logWarn("email_resolve_manager", "No team email for ticket's workspace", {
      ticketId,
      workspaceId: ticket?.workspace_id ?? null,
      error: error?.message,
    });
  } catch (err) {
    logError("email_resolve_manager", err, { ticketId });
  }

  return fallbackManagerEmail(ticketId);
}

/** Emails of a workspace's admins and managers (service role). */
export async function getWorkspaceTeamEmails(workspaceId: string): Promise<string[]> {
  const supabase = createServiceClient();
  const { data: members } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .in("role", ["admin", "manager"]);
  const ids = (members ?? []).map((m) => m.user_id);
  if (ids.length === 0) return [];
  const { data: profiles } = await supabase.from("profiles").select("email").in("id", ids);
  return (profiles ?? []).map((p) => p.email).filter((e): e is string => !!e);
}

function fallbackManagerEmail(ticketId: string): string[] | null {
  const fallback = process.env.FALLBACK_MANAGER_EMAIL;
  if (fallback) {
    logWarn("email_resolve_manager", "Using fallback manager email", { ticketId, fallback });
    return [fallback];
  }
  logWarn("email_resolve_manager", "No manager email resolved — skipping PM email", { ticketId });
  return null;
}
