"use client";

import { useState } from "react";
import { regenerateUnitLink, setUnitLinkActive } from "@/lib/actions/workspace";

export function CopyLinkField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2.5">
      <label className="min-w-0 flex-1">
        <span className="sr-only">Tenant link</span>
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="h-12 w-full border border-line bg-paper px-3.5 text-[15px] text-ink"
        />
      </label>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="bg-pine px-5 text-sm text-white hover:bg-ink"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

export function LinkToggle({ unitId, active }: { unitId: string; active: boolean }) {
  return (
    <form action={setUnitLinkActive}>
      <input type="hidden" name="unit_id" value={unitId} />
      <label className="flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          name="active"
          defaultChecked={active}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="h-[18px] w-[18px] accent-pine"
        />
        {active ? "Link is on" : "Link is off"}
      </label>
      <noscript>
        <button type="submit">Save</button>
      </noscript>
    </form>
  );
}

export function RegenerateLinkButton({ unitId }: { unitId: string }) {
  return (
    <form
      action={regenerateUnitLink}
      onSubmit={(e) => {
        if (!confirm("Make a new link? The old link and its QR poster stop working right away.")) e.preventDefault();
      }}
    >
      <input type="hidden" name="unit_id" value={unitId} />
      <button type="submit" className="py-2.5 text-sm text-brick underline">
        Make a new link (the old one stops working)
      </button>
    </form>
  );
}
