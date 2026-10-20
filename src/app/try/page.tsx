import { notFound } from "next/navigation";
import { isDemoMode } from "@/lib/demo/config";
import { StartDemoButtons } from "@/components/demo/start-demo";

export const metadata = {
  title: "Try PropCare | PropCare by Birchwood Management",
  description: "See PropCare from the tenant's, manager's, owner's and vendor's side. No sign-up.",
};

export const dynamic = "force-dynamic";

export default async function TryPage({ searchParams }: { searchParams: Promise<{ expired?: string; error?: string }> }) {
  if (!isDemoMode()) notFound();
  const { expired, error } = await searchParams;

  return (
    <div className="grid min-h-screen font-brand text-ink lg:grid-cols-[5fr_7fr]">
      <aside className="flex flex-col justify-between gap-10 bg-pine p-8 text-white sm:p-16">
        <div>
          <p className="font-display text-[22px] tracking-[2px] text-gold">PropCare</p>
          <p className="mt-2 text-xs uppercase tracking-[1.5px] text-[#cad7cf]">by Birchwood Management</p>
          <h1 className="mt-12 font-display text-4xl leading-tight sm:mt-16 sm:text-[44px]">
            Skip to the fun part.
          </h1>
          <p className="mt-6 max-w-md text-base leading-relaxed text-[#e0e5d9]">
            A private sample workspace, just for this browser: two homes, a tenant, an owner, a plumber, and requests
            at every stage. Switch between their views in one click.
          </p>
        </div>
        <p className="text-[13px] text-[#cad7cf]">Sample data only. Nothing is emailed or texted. It disappears after 24 hours.</p>
      </aside>
      <section className="flex flex-col justify-center gap-8 bg-paper px-4 py-12 sm:px-12 lg:px-24">
        {expired && (
          <p role="status" className="border border-line bg-sage px-4 py-3 text-sm text-pine">
            Your earlier demo has expired. Start a fresh one below.
          </p>
        )}
        {error && (
          <p role="alert" className="border border-brick/30 bg-brick/5 px-4 py-3 text-sm text-brick">
            Something went wrong switching views. Start again below.
          </p>
        )}
        <StartDemoButtons />
        <p className="text-sm text-muted">
          Ready for the real thing?{" "}
          <a href="/signup" className="text-pine underline">
            Create your workspace
          </a>
        </p>
      </section>
    </div>
  );
}
