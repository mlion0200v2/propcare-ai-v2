import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireTeam } from "@/lib/workspace/server";
import { appUrl } from "@/lib/app-url";
import { qrSvg } from "@/lib/intake/qr";
import { PrintButton } from "@/components/workspace/print-button";

export const metadata = {
  title: "QR poster | PropCare",
};

export const dynamic = "force-dynamic";

/** Printable letter-size poster with the unit's QR code. */
export default async function UnitPosterPage({ params }: { params: Promise<{ id: string }> }) {
  const membership = await requireTeam();
  const { id } = await params;
  const supabase = await createClient();
  const { data: unit } = await supabase
    .from("units")
    .select("unit_number, intake_token, link_active, properties(address_line1)")
    .eq("id", id)
    .maybeSingle();
  if (!unit) notFound();

  const link = appUrl(`/r/${unit.intake_token}`);
  const qr = await qrSvg(link);

  return (
    <div className="mx-auto flex min-h-screen max-w-[8.5in] flex-col items-center justify-center gap-8 bg-white p-10 text-center font-brand text-ink">
      <PrintButton />
      <p className="text-sm uppercase tracking-[2px] text-brass">{membership.workspaceName}</p>
      <h1 className="font-display text-5xl leading-tight">Something broken?</h1>
      <p className="text-2xl">Scan to report it, any time.</p>
      <div className="w-72" role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: qr }} />
      <p className="text-lg">
        {unit.properties?.address_line1}
        {unit.unit_number ? `, Unit ${unit.unit_number}` : ""}
      </p>
      <p className="break-all text-sm text-muted">{link}</p>
      <p className="max-w-md border-2 border-brick p-4 text-base text-brick">
        Smell gas or a CO alarm is going off? Leave now. From outside, call FortisBC 1-800-663-9911 or 911.
      </p>
      {!unit.link_active && <p className="text-sm text-brick print:hidden">This link is off: turn it on before printing.</p>}
    </div>
  );
}
