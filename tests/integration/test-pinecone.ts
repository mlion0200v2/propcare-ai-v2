/**
 * Test 6: Pinecone Connection + Index Validation
 * Run:  npx tsx tests/integration/test-pinecone.ts
 */
import { Pinecone } from "@pinecone-database/pinecone";
import { createRunner, printSection, isExternalEnabled, runStandalone, type TestResult } from "./helpers";

export async function testPinecone(): Promise<TestResult> {
  printSection("Pinecone Connection");
  const { pass, fail, skip, result } = createRunner();

  if (!isExternalEnabled()) {
    skip("Pinecone tests", "RUN_EXTERNAL !== 1");
    return result;
  }

  const apiKey = process.env.PINECONE_API_KEY;
  const indexName = process.env.PINECONE_INDEX;

  if (!apiKey || !indexName) {
    skip("Pinecone tests", "missing PINECONE_API_KEY or PINECONE_INDEX");
    return result;
  }

  try {
    const pc = new Pinecone({ apiKey });

    // Verify index exists
    const indexList = await pc.listIndexes();
    const exists = indexList.indexes?.some((i) => i.name === indexName);

    if (!exists) {
      fail(`Index '${indexName}' not found`);
      const available = indexList.indexes?.map((i) => i.name).join(", ") || "none";
      console.log(`     Available: ${available}`);
      return result;
    }

    pass(`Index '${indexName}' exists`);

    // Verify dimensions match text-embedding-3-small
    const info = await pc.describeIndex(indexName);

    if (info.dimension === 1536) {
      pass(`Dimension: ${info.dimension} (matches text-embedding-3-small)`);
    } else {
      fail(`Dimension: ${info.dimension} (expected 1536)`);
    }

    pass(`Host: ${info.host}`);
    pass(`Metric: ${info.metric}`);

    // Verify index is queryable
    const index = pc.index(indexName);
    const stats = await index.describeIndexStats();
    pass(`Total vectors: ${stats.totalRecordCount ?? 0}`);
  } catch (e) {
    fail("Pinecone connection failed", e);
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-pinecone");
if (isMain) runStandalone(testPinecone);
