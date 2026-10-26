/**
 * Upload the SOP catalog (src/assistant/sops/catalog.json) to Pinecone.
 *
 *   npx tsx scripts/ingest_sops.ts --dry-run   # print what would be sent, no network
 *   npx tsx scripts/ingest_sops.ts             # embed + upsert (uses .env.local keys)
 *
 * Same ids as the v1 seed files, so existing vectors are replaced, not
 * duplicated. Metadata is flat (Pinecone filters on strings and string
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
}

if (process.argv[1]?.replace(/\.ts$/, "").endsWith("ingest_sops")) main();
