/**
 * GET /api/triage/hints?ticket_id=… — tap-answers and prevention notes for
 * the tenant chat (see src/lib/triage/hints.ts). Read through the caller's
 * session: RLS returns only their own ticket and unit.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildChatHints } from "@/lib/triage/hints";
import { readUnitProfile } from "@/lib/units/profile";

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
    .select("triage_state, description, classification, units(profile)")
    .eq("id", ticketId)
    .eq("tenant_id", user.id)
    .maybeSingle();
  if (!ticket) return NextResponse.json({ quickReplies: [], notes: [] });

  const c = (ticket.classification ?? {}) as { current_question?: string | null; gathered?: { category?: string | null } };
  return NextResponse.json(
    buildChatHints({
      currentQuestion: c.current_question ?? null,
      triageState: ticket.triage_state,
      category: c.gathered?.category ?? null,
      description: ticket.description,
      profile: readUnitProfile(ticket.units?.profile),
    })
  );
}
