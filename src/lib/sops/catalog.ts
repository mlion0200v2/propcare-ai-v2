/**
 * The SOP catalog, validated once at load. Plain JSON so Simone (or a
 * script) can edit SOPs without touching code.
 */
import raw from "./catalog.json";
import { CatalogSchema, type Sop } from "./schema";

let cached: Sop[] | null = null;

export function loadCatalog(): Sop[] {
  if (!cached) cached = CatalogSchema.parse(raw).sops;
  return cached;
}

export function sopByKey(issueKey: string): Sop | null {
  return loadCatalog().find((s) => s.issue_key === issueKey) ?? null;
}

/** Text an SOP is embedded and retrieved by (title, keywords, steps). */
export function sopText(sop: Sop): string {
  return [
    sop.title,
    `Keywords: ${sop.keywords.join(", ")}`,
    "Tenant-safe troubleshooting (do in order):",
    ...sop.tenant_steps.map((s, i) => `${i + 1}) ${s}`),
    "Stop and escalate immediately if:",
    ...sop.escalate_if.map((s) => `- ${s}`),
    "What to send us (photos/video):",
    ...sop.photos.map((s) => `- ${s}`),
  ].join("\n");
}
