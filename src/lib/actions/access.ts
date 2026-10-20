"use server";

import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { logError } from "@/lib/triage/logger";

export type AccessState = { error: string | null; ok?: string | null };

const accessSchema = z.object({
  ticket_id: z.string().uuid("Invalid request"),
  entry_permission: z.enum(["yes", "no"], { message: "Please choose yes or no" }),
  availability: z.array(z.string().trim().min(1).max(60)).max(8),
  availability_note: z.string().trim().max(200),
  pets: z.string().trim().max(300),
});

/**
 * Tenant's access details after the chat. The ticket is read through the
 * tenant's own session first (RLS proves it's theirs); the write uses the
 * service role because an escalated ticket is no longer tenant-editable.
 */
export async function saveAccessDetails(_prev: AccessState, formData: FormData): Promise<AccessState> {
  const parsed = accessSchema.safeParse({
    ticket_id: formData.get("ticket_id"),
    entry_permission: formData.get("entry_permission"),
    availability: formData.getAll("availability").map(String),
    availability_note: String(formData.get("availability_note") ?? ""),
    pets: String(formData.get("pets") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your session ended. Open your landlord's link again." };
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id")
    .eq("id", parsed.data.ticket_id)
    .eq("tenant_id", user.id)
    .maybeSingle();
  if (!ticket) return { error: "Request not found" };

  const availability = [...parsed.data.availability, parsed.data.availability_note].filter(Boolean).join("; ").slice(0, 300);
  const { error } = await createServiceClient()
    .from("tickets")
    .update({
      entry_permission: parsed.data.entry_permission === "yes",
      availability: availability || null,
      tenant_pets: parsed.data.pets || null,
      access_confirmed_at: new Date().toISOString(),
    })
    .eq("id", ticket.id);
  if (error) {
    logError("save_access_details", error);
    return { error: "Could not save. Please try again." };
  }
  return { error: null, ok: "Thanks. Your landlord will use this to book the repair." };
}
