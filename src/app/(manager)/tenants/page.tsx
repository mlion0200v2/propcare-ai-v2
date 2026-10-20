import { createClient } from "@/lib/supabase/server";
import { requireTeam } from "@/lib/workspace/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "Tenants | PropCare-AI",
};

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  // Team only (admins and managers). Owners and tenants are redirected.
  const membership = await requireTeam();
  const supabase = await createClient();

  // Tenancies of this workspace only, read through RLS with the user's own
  // session (never the service role).
  const { data: tenancies, error } = await supabase
    .from("tenancies")
    .select("id, name, email, phone, tenant_user_id, created_at, ended_at, units(unit_number, properties(address_line1))")
    .eq("workspace_id", membership.workspaceId)
    .is("ended_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error("Failed to load tenants");
  }

  const tenancyIds = (tenancies ?? []).map((t) => t.id);
  let ticketCounts: Record<string, number> = {};
  if (tenancyIds.length > 0) {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("tenancy_id")
      .in("tenancy_id", tenancyIds);
    ticketCounts = (tickets ?? []).reduce<Record<string, number>>((acc, t) => {
      if (t.tenancy_id) acc[t.tenancy_id] = (acc[t.tenancy_id] ?? 0) + 1;
      return acc;
    }, {});
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Tenants</h2>

      {!tenancies || tenancies.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No tenants yet. Tenants appear here after they use a unit&apos;s link.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Current tenants ({tenancies.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-gray-500">
                    <th className="pb-2 pr-4">Name</th>
                    <th className="pb-2 pr-4">Home</th>
                    <th className="pb-2 pr-4">Email</th>
                    <th className="pb-2 pr-4">Phone</th>
                    <th className="pb-2 pr-4">Requests</th>
                    <th className="pb-2">Account</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tenancies.map((t) => (
                    <tr key={t.id} className="text-gray-700">
                      <td className="py-3 pr-4 font-medium text-gray-900">{t.name}</td>
                      <td className="py-3 pr-4">
                        {t.units?.properties?.address_line1 ?? "—"}
                        {t.units?.unit_number ? `, unit ${t.units.unit_number}` : ""}
                      </td>
                      <td className="py-3 pr-4">{t.email ?? "—"}</td>
                      <td className="py-3 pr-4">{t.phone ?? "—"}</td>
                      <td className="py-3 pr-4">
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                          {ticketCounts[t.id] ?? 0}
                        </span>
                      </td>
                      <td className="py-3 text-gray-500">{t.tenant_user_id ? "Has an account" : "Link only"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
