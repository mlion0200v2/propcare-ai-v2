import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeam } from "@/lib/workspace/server";
import { UnitForm } from "@/components/workspace/forms";

export const metadata = {
  title: "Home | PropCare",
};

export default async function HomePage({ params }: { params: Promise<{ id: string }> }) {
  await requireTeam();
  const { id } = await params;
  const supabase = await createClient();

  // RLS returns the property only to its workspace team.
  const { data: property } = await supabase
    .from("properties")
    .select("id, address_line1, address_line2, city, state, zip, units(id, unit_number, link_active, created_at)")
    .eq("id", id)
    .maybeSingle();
  if (!property) notFound();

  const units = [...property.units].sort((a, b) =>
    (a.unit_number ?? "").localeCompare(b.unit_number ?? "", undefined, { numeric: true })
  );

  return (
    <div className="space-y-8">
      <div>
        <p className="text-[13px] text-muted">
          <Link href="/homes" className="underline">
            Homes
          </Link>{" "}
          / {property.address_line1}
        </p>
        <h1 className="mt-2 font-display text-[34px] leading-tight">{property.address_line1}</h1>
        <p className="mt-1 text-sm text-muted">
          {[property.address_line2, property.city, property.state, property.zip].filter(Boolean).join(", ")}
        </p>
      </div>

      <section className="border border-line bg-white p-6 sm:p-7">
        <h2 className="text-lg font-semibold">Units</h2>
        {units.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No units yet. Add one below to get its tenant link.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {units.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <Link href={`/units/${u.id}`} className="text-[15px] font-medium text-pine underline">
                  {u.unit_number ? `Unit ${u.unit_number}` : "Whole home"}
                </Link>
                <span className={`text-sm ${u.link_active ? "text-muted" : "text-brick"}`}>
                  {u.link_active ? "Tenant link on" : "Tenant link off"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 border-t border-line pt-5">
          <UnitForm propertyId={property.id} />
        </div>
      </section>
    </div>
  );
}
