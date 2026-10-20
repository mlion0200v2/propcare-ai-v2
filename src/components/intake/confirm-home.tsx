"use client";

import { useState } from "react";

/**
 * The link already knows the home: the tenant confirms it instead of typing
 * an address. One link per unit, so nobody picks among addresses.
 */
export function ConfirmHome({ address, children }: { address: string; children: React.ReactNode }) {
  const [answer, setAnswer] = useState<"yes" | "no" | null>(null);

  if (answer === "yes") return <>{children}</>;

  if (answer === "no") {
    return (
      <div role="status" className="space-y-3 border border-line bg-white p-4 text-sm leading-relaxed">
        <p className="font-semibold">This link is for {address} only.</p>
        <p className="text-muted">
          Each home has its own link and QR code. Please use the one your landlord gave you for your home, or ask them
          for it. If something is dangerous right now, call 911.
        </p>
        <button type="button" onClick={() => setAnswer(null)} className="text-pine underline">
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[17px] font-semibold leading-snug">Is the problem at {address}?</p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => setAnswer("yes")} className="bg-pine p-4 text-[15px] text-white hover:bg-ink">
          Yes
        </button>
        <button type="button" onClick={() => setAnswer("no")} className="border border-line bg-white p-4 text-[15px] hover:border-pine">
          This isn&apos;t my home
        </button>
      </div>
    </div>
  );
}
