import type { DiagnosisView } from "@/lib/sops/diagnosis-view";

const CONFIDENCE = { high: "High confidence", medium: "Medium confidence", low: "Low confidence (few answers)" } as const;

/**
 * "Diagnosis" block for the manager's ticket and the vendor's work order:
 * likely cause(s), evidence, model/serial, parts to bring, trade and time.
 * Never rendered on tenant pages.
 */
export function DiagnosisBlock({ view, audience }: { view: DiagnosisView; audience: "manager" | "vendor" }) {
  if (view.managerOnly) {
    return audience === "manager" ? (
      <section className="mt-4 border border-line bg-white p-4 text-sm">
        <h3 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Diagnosis</h3>
        <p className="mt-2">For you to handle ({view.procedure.toLowerCase()}); no trade visit suggested and the tenant wasn&apos;t given troubleshooting steps.</p>
      </section>
    ) : null;
  }
  return (
    <section className="mt-4 border border-line bg-white p-4 text-sm" aria-label="Diagnosis">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[1.5px] text-muted">Diagnosis</h3>
        <span className={view.confidence === "high" ? "text-pine" : view.confidence === "medium" ? "text-brass" : "text-muted"}>{CONFIDENCE[view.confidence]}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2.5fr)] gap-x-3 gap-y-2">
        {view.causes.length > 0 && (
          <>
            <dt className="text-muted">Likely cause</dt>
            <dd>
              {view.causes.map((c, i) => (
                <div key={c.label}>
                  {i > 0 ? "or " : ""}
                  {c.label}
                </div>
              ))}
            </dd>
          </>
        )}
        {view.evidence.length > 0 && (
          <>
            <dt className="text-muted">Evidence</dt>
            <dd>
              <ul className="list-disc pl-4">
                {view.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt className="text-muted">Model/serial</dt>
        <dd>{view.modelSerial ?? "Not captured"}</dd>
        {view.trade && (
          <>
            <dt className="text-muted">Trade</dt>
            <dd className="capitalize">
              {view.trade}
              {view.visit ? <span className="normal-case text-muted"> · about {view.visit}</span> : null}
            </dd>
          </>
        )}
        {view.parts.length > 0 && (
          <>
            <dt className="text-muted">Bring</dt>
            <dd>{view.parts.join(", ")}</dd>
          </>
        )}
        {view.identify.length > 0 && (
          <>
            <dt className="text-muted">{audience === "manager" ? "Ask the tenant for" : "Check on site"}</dt>
            <dd>{view.identify.join("; ")}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
