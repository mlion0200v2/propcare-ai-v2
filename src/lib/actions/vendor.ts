"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/request-ip";
import { vendorQuoteLimiter } from "@/lib/rate-limit";
import { dollarsToCents, formatCents } from "@/lib/workspace/tokens";
import { logError } from "@/lib/triage/logger";

export type QuoteState = { error: string | null; ok?: string | null };

const tokenSchema = z.string().regex(/^[A-Za-z0-9]{32,128}$/);

/**
 * A vendor (no account) submits a quote through their work-order link. Runs
 * with the service role, scoped by the unguessable token. A quote above the
 * workspace's approval limit opens an owner approval automatically.
 */
export async function submitVendorQuote(_prev: QuoteState, formData: FormData): Promise<QuoteState> {
  const token = tokenSchema.safeParse(formData.get("token"));
  if (!token.success) return { error: "This link is not valid." };
  const cents = dollarsToCents(String(formData.get("amount") ?? ""));
  if (!cents) return { error: "Enter the quote in dollars, e.g. 340" };
  const note = String(formData.get("note") ?? "").trim().slice(0, 2000);
  if (!vendorQuoteLimiter.check(await clientIp()).allowed) return { error: "Too many submissions. Please try again later." };

  const service = createServiceClient();
  const { data: order } = await service
    .from("work_orders")
    .select("id, ticket_id, workspace_id, vendor_name, status, workspaces(approval_limit_cents, kind)")
    .eq("token", token.data)
    .maybeSingle();
  if (!order || order.status === "cancelled") return { error: "This work order is no longer open." };

  const { error } = await service
    .from("work_orders")
    .update({ quote_cents: cents, quote_note: note || null, quoted_at: new Date().toISOString(), status: "quoted" })
    .eq("id", order.id);
  if (error) {
    logError("vendor_quote", error);
    return { error: "Could not save the quote. Please try again." };
  }

  const activity = (body: string) =>
    service.from("ticket_comments").insert({
      ticket_id: order.ticket_id,
      workspace_id: order.workspace_id,
      author_id: null,
      author_name: "PropCare",
      author_role: "system",
      visibility: "team_owner",
      body,
    });
  await activity(`${order.vendor_name} quoted ${formatCents(cents)}${note ? `: ${note}` : "."}`);

  const limit = order.workspaces?.approval_limit_cents ?? 0;
  if (order.workspaces?.kind === "company" && cents > limit) {
    const { count } = await service
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("ticket_id", order.ticket_id)
      .eq("decision", "pending");
    if ((count ?? 0) === 0) {
      await service.from("approvals").insert({
        ticket_id: order.ticket_id,
        amount_cents: cents,
        limit_cents: limit,
        description: `${order.vendor_name}${note ? `: ${note}` : ""}`.slice(0, 1000),
      });
      await service.from("tickets").update({ stage: "waiting_for_owner" }).eq("id", order.ticket_id);
      await activity(`The quote is over the ${formatCents(limit)} limit, so the owner has been asked to approve it.`);
    }
  }

  revalidatePath(`/v/${token.data}`);
  return { error: null, ok: "Quote sent. Thank you." };
}
