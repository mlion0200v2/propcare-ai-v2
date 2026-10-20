/** Mobile-first frame for tenant pages: workspace + address header. */
export function TenantShell({
  workspaceName,
  address,
  children,
}: {
  workspaceName: string;
  address: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#e1e8e2] font-brand text-ink sm:py-7">
      <div className="mx-auto flex min-h-screen max-w-[420px] flex-col border-line bg-paper sm:min-h-[calc(100vh-56px)] sm:border">
        <header className="bg-pine px-5 pt-5 pb-4 text-white">
          <p className="text-[11px] uppercase tracking-[1.5px] text-gold">{workspaceName}</p>
          <p className="mt-1.5 text-[15px]">{address}</p>
        </header>
        <div className="flex flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

export function EmergencyNotice() {
  return (
    <div className="bg-brick px-4 py-3.5 text-sm leading-normal text-white">
      <b>Smell gas, or a CO alarm going off?</b> Leave now. From outside, call FortisBC 1-800-663-9911 or 911.
    </div>
  );
}
