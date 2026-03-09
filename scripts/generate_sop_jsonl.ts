import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

type SourceDoc = {
  version: string;
  source: string;
  items: Array<{
    id: string;
    title: string;
    category: string;
    issue_key: string;
    severity: "low" | "medium" | "high" | "emergency";
    tenant_safe: boolean;
    text: string;
  }>;
};

function oneLine(s: string) {
  return s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function main() {
  const inPath = process.argv[2] ?? "scripts/sop_seed_source.yaml";
  const outPath = process.argv[3] ?? "scripts/sop_seed.jsonl";

  const raw = fs.readFileSync(inPath, "utf8");
  const data = yaml.load(raw) as SourceDoc;

  if (!data?.items?.length) throw new Error("No items found in YAML.");

  const lines = data.items.map((it) => {
    const obj = {
      id: it.id,
      title: it.title,
      text: oneLine(it.text),
      metadata: {
        category: it.category,
        issue_key: it.issue_key,
        severity: it.severity,
        tenant_safe: it.tenant_safe,
        source: data.source ?? "internal_sop",
        version: data.version ?? "v1",
      },
    };
    return JSON.stringify(obj);
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

  console.log(`Wrote ${lines.length} JSONL rows to ${outPath}`);
}

main();