import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireTeam } from "@/lib/workspace/server";
import { PropertyForm } from "@/components/workspace/forms";

export const metadata = {
  title: "Homes and units | PropCare",
};

export default async function HomesPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const membership = await requireTeam();
  const { welcome } = await searchParams;
  const supabase = await createClient();

  const { data: properties } = await supabase
    .from("properties")
    .select("id, address_line1, city, property_type, units(id, link_active)")
    .eq("workspace_id", membership.workspaceId)
    .order("created_at", { ascending: true });

  const list = properties ?? [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-[34px] leading-tight">Homes and units</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted">
          Each unit gets its own tenant link. Tenants use it to report a problem, no account needed.
        </p>
      </div>

      {welcome && list.length === 0 && (
        <div role="status" className="border border-line bg-sage px-5 py-4 text-[15px] text-pine">
          Your workspace is ready. Add your first home and its units below.
        </div>
      )}

      {list.length > 0 && (
        <ul className="divide-y divide-line border border-line bg-white">
          {list.map((p) => (
            <li key={p.id}>
              <Link href={`/homes/${p.id}`} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 hover:bg-paper">
                <span>
                  <span className="block text-[15px] font-medium">{p.address_line1}</span>
                  <span className="text-sm text-muted">{p.city}</span>
                </span>
                <span className="text-sm text-muted">
                  {p.units.length} {p.units.length === 1 ? "unit" : "units"}
                  {p.units.some((u) => !u.link_active) ? " · some links off" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="border border-line bg-white p-6 sm:p-7">
        <h2 className="text-lg font-semibold">Add a home</h2>
        <div className="mt-4">
          <PropertyForm />
        </div>
      </section>
    </div>
  );
}
