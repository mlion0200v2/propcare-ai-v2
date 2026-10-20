import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeam } from "@/lib/workspace/server";
import { appUrl } from "@/lib/app-url";
import { qrSvg } from "@/lib/intake/qr";
import { endTenancy } from "@/lib/actions/workspace";
import { STAGE_LABELS } from "@/lib/utils/constants";
import { CopyLinkField, LinkToggle, RegenerateLinkButton } from "@/components/workspace/link-controls";
import { secondaryButton } from "@/components/workspace/forms";

export const metadata = {
  title: "Unit | PropCare",
};

export default async function UnitPage({ params }: { params: Promise<{ id: string }> }) {
  const membership = await requireTeam();
  const { id } = await params;
  const supabase = await createClient();

  // RLS: only the workspace team can read the unit (and its link token).
  const { data: unit } = await supabase
    .from("units")
    .select("id, unit_number, intake_token, link_active, link_rotated_at, properties(id, address_line1)")
    .eq("id", id)
    .maybeSingle();
  if (!unit) notFound();

  const [{ data: tenancies }, { data: tickets }] = await Promise.all([
    supabase
      .from("tenancies")
      .select("id, name, email, phone, tenant_user_id")
      .eq("unit_id", unit.id)
      .is("ended_at", null)
      .order("created_at"),
    supabase
      .from("tickets")
      .select("id, title, stage, created_at")
      .eq("unit_id", unit.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const link = appUrl(`/r/${unit.intake_token}`);
  const qr = await qrSvg(link);
  const unitName = unit.unit_number ? `Unit ${unit.unit_number}` : "Whole home";
  const address = unit.properties?.address_line1 ?? "";
  const message = `Hi, this is ${membership.workspaceName}. To report a repair at ${address}${
    unit.unit_number ? `, Unit ${unit.unit_number}` : ""
  }, use this link any time: ${link}`;

  return (
    <div className="space-y-7">
      <div>
        <p className="text-[13px] text-muted">
          <Link href="/homes" className="underline">
            Homes
          </Link>{" "}
          /{" "}
          <Link href={`/homes/${unit.properties?.id}`} className="underline">
            {address}
          </Link>
        </p>
        <h1 className="mt-2 font-display text-[34px] leading-tight">{unitName}</h1>
      </div>

      <div className="grid gap-7 xl:grid-cols-[3fr_2fr]">
        <section className="border border-line bg-white p-6 sm:p-7">
          <h2 className="text-lg font-semibold">Tenant link</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Send this to the tenant. Anyone with it can report a problem for this unit, so make a new one when tenants
            move out.
          </p>
          {!unit.link_active && (
            <p role="status" className="mt-3 bg-brick/5 px-3 py-2 text-sm text-brick">
              This link is off. Tenants who open it see a message to contact you.
            </p>
          )}
          <div className="mt-4">
            <CopyLinkField url={link} />
          </div>
          <div className="mt-3.5 flex flex-wrap gap-2.5">
            <a href={`sms:?&body=${encodeURIComponent(message)}`} className={secondaryButton}>
              Text it to the tenant
            </a>
            <a
              href={`mailto:?subject=${encodeURIComponent(`Report a repair at ${address}`)}&body=${encodeURIComponent(message)}`}
              className={secondaryButton}
            >
              Email it
            </a>
            <a href={`/print/units/${unit.id}`} target="_blank" rel="noopener" className={secondaryButton}>
              Print a QR poster
            </a>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-5 border-t border-line pt-5">
            <LinkToggle unitId={unit.id} active={unit.link_active} />
            <RegenerateLinkButton unitId={unit.id} />
          </div>
          {unit.link_rotated_at && (
            <p className="mt-2 text-xs text-muted">
              Link last replaced {new Date(unit.link_rotated_at).toLocaleDateString("en-CA")}
            </p>
          )}
        </section>

        <section className="flex items-center gap-5 border border-line bg-white p-6 sm:p-7">
          <div
            role="img"
            aria-label="QR code for this unit's tenant link"
            className="w-[150px] flex-none"
            dangerouslySetInnerHTML={{ __html: qr }}
          />
          <div>
            <p className="text-[15px] font-semibold">Poster for the unit</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              &ldquo;Something broken? Scan to report it, any time.&rdquo; Stick it inside a kitchen cabinet or by the
              electrical panel.
            </p>
          </div>
        </section>
      </div>

      <div className="grid gap-7 xl:grid-cols-[2fr_3fr]">
        <section className="border border-line bg-white p-6 sm:p-7">
          <h2 className="text-lg font-semibold">Current tenant</h2>
          {!tenancies || tenancies.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nobody has used the link yet.</p>
          ) : (
            <ul className="mt-3 space-y-4">
              {tenancies.map((t) => (
                <li key={t.id}>
                  <p className="text-[15px]">{t.name}</p>
                  <p className="mt-1 text-sm text-muted">{[t.phone, t.email].filter(Boolean).join(" · ")}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <span className="bg-sage px-2.5 py-1 text-xs font-semibold text-pine">
                      {t.tenant_user_id ? "Has an account" : "Link only"}
                    </span>
                    <form action={endTenancy}>
                      <input type="hidden" name="unit_id" value={unit.id} />
                      <input type="hidden" name="tenancy_id" value={t.id} />
                      <button type="submit" className="text-xs text-brick underline">
                        Moved out
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border border-line bg-white p-6 sm:p-7">
          <h2 className="text-lg font-semibold">Requests for this unit</h2>
          {!tickets || tickets.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No requests yet.</p>
          ) : (
            <ul className="mt-3">
              {tickets.map((t) => (
                <li key={t.id} className="flex justify-between gap-3 border-b border-line py-3 text-sm last:border-b-0">
                  <Link href={`/tickets/${t.id}`} className="underline">
                    {t.title}
                  </Link>
                  <span className="whitespace-nowrap text-muted">
                    {STAGE_LABELS[t.stage]} · {new Date(t.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
