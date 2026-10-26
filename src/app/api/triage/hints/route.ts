/**
 * GET /api/triage/hints?ticket_id=… — tap-answers and prevention notes for
 * the tenant chat, stored by the assistant with the conversation. Read through the caller's
 * session: RLS returns only their own ticket and unit.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const ticketId = request.nextUrl.searchParams.get("ticket_id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return NextResponse.json({ quickReplies: [], notes: [] });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: ticket } = await supabase
    .from("tickets")
    .select("triage_state, classification")
    .eq("id", ticketId)
    .eq("tenant_id", user.id)
    .maybeSingle();
  if (!ticket) return NextResponse.json({ quickReplies: [], notes: [] });

  // The assistant stores the options and notes for its current question with the conversation state.
  const ui = (ticket.classification as { ui?: { options?: string[]; notes?: string[] } } | null)?.ui;
  if (ticket.triage_state === "DONE" || !ui) return NextResponse.json({ quickReplies: [], notes: [] });
  return NextResponse.json({ quickReplies: ui.options ?? [], notes: ui.notes ?? [] });
}
