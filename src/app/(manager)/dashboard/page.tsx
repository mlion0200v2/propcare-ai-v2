import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = {
  title: "Dashboard | MaintenanceWise",
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Get tickets for properties managed by this user (includes unassigned unit_id tickets)
  // Two queries: assigned tickets (via unit join) + unassigned tickets (unit_id IS NULL)
  const { data: assignedTickets } = await supabase
    .from("tickets")
    .select(`
      id,
      title,
      category,
      priority,
      status,
      triage_state,
      created_at,
      unit_id,
      classification,
      units!inner(
        unit_number,
        properties!inner(
          address_line1,
          manager_id
        )
      )
    `)
    .eq("units.properties.manager_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: unassignedTickets } = await supabase
    .from("tickets")
    .select(`
      id,
      title,
      category,
      priority,
      status,
      triage_state,
      created_at,
      unit_id,
      classification
    `)
    .is("unit_id", null)
    .order("created_at", { ascending: false })
    .limit(50);

  // Merge and sort by created_at descending
  const tickets = [
    ...(assignedTickets ?? []),
    ...(unassignedTickets ?? []),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
   .slice(0, 50);

  const priorityColors: Record<string, string> = {
    emergency: "bg-red-100 text-red-800",
    high: "bg-orange-100 text-orange-800",
    medium: "bg-yellow-100 text-yellow-800",
    low: "bg-green-100 text-green-800",
  };

  const statusColors: Record<string, string> = {
    open: "bg-blue-100 text-blue-800",
    in_progress: "bg-purple-100 text-purple-800",
    awaiting_tenant: "bg-yellow-100 text-yellow-800",
    escalated: "bg-red-100 text-red-800",
    resolved: "bg-green-100 text-green-800",
    closed: "bg-gray-100 text-gray-800",
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Tickets</h2>

      {!tickets || tickets.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No tickets yet. Tickets will appear here when tenants submit issues.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <Link key={ticket.id} href={`/tickets/${ticket.id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex items-center justify-between py-4">
                  <div className="space-y-1">
                    <p className="font-medium text-gray-900">{ticket.title}</p>
                    {(() => {
                      const summary = (ticket.classification as { summary?: string } | null)?.summary;
                      if (!summary) return null;
                      const preview = summary.length > 120 ? summary.slice(0, 120) + "..." : summary;
                      return <p className="text-xs text-gray-500 line-clamp-2">{preview}</p>;
                    })()}
                    <div className="flex gap-2 text-xs">
                      <span className={`rounded-full px-2 py-0.5 font-medium ${priorityColors[ticket.priority] ?? "bg-gray-100"}`}>
                        {ticket.priority}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 font-medium ${statusColors[ticket.status] ?? "bg-gray-100"}`}>
                        {ticket.status.replace("_", " ")}
                      </span>
                      <span className="text-gray-500">
                        {ticket.category.replace("_", " ")}
                      </span>
                      {ticket.triage_state !== "DONE" && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                          triage in progress
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-gray-400">
                    {new Date(ticket.created_at).toLocaleDateString()}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
