import "server-only";

import { createServiceClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/mailer";
import { logError } from "@/lib/triage/logger";

export type Channel = "email" | "whatsapp" | "wechat" | "sms";

/** True for the sample workspaces created by /try. */
export async function isDemoWorkspace(workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  const { data } = await createServiceClient().from("workspaces").select("is_demo").eq("id", workspaceId).maybeSingle();
  return data?.is_demo === true;
}

export async function workspaceOfTicket(ticketId: string): Promise<string | null> {
  const { data } = await createServiceClient().from("tickets").select("workspace_id").eq("id", ticketId).maybeSingle();
  return data?.workspace_id ?? null;
}

export interface DeliveryResult {
  success: boolean;
  /** Not delivered: demo workspace. The message is in the outbox as a preview. */
  demo: boolean;
  error?: string;
}

/**
 * The one place the app sends messages on behalf of a workspace. In a demo
 * workspace nothing leaves the app: the exact message is stored in the
 * outbox and shown as "Sent (demo, not delivered)".
 */
export async function deliver(params: {
  workspaceId: string | null;
  ticketId?: string | null;
  channel: Channel;
  to: string | string[];
  /** Shown on the preview card, e.g. "Jamie Lee (tenant)". */
  recipientLabel: string;
  subject?: string;
  text: string;
  kind: string;
}): Promise<DeliveryResult> {
  const { workspaceId, ticketId, channel, to, recipientLabel, subject, text, kind } = params;

  if (await isDemoWorkspace(workspaceId)) {
    const { error } = await createServiceClient().from("outbox").insert({
      workspace_id: workspaceId!,
      ticket_id: ticketId ?? null,
      channel,
      recipient_label: recipientLabel,
      subject: subject ?? null,
      body: text,
      kind,
      demo: true,
    });
    if (error) logError("outbox_insert", error, { kind });
    return { success: !error, demo: true };
  }

  if (channel !== "email") {
    // WhatsApp/WeChat/SMS are sent by the manager's own app (wa.me / copy);
    // the server has no provider yet.
    return { success: false, demo: false, error: `${channel} is not connected` };
  }
  const result = await sendEmail({ to, subject: subject ?? "", text, kind });
  return { ...result, demo: false };
}
