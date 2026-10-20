"use client";

import { usePathname } from "next/navigation";
import { endDemo, switchDemoRole } from "@/lib/actions/demo";
import type { DemoRole } from "@/lib/demo/config";

const LABELS: Record<DemoRole, string> = { tenant: "Tenant", manager: "Manager", owner: "Owner", vendor: "Vendor" };

/** Sticky "Demo — sample data" bar with the perspective switcher. */
export function DemoBar({ role, hoursLeft }: { role: DemoRole | null; hoursLeft: number }) {
  const pathname = usePathname();
  const current: DemoRole | null = pathname.startsWith("/v/") ? "vendor" : role;

  return (
    <div className="sticky top-0 z-50 border-b border-gold bg-cream font-brand text-ink print:hidden">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 text-sm">
        <p>
          <b className="text-brass">Demo — sample data.</b>{" "}
          <span className="text-muted">Nothing is sent. Resets in about {hoursLeft} h.</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted" id="demo-viewing-as">
            Viewing as:
          </span>
          <div role="group" aria-labelledby="demo-viewing-as" className="flex flex-wrap gap-1">
            {(Object.keys(LABELS) as DemoRole[]).map((r) => (
              <form key={r} action={switchDemoRole}>
                <input type="hidden" name="role" value={r} />
                <input type="hidden" name="pathname" value={pathname} />
                <button
                  type="submit"
                  aria-pressed={current === r}
                  className={`min-h-9 border px-3 py-1.5 text-[13px] ${
                    current === r ? "border-pine bg-pine text-white" : "border-line bg-white text-ink hover:border-pine"
                  }`}
                >
                  {LABELS[r]}
                </button>
              </form>
            ))}
          </div>
          <form action={endDemo}>
            <button type="submit" className="px-2 py-1.5 text-[13px] text-muted underline">
              Leave demo
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
