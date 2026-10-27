/**
 * Upload the SOP catalog (src/assistant/sops/catalog.json) to Pinecone.
 *
 *   npx tsx scripts/ingest_sops.ts --dry-run   # print what would be sent, no network
 *   npx tsx scripts/ingest_sops.ts             # embed + upsert, then remove stale records (uses .env.local keys)
 *
 * The namespace ends up holding exactly the catalog: every SOP is upserted
 * by id (written ones and the general one per equipment), then any record
 * the catalog no longer has (old seed files, renamed SOPs) is deleted and
 * listed. Metadata is flat (Pinecone filters on strings and string
 * lists): category, issue_key, severity, applies_to_* lists, intake slots,
 * plus the full SOP as JSON in `sop_json`. Retrieval keeps filtering on
 * `category`; the selector can also filter on applies_to_equipment etc.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { loadCatalog, sopText } from "../src/assistant/sops/catalog";
import type { Sop } from "../src/assistant/sops/schema";

export function sopRecordMetadata(sop: Sop) {
  return {
    category: sop.category,
    issue_key: sop.issue_key,
    severity: sop.severity,
    tenant_safe: sop.tenant_safe,
    source: "internal_sop",
    version: sop.version,
    selectable: sop.selectable,
    title: sop.title,
    text: sopText(sop),
    keywords: sop.keywords,
    applies_to_equipment: sop.applies_to.equipment,
    applies_to_symptoms: sop.applies_to.symptoms,
    applies_to_substances: sop.applies_to.substances,
    intake_slots: sop.intake_questions.map((q) => q.slot),
    escalate_if: sop.escalate_if,
    photos: sop.photos,
    sop_json: JSON.stringify(sop),
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sops = loadCatalog();
  if (dryRun) {
    const sizes = sops.map((s) => Buffer.byteLength(JSON.stringify(sopRecordMetadata(s))));
    console.log(`${sops.length} SOPs; largest metadata ${Math.max(...sizes)} bytes (Pinecone limit 40960)`);
    console.log(JSON.stringify({ id: sops[0].id, metadata: { ...sopRecordMetadata(sops[0]), sop_json: "…" } }, null, 2));
    return;
  }
  const { Pinecone } = await import("@pinecone-database/pinecone");
  const { default: OpenAI } = await import("openai");
  const index = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! }).index(process.env.PINECONE_INDEX!);
  const ns = index.namespace(process.env.PINECONE_NAMESPACE ?? "sop");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  let count = 0;
  for (let i = 0; i < sops.length; i += 50) {
    const chunk = sops.slice(i, i + 50);
    const embeddings = await openai.embeddings.create({ model: "text-embedding-3-small", input: chunk.map(sopText) });
    await ns.upsert({
      records: chunk.map((sop, j) => ({ id: sop.id, values: embeddings.data[j].embedding, metadata: sopRecordMetadata(sop) })),
    });
    count += chunk.length;
    console.log(`Upserted ${count}/${sops.length}`);
  }

  // Remove what the catalog no longer has, so retrieval never returns an old SOP.
  const keep = new Set(sops.map((s) => s.id));
  const stale: string[] = [];
  let token: string | undefined;
  do {
    const page = await ns.listPaginated({ limit: 100, paginationToken: token });
    for (const v of page.vectors ?? []) if (v.id && !keep.has(v.id)) stale.push(v.id);
    token = page.pagination?.next;
  } while (token);
  for (let i = 0; i < stale.length; i += 1000) await ns.deleteMany({ ids: stale.slice(i, i + 1000) });
  console.log(stale.length ? `Removed ${stale.length} stale record(s): ${stale.join(", ")}` : "No stale records.");
}

if (process.argv[1]?.replace(/\.ts$/, "").endsWith("ingest_sops")) main();
