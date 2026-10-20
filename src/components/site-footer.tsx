/** "PropCare by Birchwood Management" with a link back to birchwoodcorp.com. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-paper px-4 py-4 font-brand text-xs text-muted print:hidden">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-display text-sm text-pine">PropCare</span> by{" "}
          <a href="https://birchwoodcorp.com" className="text-pine underline" target="_blank" rel="noopener">
            Birchwood Management
          </a>
        </p>
        <p>Emergencies: leave first, then call 911. Gas: FortisBC 1-800-663-9911.</p>
      </div>
    </footer>
  );
}
