import { createServiceClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = {
  title: "Tenants | PropCare-AI",
};

export default async function TenantsPage() {
  const supabase = await createServiceClient();

  // Load all tenant profiles
  const { data: tenants, error: tenantsErr } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, created_at")
    .eq("role", "tenant")
    .order("created_at", { ascending: false });

  if (tenantsErr) {
    throw new Error("Failed to load tenants");
  }

  // Load ticket counts grouped by tenant_id
  const tenantIds = (tenants ?? []).map((t) => t.id);
  let ticketCounts: Record<string, number> = {};

  if (tenantIds.length > 0) {
    const { data: tickets } = await supabase
      .from("tickets")
      .select("tenant_id")
      .in("tenant_id", tenantIds);

    if (tickets) {
      ticketCounts = tickets.reduce<Record<string, number>>((acc, t) => {
        acc[t.tenant_id] = (acc[t.tenant_id] ?? 0) + 1;
        return acc;
      }, {});
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Tenants</h2>

      {!tenants || tenants.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No tenants found.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>All Tenants ({tenants.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-medium text-gray-500">
                    <th className="pb-2 pr-4">Name</th>
                    <th className="pb-2 pr-4">Email</th>
                    <th className="pb-2 pr-4">Phone</th>
                    <th className="pb-2 pr-4">Tickets</th>
                    <th className="pb-2">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tenants.map((tenant) => (
                    <tr key={tenant.id} className="text-gray-700">
                      <td className="py-3 pr-4 font-medium text-gray-900">
                        {tenant.full_name}
                      </td>
                      <td className="py-3 pr-4">{tenant.email}</td>
                      <td className="py-3 pr-4">{tenant.phone ?? "—"}</td>
                      <td className="py-3 pr-4">
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                          {ticketCounts[tenant.id] ?? 0}
                        </span>
                      </td>
                      <td className="py-3 text-gray-500">
                        {new Date(tenant.created_at).toLocaleDateString()}
                      </td>
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
