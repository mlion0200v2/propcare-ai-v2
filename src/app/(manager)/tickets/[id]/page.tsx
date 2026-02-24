import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GatheredInfo, TenantInfo } from "@/lib/triage/types";

export const metadata = {
  title: "Ticket Details | MaintenanceWise",
};

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !ticket) notFound();

  // Load messages
  const { data: messages } = await supabase
    .from("messages")
    .select("id, body, is_bot_reply, created_at, sender_id")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true });

  const classification = ticket.classification as { gathered?: GatheredInfo; tenant_info?: TenantInfo } | null;
  const gathered = classification?.gathered;
  const tenantInfo = classification?.tenant_info;

  const priorityColors: Record<string, string> = {
    emergency: "bg-red-100 text-red-800",
    high: "bg-orange-100 text-orange-800",
    medium: "bg-yellow-100 text-yellow-800",
    low: "bg-green-100 text-green-800",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard"
          className="text-sm text-blue-600 hover:text-blue-500"
        >
          &larr; Back to Dashboard
        </Link>
      </div>

      {/* Ticket header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>{ticket.title}</CardTitle>
              <p className="mt-1 text-sm text-gray-500">
                Created {new Date(ticket.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${priorityColors[ticket.priority] ?? "bg-gray-100"}`}>
                {ticket.priority}
              </span>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-800">
                {ticket.status.replace("_", " ")}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-gray-700">Description</h4>
            <p className="mt-1 text-sm text-gray-600">{ticket.description}</p>
          </div>

          {gathered && (
            <div className="grid grid-cols-2 gap-4 rounded-lg bg-gray-50 p-4">
              <div>
                <p className="text-xs font-medium text-gray-500">Category</p>
                <p className="text-sm">{gathered.category ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">Location</p>
                <p className="text-sm">{gathered.location_in_unit ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">Started when</p>
                <p className="text-sm">{gathered.started_when ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500">Emergency</p>
                <p className="text-sm">
                  {gathered.is_emergency === null
                    ? "—"
                    : gathered.is_emergency
                    ? "Yes"
                    : "No"}
                </p>
              </div>
            </div>
          )}

          {tenantInfo && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <h4 className="text-sm font-medium text-amber-800">Reported Tenant Info (no unit on file)</h4>
              <div className="mt-2 grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs font-medium text-gray-500">Address</p>
                  <p className="text-sm">{tenantInfo.reported_address ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">Phone</p>
                  <p className="text-sm">{tenantInfo.contact_phone ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500">Email</p>
                  <p className="text-sm">{tenantInfo.contact_email ?? "—"}</p>
                </div>
              </div>
            </div>
          )}

          {ticket.troubleshooting_steps && (
            <div>
              <h4 className="text-sm font-medium text-gray-700">Troubleshooting Steps</h4>
              <ul className="mt-2 space-y-1">
                {(ticket.troubleshooting_steps as Array<{ step: number; description: string }>).map(
                  (s) => (
                    <li key={s.step} className="text-sm text-gray-600">
                      {s.step}. {s.description}
                    </li>
                  )
                )}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Conversation */}
      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {messages && messages.length > 0 ? (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-lg p-3 text-sm ${
                  msg.is_bot_reply
                    ? "bg-gray-50 text-gray-700"
                    : "bg-blue-50 text-blue-900"
                }`}
              >
                <p className="mb-1 text-xs font-medium text-gray-400">
                  {msg.is_bot_reply ? "Bot" : "Tenant"} &middot;{" "}
                  {new Date(msg.created_at).toLocaleTimeString()}
                </p>
                <p className="whitespace-pre-wrap">{msg.body}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-500">No messages yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
